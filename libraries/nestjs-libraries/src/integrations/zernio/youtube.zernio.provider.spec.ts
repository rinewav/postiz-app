import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  YoutubeZernioProvider,
  resolveZernioMediaSource,
} from '@gitroom/nestjs-libraries/integrations/social/youtube.zernio.provider';
import { BadBody } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { ZernioApiError, ZernioClient, ZernioPost } from './zernio.client';

const uploadDir = mkdtempSync(join(tmpdir(), 'zernio-spec-'));
mkdirSync(join(uploadDir, '2026/09/18'), { recursive: true });
writeFileSync(join(uploadDir, '2026/09/18/video.mp4'), Buffer.alloc(1024, 1));
writeFileSync(join(uploadDir, '2026/09/18/thumb.png'), Buffer.alloc(64, 2));

process.env.FRONTEND_URL = 'http://localhost:4007';
process.env.UPLOAD_DIRECTORY = uploadDir;

const fakeClient = () => {
  let presigns = 0;
  return {
    presignMedia: jest.fn(async ({ filename }: any) => {
      presigns++;
      return {
        uploadUrl: `https://storage.test/put/${presigns}/${filename}`,
        publicUrl: `https://cdn.test/${presigns}/${filename}`,
      };
    }),
    uploadToPresignedUrl: jest.fn(async () => undefined),
    createPost: jest.fn(async () => ({
      post: { _id: 'zpost-1', status: 'publishing', platforms: [] } as any,
      status: 201,
    })),
    getPost: jest.fn(),
    retryPost: jest.fn(async () => undefined),
    resolveProfileId: jest.fn(async () => 'profile-1'),
    listAccounts: jest.fn(async () => [
      {
        _id: 'acc-1',
        platform: 'youtube',
        profileId: 'profile-1',
        username: '@chan',
        displayName: 'My Channel',
        profilePicture: 'https://img/1.png',
        followersCount: 42,
      },
    ]),
    getConnectUrl: jest.fn(async () => 'https://zernio.test/oauth'),
    listYoutubePlaylists: jest.fn(async () => [
      { id: 'PL1', title: 'Songs', privacy: 'public' },
      { id: 'PL2', title: 'Drafts' },
    ]),
    getYoutubeChannelInsights: jest.fn(async () => ({
      metrics: {
        views: {
          total: 30,
          values: [
            { date: '2026-09-01', value: 10 },
            { date: '2026-09-02', value: 20 },
          ],
        },
        averageViewDuration: {
          total: 42,
          values: [{ date: '2026-09-01', value: 42 }],
        },
      },
    })),
    getPostAnalytics: jest.fn(async () => ({
      syncStatus: 'synced',
      analytics: { views: 123, likes: 7, comments: 2, shares: 1 },
    })),
    listPostAnalytics: jest.fn(async () => [
      {
        _id: 'abcdefabcdefabcdefabcdef',
        platformPostUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      },
    ]),
  };
};

class TestProvider extends YoutubeZernioProvider {
  constructor(public client: ReturnType<typeof fakeClient>) {
    super();
  }
  protected override zernio() {
    return this.client as unknown as ZernioClient;
  }
}

const postDetails = (overrides: any = {}) => [
  {
    id: 'postiz-post-1',
    message: 'Video description',
    settings: {
      __type: 'youtube-zernio',
      title: 'My video',
      type: 'unlisted',
      selfDeclaredMadeForKids: 'no',
      tags: [{ value: 'music', label: 'music' }],
      thumbnail: {
        id: 't',
        path: 'http://localhost:4007/uploads/2026/09/18/thumb.png',
      },
      ...overrides,
    },
    media: [
      {
        type: 'video' as const,
        path: 'http://localhost:4007/uploads/2026/09/18/video.mp4',
      },
    ],
  },
];

const zernioPost = (platform: any, status = 'publishing'): ZernioPost => ({
  _id: 'zpost-1',
  status: status as any,
  platforms: [{ platform: 'youtube', accountId: 'acc-1', ...platform }],
});

const integration = {} as any;

