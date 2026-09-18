import { ZernioApiError, ZernioClient } from './zernio.client';

const API_KEY = 'sk_' + 'a'.repeat(64);

type Call = { url: string; init: any };

const mockFetch = (
  responses: Array<{ status: number; body?: any; text?: string }>
) => {
  const calls: Call[] = [];
  const fn = jest.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 200, body: {} };
    const text =
      next.text ?? (next.body !== undefined ? JSON.stringify(next.body) : '');
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: String(next.status),
      text: async () => text,
    } as any;
  });
  return { fn: fn as unknown as typeof fetch, calls };
};

const client = (fetchImpl: typeof fetch, apiKey = API_KEY) =>
  new ZernioClient({ apiKey, baseUrl: 'https://zernio.test/api', fetchImpl });

describe('ZernioClient', () => {
  afterEach(() => {
    delete process.env.ZERNIO_PROFILE_ID;
  });

  describe('authentication', () => {
    it('sends the API key as a Bearer token, never in the URL', async () => {
      const { fn, calls } = mockFetch([{ status: 200, body: { profiles: [] } }]);
      await client(fn).listProfiles();

      expect(calls[0].url).toBe('https://zernio.test/api/v1/profiles');
      expect(calls[0].url).not.toContain(API_KEY);
      expect(calls[0].init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    });

    it('fails fast without calling Zernio when no key is configured', async () => {
      const { fn } = mockFetch([]);
      await expect(client(fn, '').listProfiles()).rejects.toThrow(
        'ZERNIO_API_KEY is not set'
      );
      expect(fn).not.toHaveBeenCalled();
    });

    it('surfaces a 401 as ZernioApiError with the status', async () => {
      const { fn } = mockFetch([
        { status: 401, body: { error: 'Invalid API key' } },
      ]);
      const err = await client(fn)
        .listProfiles()
        .catch((e) => e);
      expect(err).toBeInstanceOf(ZernioApiError);
      expect(err.status).toBe(401);
      expect(err.message).toContain('Invalid API key');
    });
  });

  describe('error handling', () => {
    it('scrubs the API key from error messages and bodies', async () => {
      const { fn } = mockFetch([
        {
          status: 400,
          body: { error: `bad key ${API_KEY}`, details: { key: API_KEY } },
        },
      ]);
      const err: ZernioApiError = await client(fn)
        .listAccounts()
        .catch((e) => e);
      expect(err.message).not.toContain(API_KEY);
      expect(JSON.stringify(err.body)).not.toContain(API_KEY);
      expect(err.message).toContain('[REDACTED]');
    });

    it('exposes Zernio error codes', async () => {
      const { fn } = mockFetch([
        {
          status: 403,
          body: { error: 'Account disconnected', code: 'ACCOUNT_DISCONNECTED' },
        },
      ]);
      const err: ZernioApiError = await client(fn)
        .getPost('p1')
        .catch((e) => e);
      expect(err.status).toBe(403);
      expect(err.code).toBe('ACCOUNT_DISCONNECTED');
    });

    it('turns network failures into status 0 errors', async () => {
      const fn = jest.fn(async () => {
        throw new Error(`socket hang up ${API_KEY}`);
      }) as unknown as typeof fetch;
      const err: ZernioApiError = await client(fn)
        .getPost('p1')
        .catch((e) => e);
      expect(err.status).toBe(0);
      expect(err.message).not.toContain(API_KEY);
    });

    it('handles non-JSON error bodies', async () => {
      const { fn } = mockFetch([{ status: 502, text: '<html>Bad gateway</html>' }]);
      const err: ZernioApiError = await client(fn)
        .getPost('p1')
        .catch((e) => e);
      expect(err.status).toBe(502);
    });
  });

  describe('requests and response parsing', () => {
    it('resolves the default profile, or ZERNIO_PROFILE_ID when set', async () => {
      const { fn } = mockFetch([
        {
          status: 200,
          body: {
            profiles: [
              { _id: 'p1', name: 'A' },
              { _id: 'p2', name: 'B', isDefault: true },
            ],
          },
        },
      ]);
      expect(await client(fn).resolveProfileId()).toBe('p2');

      process.env.ZERNIO_PROFILE_ID = 'env-profile';
      const other = mockFetch([]);
      expect(await client(other.fn).resolveProfileId()).toBe('env-profile');
      expect(other.fn).not.toHaveBeenCalled();
    });

    it('lists accounts with query filters', async () => {
      const { fn, calls } = mockFetch([
        {
          status: 200,
          body: {
            accounts: [{ _id: 'a1', platform: 'youtube', username: 'chan' }],
          },
        },
      ]);
      const accounts = await client(fn).listAccounts({
        platform: 'youtube',
        profileId: 'p1',
      });
      expect(new URL(calls[0].url).searchParams.get('platform')).toBe('youtube');
      expect(new URL(calls[0].url).searchParams.get('profileId')).toBe('p1');
      expect(accounts[0]._id).toBe('a1');
    });

    it('requests a hosted connect URL for youtube', async () => {
      const { fn, calls } = mockFetch([
        { status: 200, body: { authUrl: 'https://accounts.google.com/x' } },
      ]);
      const url = await client(fn).getConnectUrl(
        'youtube',
        'p1',
        'http://localhost:4007/integrations/social/youtube-zernio?state=s&code=c'
      );
      const called = new URL(calls[0].url);
      expect(called.pathname).toBe('/api/v1/connect/youtube');
      expect(called.searchParams.get('redirect_url')).toContain(
        'state=s&code=c'
      );
      expect(url).toBe('https://accounts.google.com/x');
    });

    it('presigns media', async () => {
      const { fn, calls } = mockFetch([
        {
          status: 200,
          body: { uploadUrl: 'https://up', publicUrl: 'https://pub', key: 'k' },
        },
      ]);
      const res = await client(fn).presignMedia({
        filename: 'v.mp4',
        contentType: 'video/mp4',
      });
      expect(calls[0].init.method).toBe('POST');
      expect(JSON.parse(calls[0].init.body)).toEqual({
        filename: 'v.mp4',
        contentType: 'video/mp4',
      });
      expect(res.publicUrl).toBe('https://pub');
    });

    it('uploads to the presigned URL without the API key', async () => {
      const { fn, calls } = mockFetch([{ status: 200 }]);
      await client(fn).uploadToPresignedUrl(
        'https://storage/put',
        Buffer.from('abc'),
        'video/mp4',
        3
      );
      expect(calls[0].init.method).toBe('PUT');
      expect(calls[0].init.headers.Authorization).toBeUndefined();
      expect(calls[0].init.headers['Content-Length']).toBe('3');
    });

    it('creates a post with the idempotency key', async () => {
      const { fn, calls } = mockFetch([
        { status: 201, body: { post: { _id: 'z1', status: 'publishing' } } },
      ]);
      const res = await client(fn).createPost(
        { platforms: [{ platform: 'youtube', accountId: 'a1' }], publishNow: true },
        'req-1'
      );
      expect(calls[0].init.headers['x-request-id']).toBe('req-1');
      expect(res.post?._id).toBe('z1');
    });

    it('returns the original post for an idempotent replay (existingPost)', async () => {
      const { fn } = mockFetch([
        { status: 200, body: { existingPost: { _id: 'z1', status: 'published' } } },
      ]);
      const res = await client(fn).createPost(
        { platforms: [{ platform: 'youtube', accountId: 'a1' }] },
        'req-1'
      );
      expect(res.post?._id).toBe('z1');
    });

    it('returns the existing post id on a 409 duplicate', async () => {
      const { fn } = mockFetch([
        {
          status: 409,
          body: { error: 'dup', details: { existingPostId: 'z-old' } },
        },
      ]);
      const res = await client(fn).createPost(
        { platforms: [{ platform: 'youtube', accountId: 'a1' }] },
        'req-2'
      );
      expect(res.duplicateOf).toBe('z-old');
    });

    it('accepts 207 (inline publish incomplete) and returns the post', async () => {
      const { fn } = mockFetch([
        { status: 207, body: { post: { _id: 'z1', status: 'failed' } } },
      ]);
      const res = await client(fn).createPost(
        { platforms: [{ platform: 'youtube', accountId: 'a1' }] },
        'req-3'
      );
      expect(res.post?.status).toBe('failed');
    });

    it('treats a 409 on retry as already publishing', async () => {
      const { fn, calls } = mockFetch([
        { status: 409, body: { error: 'Post is currently publishing' } },
      ]);
      await expect(client(fn).retryPost('z1')).resolves.toBeUndefined();
      expect(calls[0].url).toBe('https://zernio.test/api/v1/posts/z1/retry');
    });
  });
});