describe('resolveZernioMediaSource', () => {
  it('maps the local-storage public URL to the upload directory', () => {
    expect(
      resolveZernioMediaSource(
        'http://localhost:4007/uploads/2026/09/18/video.mp4'
      )
    ).toEqual({ source: `${uploadDir}/2026/09/18/video.mp4`, local: true });
  });

  it('keeps remote URLs (e.g. R2) remote', () => {
    expect(resolveZernioMediaSource('https://cdn.example.com/v.mp4')).toEqual({
      source: 'https://cdn.example.com/v.mp4',
      local: false,
    });
  });
});

describe('YoutubeZernioProvider', () => {
  let client: ReturnType<typeof fakeClient>;
  let provider: TestProvider;

  beforeEach(() => {
    client = fakeClient();
    provider = new TestProvider(client);
  });

  describe('validation', () => {
    it('requires exactly one video', async () => {
      expect(await provider.checkValidity([[]])).toBe('You need one media');
      expect(await provider.checkValidity([[{ path: 'a.png' }]])).toBe(
        'Item must be a video'
      );
      expect(await provider.checkValidity([[{ path: 'a.mp4?x=1' }]])).toBe(
        true
      );
    });

    it('rejects a post without a video', async () => {
      const details = postDetails();
      details[0].media = [];
      await expect(
        provider.postPending('acc-1', 'profile-1', details, integration)
      ).rejects.toBeInstanceOf(BadBody);
    });
  });

  describe('account connection', () => {
    it('builds the Zernio connect URL back to the Postiz callback', async () => {
      const res = await provider.generateAuthUrl();
      const [platform, profileId, redirect] =
        client.getConnectUrl.mock.calls[0] as any;
      expect(platform).toBe('youtube');
      expect(profileId).toBe('profile-1');
      expect(redirect).toContain(
        'http://localhost:4007/integrations/social/youtube-zernio?state='
      );
      expect(redirect).toContain(`state=${res.state}`);
      expect(res.url).toBe('https://zernio.test/oauth');
    });

    it('authenticates without storing the API key', async () => {
      const auth: any = await provider.authenticate({
        code: 'x',
        codeVerifier: 'y',
      });
      expect(auth.accessToken).toBe('profile-1');
      expect(JSON.stringify(auth)).not.toContain('sk_');
    });

    it('returns a readable error for a bad API key', async () => {
      client.resolveProfileId.mockRejectedValueOnce(
        new ZernioApiError('Zernio API 401', 401)
      );
      expect(await provider.authenticate({ code: '', codeVerifier: '' })).toBe(
        'Invalid Zernio API key'
      );
    });

    it('lists Zernio YouTube accounts in the channel picker shape', async () => {
      const pages = await provider.pages('profile-1');
      expect(client.listAccounts).toHaveBeenCalledWith({
        platform: 'youtube',
        profileId: 'profile-1',
      });
      expect(pages).toEqual([
        {
          id: 'acc-1',
          name: 'My Channel',
          picture: { data: { url: 'https://img/1.png' } },
          username: '@chan',
          subscriberCount: '42',
        },
      ]);
      const info = await provider.fetchPageInformation('profile-1', {
        id: 'acc-1',
      });
      expect(info.id).toBe('acc-1');
      await expect(
        provider.fetchPageInformation('profile-1', { id: 'nope' })
      ).rejects.toThrow('not found');
    });
  });

  describe('publishing', () => {
    const start = async () => {
      const [res] = await provider.postPending(
        'acc-1',
        'profile-1',
        postDetails(),
        integration
      );
      return res;
    };

    it('upload -> create -> poll -> completed', async () => {
      const pending = await start();
      expect(pending.status).toBe('pending');
      expect(client.presignMedia).toHaveBeenCalledTimes(2);
      expect(client.createPost).not.toHaveBeenCalled();

      // nothing on Zernio yet -> ready
      const check1 = await provider.checkPostStatus(
        'profile-1',
        pending.pendingData,
        integration
      );
      expect(check1.status).toBe('ready');

      const fin = await provider.finalizePost(
        'profile-1',
        (check1 as any).pendingData,
        integration
      );
      expect(fin.status).toBe('pending');
      expect(client.uploadToPresignedUrl).toHaveBeenCalledTimes(2);
      const [uploadUrl, , contentType, size] =
        client.uploadToPresignedUrl.mock.calls[0] as any;
      expect(uploadUrl).toContain('video.mp4');
      expect(contentType).toBe('video/mp4');
      expect(size).toBe(1024);

      const [body, requestId] = client.createPost.mock.calls[0] as any;
      expect(requestId).toBe(pending.pendingData.requestId);
      expect(body).toMatchObject({
        content: 'Video description',
        publishNow: true,
        tags: ['music'],
        mediaItems: [
          {
            type: 'video',
            url: 'https://cdn.test/1/video.mp4',
            thumbnail: 'https://cdn.test/2/thumb.png',
          },
        ],
        platforms: [
          {
            platform: 'youtube',
            accountId: 'acc-1',
            platformSpecificData: {
              title: 'My video',
              visibility: 'unlisted',
              madeForKids: false,
            },
          },
        ],
      });

      const pd = (fin as any).pendingData;
      expect(pd.zernioPostId).toBe('zpost-1');

      client.getPost.mockResolvedValueOnce(zernioPost({ status: 'uploading' }));
      expect(
        (await provider.checkPostStatus('profile-1', pd, integration)).status
      ).toBe('pending');

      client.getPost.mockResolvedValueOnce(
        zernioPost(
          {
            status: 'published',
            platformPostId: 'dQw4w9WgXcQ',
            platformPostUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          },
          'published'
        )
      );
      expect(
        await provider.checkPostStatus('profile-1', pd, integration)
      ).toEqual({
        status: 'completed',
        // the Zernio post id, so post analytics can be looked up later
        postId: 'zpost-1',
        releaseURL: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      });
    });

    it('sends the Zernio-only settings when they are set', async () => {
      const [pending] = await provider.postPending(
        'acc-1',
        'profile-1',
        postDetails({
          categoryId: '10',
          playlistId: 'PL1',
          containsSyntheticMedia: true,
          firstComment: '  Thanks for watching!  ',
        }),
        integration
      );
      await provider.finalizePost('profile-1', pending.pendingData, integration);
      const [body] = client.createPost.mock.calls[0] as any;
      expect(body.platforms[0].platformSpecificData).toEqual({
        title: 'My video',
        visibility: 'unlisted',
        madeForKids: false,
        categoryId: '10',
        playlistId: 'PL1',
        containsSyntheticMedia: true,
        firstComment: 'Thanks for watching!',
      });
    });

    it('omits unset optional settings (Zernio defaults apply)', async () => {
      const [pending] = await provider.postPending(
        'acc-1',
        'profile-1',
        postDetails({
          categoryId: '',
          playlistId: '',
          containsSyntheticMedia: false,
          firstComment: '   ',
        }),
        integration
      );
      await provider.finalizePost('profile-1', pending.pendingData, integration);
      const [body] = client.createPost.mock.calls[0] as any;
      expect(Object.keys(body.platforms[0].platformSpecificData).sort()).toEqual(
        ['madeForKids', 'title', 'visibility']
      );
    });

    it('adopts the existing post on a 409 duplicate (crash recovery)', async () => {
      const pending = await start();
      client.createPost.mockResolvedValueOnce({
        duplicateOf: 'zpost-old',
        status: 409,
      } as any);
      const fin: any = await provider.finalizePost(
        'profile-1',
        pending.pendingData,
        integration
      );
      expect(fin.pendingData.zernioPostId).toBe('zpost-old');
    });

    it('does not create twice once the Zernio post exists', async () => {
      const pending = await start();
      const fin: any = await provider.finalizePost(
        'profile-1',
        pending.pendingData,
        integration
      );
      await provider.finalizePost('profile-1', fin.pendingData, integration);
      expect(client.createPost).toHaveBeenCalledTimes(1);
    });

    it('rethrows transient Zernio errors as plain errors (workflow retries)', async () => {
      const pending = await start();
      client.createPost.mockRejectedValueOnce(
        new ZernioApiError('Zernio API 503', 503)
      );
      const err = await provider
        .finalizePost('profile-1', pending.pendingData, integration)
        .catch((e) => e);
      expect(err).not.toBeInstanceOf(BadBody);
      expect(err.message).toContain('503');
    });

    it('fails permanently on a validation error', async () => {
      const pending = await start();
      client.createPost.mockRejectedValueOnce(
        new ZernioApiError('Zernio API 400: title too long', 400, {
          error: 'title too long',
        })
      );
      await expect(
        provider.finalizePost('profile-1', pending.pendingData, integration)
      ).rejects.toBeInstanceOf(BadBody);
    });

    it('retries a transient Zernio failure, then gives up', async () => {
      process.env.ZERNIO_MAX_RETRIES = '1';
      const pending = await start();
      const fin: any = await provider.finalizePost(
        'profile-1',
        pending.pendingData,
        integration
      );
      const failed = zernioPost(
        {
          status: 'failed',
          errorMessage: 'YouTube backend error',
          errorCategory: 'platform_error',
          errorSource: 'platform',
        },
        'failed'
      );

      client.getPost.mockResolvedValueOnce(failed);
      const check: any = await provider.checkPostStatus(
        'profile-1',
        fin.pendingData,
        integration
      );
      expect(check.status).toBe('ready');
      expect(check.pendingData.retryRequested).toBe(true);

      client.getPost.mockResolvedValueOnce(failed);
      const retried: any = await provider.finalizePost(
        'profile-1',
        check.pendingData,
        integration
      );
      expect(client.retryPost).toHaveBeenCalledWith('zpost-1');
      expect(retried.pendingData.retries).toBe(1);

      client.getPost.mockResolvedValueOnce(failed);
      const err = await provider
        .checkPostStatus('profile-1', retried.pendingData, integration)
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadBody);
      expect(err.message).toContain('YouTube backend error');
      delete process.env.ZERNIO_MAX_RETRIES;
    });

    it('does not retry again when a previous retry already went through', async () => {
      const pending = await start();
      const fin: any = await provider.finalizePost(
        'profile-1',
        pending.pendingData,
        integration
      );
      client.getPost.mockResolvedValueOnce(
        zernioPost({ status: 'uploading' }, 'publishing')
      );
      const res: any = await provider.finalizePost(
        'profile-1',
        { ...fin.pendingData, retryRequested: true },
        integration
      );
      expect(client.retryPost).not.toHaveBeenCalled();
      expect(res.status).toBe('pending');
      expect(res.pendingData.retryRequested).toBe(false);
    });

    it('does not retry user errors', async () => {
      const pending = await start();
      const fin: any = await provider.finalizePost(
        'profile-1',
        pending.pendingData,
        integration
      );
      client.getPost.mockResolvedValueOnce(
        zernioPost(
          {
            status: 'failed',
            errorMessage: 'Video too long for unverified channel',
            errorCategory: 'user_content',
            errorSource: 'user',
          },
          'failed'
        )
      );
      await expect(
        provider.checkPostStatus('profile-1', fin.pendingData, integration)
      ).rejects.toBeInstanceOf(BadBody);
    });

    it('keeps polling on a transient status read error', async () => {
      const pending = await start();
      const fin: any = await provider.finalizePost(
        'profile-1',
        pending.pendingData,
        integration
      );
      client.getPost.mockRejectedValueOnce(new ZernioApiError('timeout', 0));
      expect(
        (await provider.checkPostStatus('profile-1', fin.pendingData, integration))
          .status
      ).toBe('pending');
    });

    it('maps a 401 to a clear API key message', async () => {
      client.presignMedia.mockRejectedValueOnce(
        new ZernioApiError('Zernio API 401: Unauthorized', 401)
      );
      const err = await provider
        .postPending('acc-1', 'profile-1', postDetails(), integration)
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadBody);
      expect(err.message).toContain('ZERNIO_API_KEY');
    });
  });

  describe('playlists', () => {
    it('lists the channel playlists for the settings picker', async () => {
      expect(await provider.playlists('profile-1', {}, 'acc-1')).toEqual([
        { id: 'PL1', name: 'Songs (public)' },
        { id: 'PL2', name: 'Drafts' },
      ]);
      expect(client.listYoutubePlaylists).toHaveBeenCalledWith('acc-1');
    });
  });

  describe('analytics', () => {
    it('maps channel insights to Postiz analytics', async () => {
      const data: any = await provider.analytics('acc-1', 'profile-1', 30);
      const [{ accountId, metrics, since, until }] =
        client.getYoutubeChannelInsights.mock.calls[0] as any;
      expect(accountId).toBe('acc-1');
      expect(metrics).toContain('views');
      expect(since < until).toBe(true);
      expect(data).toEqual([
        {
          label: 'Views',
          percentageChange: 0,
          data: [
            { total: 10, date: '2026-09-01' },
            { total: 20, date: '2026-09-02' },
          ],
        },
        {
          label: 'Average View Duration',
          percentageChange: 0,
          average: true,
          data: [{ total: 42, date: '2026-09-01' }],
        },
      ]);
    });

    it('clamps the range to the 89 days Zernio serves', async () => {
      await provider.analytics('acc-1', 'profile-1', 90);
      const [{ since, until }] =
        client.getYoutubeChannelInsights.mock.calls[0] as any;
      const days =
        (new Date(until).getTime() - new Date(since).getTime()) / 86400000;
      expect(days).toBe(89);
    });

    it('returns no data when Zernio refuses (e.g. 412 missing scope)', async () => {
      client.getYoutubeChannelInsights.mockRejectedValueOnce(
        new ZernioApiError('Zernio API 412', 412)
      );
      expect(await provider.analytics('acc-1', 'profile-1', 7)).toEqual([]);
    });

    it('reads post analytics by Zernio post id', async () => {
      const data = await provider.postAnalytics(
        'acc-1',
        'profile-1',
        'aaaaaaaaaaaaaaaaaaaaaaaa',
        7
      );
      expect(client.getPostAnalytics).toHaveBeenCalledWith(
        'aaaaaaaaaaaaaaaaaaaaaaaa'
      );
      expect(client.listPostAnalytics).not.toHaveBeenCalled();
      expect(data.map((d) => [d.label, d.data[0].total])).toEqual([
        ['Views', '123'],
        ['Likes', '7'],
        ['Comments', '2'],
        ['Shares', '1'],
      ]);
    });

    it('resolves a legacy YouTube video id to its Zernio post', async () => {
      await provider.postAnalytics('acc-1', 'profile-1', 'dQw4w9WgXcQ', 7);
      expect(client.getPostAnalytics).toHaveBeenCalledWith(
        'abcdefabcdefabcdefabcdef'
      );
    });

    it('pages through Zernio posts to resolve an old video id', async () => {
      const filler = Array.from({ length: 100 }, (_, i) => ({
        _id: `id${i}`,
        platformPostUrl: `https://www.youtube.com/watch?v=other${i}`,
      }));
      client.listPostAnalytics
        .mockResolvedValueOnce(filler as any)
        .mockResolvedValueOnce([
          {
            _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
            platformPostUrl: 'https://www.youtube.com/watch?v=oldVideo123',
          },
        ] as any);
      await provider.postAnalytics('acc-1', 'profile-1', 'oldVideo123', 7);
      expect(client.listPostAnalytics).toHaveBeenCalledTimes(2);
      expect((client.listPostAnalytics.mock.calls[1] as any)[0].page).toBe(2);
      expect(client.getPostAnalytics).toHaveBeenCalledWith(
        'bbbbbbbbbbbbbbbbbbbbbbbb'
      );
    });

    it('returns no data while Zernio is still syncing', async () => {
      client.getPostAnalytics.mockResolvedValueOnce({
        syncStatus: 'pending',
      } as any);
      expect(
        await provider.postAnalytics(
          'acc-1',
          'profile-1',
          'aaaaaaaaaaaaaaaaaaaaaaaa',
          7
        )
      ).toEqual([]);
    });
  });
});
