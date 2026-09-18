import {
  AnalyticsData,
  AuthTokenDetails,
  PendingCheckResponse,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { Integration } from '@prisma/client';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { YoutubeZernioSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/youtube.zernio.settings.dto';
import {
  BadBody,
  SocialAbstract,
  ValidityMedia,
  stripQuery,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import { Tool } from '@gitroom/nestjs-libraries/integrations/tool.decorator';
import { setHeartbeatDetails } from '@gitroom/nestjs-libraries/temporal/temporal.heartbeat';
import { getSsrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import {
  ZernioAccount,
  ZernioApiError,
  ZernioClient,
  ZernioPost,
} from '@gitroom/nestjs-libraries/integrations/zernio/zernio.client';
import { createReadStream, statSync } from 'fs';
import { randomUUID } from 'crypto';
import { extname, basename } from 'path';
import dayjs from 'dayjs';

const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.avi': 'video/x-msvideo',
};

const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
};

// Zernio error categories that are worth one more publish attempt
const RETRYABLE_CATEGORIES = [
  'platform_error',
  'platform_rate_limit',
  'system_error',
  'unknown',
];

type ZernioMediaUpload = {
  source: string;
  local: boolean;
  contentType: string;
  filename: string;
  uploadUrl?: string;
  publicUrl?: string;
  presignedAt?: number;
  uploaded?: boolean;
};

type ZernioPendingData = {
  requestId: string;
  accountId: string;
  content: string;
  title: string;
  visibility: 'public' | 'private' | 'unlisted';
  madeForKids: boolean;
  tags: string[];
  // optional: absent in posts that were scheduled before these settings existed
  categoryId?: string;
  playlistId?: string;
  containsSyntheticMedia?: boolean;
  firstComment?: string;
  video: ZernioMediaUpload;
  thumbnail?: ZernioMediaUpload;
  zernioPostId?: string;
  retries: number;
  retryRequested?: boolean;
};

// Resolves a Postiz media path to something we can stream from. With local
// storage the path is the public URL (FRONTEND_URL/uploads/...), which is not
// reachable from inside the container (and blocked by the SSRF guard), so it
// is mapped back to the file in UPLOAD_DIRECTORY.
export const resolveZernioMediaSource = (
  path: string
): { source: string; local: boolean } => {
  const publicPrefix = `${process.env.FRONTEND_URL}/uploads`;
  if (
    process.env.UPLOAD_DIRECTORY &&
    process.env.FRONTEND_URL &&
    path.startsWith(publicPrefix)
  ) {
    return {
      source:
        process.env.UPLOAD_DIRECTORY +
        decodeURIComponent(stripQuery(path).slice(publicPrefix.length)),
      local: true,
    };
  }
  if (path.indexOf('http') === 0) {
    return { source: path, local: false };
  }
  return { source: path, local: true };
};

const mediaUpload = (
  path: string,
  types: Record<string, string>
): ZernioMediaUpload | undefined => {
  const { source, local } = resolveZernioMediaSource(path);
  const ext = extname(stripQuery(source)).toLowerCase();
  const contentType = types[ext];
  if (!contentType) {
    return undefined;
  }
  return {
    source,
    local,
    contentType,
    filename: basename(stripQuery(source)) || `media${ext}`,
  };
};

@Rules(
  'YouTube (Zernio) must have exactly one video attachment, it cannot be empty'
)
export class YoutubeZernioProvider
  extends SocialAbstract
  implements SocialProvider
{
  override maxConcurrentJob = 50;
  identifier = 'youtube-zernio';
  name = 'YouTube (Zernio)';
  toolTip = 'Publishes to YouTube through the Zernio API (ZERNIO_API_KEY)';
  isBetweenSteps = true;
  dto = YoutubeZernioSettingsDto;
  scopes = [] as string[];
  editor = 'normal' as const;

  maxLength() {
    return 5000;
  }

  protected zernio() {
    return new ZernioClient();
  }

  // Maps a Zernio client error to the failure types the post workflow knows.
  // Everything becomes a BadBody: a Postiz token refresh can't fix a Zernio
  // API key or a YouTube account that has to be reconnected in Zernio.
  private toBadBody(err: unknown, fallback: string): never {
    if (err instanceof BadBody) {
      throw err;
    }
    if (err instanceof ZernioApiError) {
      let message = err.message;
      if (err.status === 401) {
        message =
          'Zernio rejected the API key, check ZERNIO_API_KEY on the Postiz server';
      } else if (err.code === 'ACCOUNT_DISCONNECTED') {
        message =
          'The YouTube account is disconnected in Zernio, please reconnect the channel';
      }
      throw new BadBody(
        this.identifier,
        JSON.stringify(err.body || {}),
        '{}',
        message
      );
    }
    throw new BadBody(
      this.identifier,
      '{}',
      '{}',
      (err as any)?.message || fallback
    );
  }

  override async checkValidity(
    items: Array<ValidityMedia[]>
  ): Promise<string | true> {
    const [firstItems] = items ?? [];
    if (firstItems?.length !== 1) {
      return 'You need one media';
    }
    const ext = extname(stripQuery(firstItems[0]?.path || '')).toLowerCase();
    if (!VIDEO_TYPES[ext]) {
      return 'Item must be a video';
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Channel connection: Zernio's hosted OAuth flow connects the YouTube channel
  // to Zernio (no Google Cloud project of our own), then redirects back to the
  // regular Postiz callback, where the user picks the channel to add.
  // ---------------------------------------------------------------------------

  async generateAuthUrl() {
    const state = makeId(7);
    const codeVerifier = makeId(11);
    const client = this.zernio();
    const profileId = await client.resolveProfileId();
    const redirectUrl = `${process.env.FRONTEND_URL}/integrations/social/${
      this.identifier
    }?state=${state}&code=${makeId(10)}`;
    return {
      url: await client.getConnectUrl('youtube', profileId, redirectUrl),
      codeVerifier,
      state,
    };
  }

  // The "token" of this integration is the Zernio profile id: the API key
  // itself stays in the ZERNIO_API_KEY environment variable and never reaches
  // the database.
  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }): Promise<AuthTokenDetails | string> {
    try {
      const profileId = await this.zernio().resolveProfileId();
      return {
        id: `zernio-${profileId}`,
        name: 'YouTube (Zernio)',
        accessToken: profileId,
        refreshToken: profileId,
        expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
        picture: '',
        username: '',
      };
    } catch (err) {
      return err instanceof ZernioApiError && err.status === 401
        ? 'Invalid Zernio API key'
        : 'Could not reach Zernio, check ZERNIO_API_KEY';
    }
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    return {
      id: '',
      name: '',
      accessToken: refreshToken,
      refreshToken,
      expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
      picture: '',
      username: '',
    };
  }

  private async youtubeAccounts(profileId: string): Promise<ZernioAccount[]> {
    const client = this.zernio();
    const accounts = await client.listAccounts({
      platform: 'youtube',
      ...(profileId ? { profileId } : {}),
    });
    return accounts.filter((a) => a.platform === 'youtube');
  }

  // Same shape as the YouTube provider, so the existing channel picker is reused
  async pages(accessToken: string) {
    const accounts = await this.youtubeAccounts(accessToken);
    return accounts.map((account) => ({
      id: account._id,
      name: account.displayName || account.username || 'YouTube channel',
      picture: { data: { url: account.profilePicture || '' } },
      username: account.username || '',
      subscriberCount: String(account.followersCount ?? ''),
    }));
  }

  async fetchPageInformation(accessToken: string, data: { id: string }) {
    const account = (await this.youtubeAccounts(accessToken)).find(
      (a) => a._id === data.id
    );
    if (!account) {
      throw new Error('YouTube channel not found in Zernio');
    }
    return {
      id: account._id,
      name: account.displayName || account.username || 'YouTube channel',
      access_token: accessToken,
      picture: account.profilePicture || '',
      username: account.username || '',
    };
  }

  async reConnect(
    id: string,
    requiredId: string,
    accessToken: string
  ): Promise<Omit<AuthTokenDetails, 'refreshToken' | 'expiresIn'>> {
    const information = await this.fetchPageInformation(accessToken, {
      id: requiredId,
    });
    return {
      id: information.id,
      name: information.name,
      accessToken: information.access_token,
      picture: information.picture,
      username: information.username,
    };
  }

  // Playlist picker of the post settings (called through /integrations/function)
  @Tool({ description: 'List of YouTube playlists', dataSchema: [] })
  async playlists(
    token: string,
    data: any,
    internalId: string
  ): Promise<{ id: string; name: string }[]> {
    const playlists = await this.zernio().listYoutubePlaylists(internalId);
    return playlists.map((p) => ({
      id: p.id,
      name: p.privacy ? `${p.title} (${p.privacy})` : p.title,
    }));
  }

  // ---------------------------------------------------------------------------
  // Analytics, through Zernio's YouTube Analytics endpoints. Errors (missing
  // yt-analytics scope = 412, legacy plan without analytics = 402, ...) return
  // no data, like the other providers.
  // ---------------------------------------------------------------------------

  async analytics(
    id: string,
    accessToken: string,
    date: number
  ): Promise<AnalyticsData[]> {
    // Zernio serves at most 89 days of channel insights
    const days = Math.min(Math.max(Number(date) || 7, 1), 89);
    try {
      const insights = await this.zernio().getYoutubeChannelInsights({
        accountId: id,
        since: dayjs().subtract(days, 'day').format('YYYY-MM-DD'),
        until: dayjs().format('YYYY-MM-DD'),
        metrics: [
          'views',
          'estimatedMinutesWatched',
          'averageViewDuration',
          'subscribersGained',
          'subscribersLost',
        ],
      });

      const labels: Array<[string, string, boolean]> = [
        ['views', 'Views', false],
        ['estimatedMinutesWatched', 'Estimated Minutes Watched', false],
        ['averageViewDuration', 'Average View Duration', true],
        ['subscribersGained', 'Subscribers Gained', false],
        ['subscribersLost', 'Subscribers Lost', false],
      ];

      return labels
        .filter(([key]) => insights.metrics?.[key]?.values?.length)
        .map(([key, label, average]) => ({
          label,
          percentageChange: 0,
          ...(average ? { average: true } : {}),
          // numbers, like the YouTube provider: the analytics page sums them
          data: insights.metrics[key].values!.map((v) => ({
            total: Number(v.value) as any,
            date: v.date,
          })),
        }));
    } catch (err) {
      console.error('YouTube (Zernio) analytics failed:', (err as any)?.message);
      return [];
    }
  }

  // Posts published by this provider store the Zernio post id as the release
  // id. Older ones stored the YouTube video id: resolve it through the
  // account's Zernio posts.
  private async resolveZernioPostId(
    accountId: string,
    releaseId: string
  ): Promise<string | undefined> {
    if (/^[a-f0-9]{24}$/i.test(releaseId)) {
      return releaseId;
    }
    // Zernio keeps at most 366 days of post analytics; walk its pages
    const fromDate = dayjs().subtract(365, 'day').format('YYYY-MM-DD');
    for (let page = 1; page <= 20; page++) {
      const posts = await this.zernio().listPostAnalytics({
        accountId,
        platform: 'youtube',
        fromDate,
        limit: 100,
        page,
      });
      const found = posts.find((p) => p.platformPostUrl?.includes(releaseId));
      if (found?._id) {
        return found._id;
      }
      if (posts.length < 100) {
        break;
      }
    }
    console.log(`YouTube (Zernio): no Zernio post found for video ${releaseId}`);
    return undefined;
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const today = dayjs().format('YYYY-MM-DD');
    try {
      const zernioPostId = await this.resolveZernioPostId(integrationId, postId);
      if (!zernioPostId) {
        return [];
      }
      const result = await this.zernio().getPostAnalytics(zernioPostId);
      if (result.syncStatus === 'pending' || !result.analytics) {
        return [];
      }
      const { views, likes, comments, shares } = result.analytics;
      return (
        [
          ['Views', views],
          ['Likes', likes],
          ['Comments', comments],
          ['Shares', shares],
        ] as Array<[string, number | undefined]>
      )
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([label, value]) => ({
          label,
          percentageChange: 0,
          data: [{ total: String(value), date: today }],
        }));
    } catch (err) {
      console.error(
        'YouTube (Zernio) post analytics failed:',
        (err as any)?.message
      );
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Publishing. The Postiz workflow calls postPending at the scheduled time:
  //   postPending    - validate + presign the uploads (nothing irreversible)
  //   checkPostStatus - read-only: 'ready' until the Zernio post exists, then
  //                    polls it until YouTube reports published / failed
  //   finalizePost   - upload the bytes, create the Zernio post (idempotent via
  //                    x-request-id + Zernio's 24h content dedup), or retry a
  //                    failed Zernio post
  // ---------------------------------------------------------------------------

  async post(): Promise<PostResponse[]> {
    throw new BadBody(
      this.identifier,
      '{}',
      '{}',
      'YouTube (Zernio) only supports postPending'
    );
  }

  private async presign(media: ZernioMediaUpload): Promise<ZernioMediaUpload> {
    const { uploadUrl, publicUrl } = await this.zernio().presignMedia({
      filename: media.filename,
      contentType: media.contentType,
    });
    return {
      ...media,
      uploadUrl,
      publicUrl,
      presignedAt: Date.now(),
      uploaded: false,
    };
  }

  async postPending(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const settings: YoutubeZernioSettingsDto =
      firstPost?.settings || ({} as any);

    const video = mediaUpload(firstPost?.media?.[0]?.path || '', VIDEO_TYPES);
    if (!video) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'YouTube (Zernio) needs exactly one video (mp4, mov, webm, m4v, mpeg, avi)'
      );
    }

    const thumbnail = settings?.thumbnail?.path
      ? mediaUpload(settings.thumbnail.path, IMAGE_TYPES)
      : undefined;
    if (settings?.thumbnail?.path && !thumbnail) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'The thumbnail must be a JPEG, PNG or GIF image'
      );
    }

    try {
      setHeartbeatDetails('youtube-zernio: presign media');
      const pendingData: ZernioPendingData = {
        requestId: randomUUID(),
        accountId: id,
        content: firstPost.message || '',
        title: settings.title,
        visibility: (settings.type as any) || 'private',
        madeForKids: settings.selfDeclaredMadeForKids === 'yes',
        tags: (settings.tags || []).map((t) => t.label).filter(Boolean),
        ...(settings.categoryId ? { categoryId: settings.categoryId } : {}),
        ...(settings.playlistId ? { playlistId: settings.playlistId } : {}),
        ...(settings.containsSyntheticMedia
          ? { containsSyntheticMedia: true }
          : {}),
        ...(settings.firstComment?.trim()
          ? { firstComment: settings.firstComment.trim() }
          : {}),
        video: await this.presign(video),
        ...(thumbnail ? { thumbnail: await this.presign(thumbnail) } : {}),
        retries: 0,
      };

      return [
        {
          id: firstPost.id,
          postId: '',
          releaseURL: '',
          status: 'pending',
          pendingData,
        },
      ];
    } catch (err) {
      this.toBadBody(err, 'Could not prepare the Zernio upload');
    }
  }

  override async checkPostStatus(
    accessToken: string,
    pendingData: ZernioPendingData,
    integration: Integration
  ): Promise<PendingCheckResponse> {
    // nothing created on Zernio yet: finalizePost uploads and creates it
    if (!pendingData.zernioPostId || pendingData.retryRequested) {
      return { status: 'ready', pendingData };
    }

    let post: ZernioPost;
    try {
      setHeartbeatDetails('youtube-zernio: get post');
      post = await this.zernio().getPost(pendingData.zernioPostId);
    } catch (err) {
      // transient read error: the workflow checks again
      if (
        err instanceof ZernioApiError &&
        (err.status === 0 || err.status === 429 || err.status >= 500)
      ) {
        return { status: 'pending', pendingData };
      }
      this.toBadBody(err, 'Could not read the Zernio post');
    }

    const target =
      post.platforms?.find((p) => p.platform === 'youtube') ||
      post.platforms?.[0];

    if (target?.status === 'published' || post.status === 'published') {
      const videoId = target?.platformPostId || '';
      // the Zernio post id is kept as the release id: Zernio's analytics are
      // looked up by it, the YouTube link is the release URL
      return {
        status: 'completed',
        postId: pendingData.zernioPostId,
        releaseURL:
          target?.platformPostUrl ||
          (videoId ? `https://www.youtube.com/watch?v=${videoId}` : ''),
      };
    }

    if (target?.status === 'failed' || post.status === 'failed') {
      const retryable =
        target?.errorSource !== 'user' &&
        RETRYABLE_CATEGORIES.includes(target?.errorCategory || 'unknown');
      const maxRetries = Number(process.env.ZERNIO_MAX_RETRIES ?? 2);
      if (retryable && pendingData.retries < maxRetries) {
        return {
          status: 'ready',
          pendingData: { ...pendingData, retryRequested: true },
        };
      }
      throw new BadBody(
        this.identifier,
        JSON.stringify({
          errorCategory: target?.errorCategory,
          errorSource: target?.errorSource,
        }),
        '{}',
        `Zernio could not publish to YouTube: ${
          target?.errorMessage || 'unknown error'
        }`
      );
    }

    if (post.status === 'cancelled' || target?.status === 'cancelled') {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'The post was cancelled in Zernio'
      );
    }

    // draft / scheduled / publishing / processing / uploading
    return { status: 'pending', pendingData };
  }

  private async uploadMedia(media: ZernioMediaUpload): Promise<ZernioMediaUpload> {
    if (media.uploaded) {
      return media;
    }
    // presigned URLs live for 1 hour, get a fresh one when we're close to that
    const current =
      media.uploadUrl && Date.now() - (media.presignedAt || 0) < 50 * 60 * 1000
        ? media
        : await this.presign(media);

    let size: number;
    let body: any;
    if (current.local) {
      size = statSync(current.source).size;
      body = createReadStream(current.source);
    } else {
      setHeartbeatDetails(`youtube-zernio: read media ${stripQuery(current.source)}`);
      const response = await fetch(current.source, {
        headers: { 'accept-encoding': 'identity' },
        dispatcher: getSsrfSafeDispatcher(),
      } as any);
      size = Number(response.headers.get('content-length'));
      if (!response.ok || !response.body || !Number.isFinite(size) || size <= 0) {
        throw new BadBody(
          this.identifier,
          '{}',
          '{}',
          'Could not read the media file for the Zernio upload'
        );
      }
      body = response.body;
    }

    setHeartbeatDetails(`youtube-zernio: upload ${current.filename}`);
    await this.zernio().uploadToPresignedUrl(
      current.uploadUrl!,
      body,
      current.contentType,
      size
    );
    return { ...current, uploaded: true };
  }

  override async finalizePost(
    accessToken: string,
    pendingData: ZernioPendingData,
    integration: Integration
  ): Promise<PendingCheckResponse> {
    const client = this.zernio();

    try {
      if (pendingData.zernioPostId && pendingData.retryRequested) {
        // a previous finalize may already have retried before dying: only
        // retry a post that is still failed, so this stays idempotent
        const current = await client.getPost(pendingData.zernioPostId);
        if (current.status !== 'failed') {
          return {
            status: 'pending',
            pendingData: { ...pendingData, retryRequested: false },
          };
        }
        setHeartbeatDetails('youtube-zernio: retry post');
        await client.retryPost(pendingData.zernioPostId);
        return {
          status: 'pending',
          pendingData: {
            ...pendingData,
            retryRequested: false,
            retries: pendingData.retries + 1,
          },
        };
      }

      if (pendingData.zernioPostId) {
        return { status: 'pending', pendingData };
      }

      const video = await this.uploadMedia(pendingData.video);
      const thumbnail = pendingData.thumbnail
        ? await this.uploadMedia(pendingData.thumbnail)
        : undefined;

      setHeartbeatDetails('youtube-zernio: create post');
      const created = await client.createPost(
        {
          content: pendingData.content,
          mediaItems: [
            {
              type: 'video',
              url: video.publicUrl!,
              ...(thumbnail ? { thumbnail: thumbnail.publicUrl } : {}),
            },
          ],
          platforms: [
            {
              platform: 'youtube',
              accountId: pendingData.accountId,
              platformSpecificData: {
                title: pendingData.title,
                visibility: pendingData.visibility,
                madeForKids: pendingData.madeForKids,
                ...(pendingData.categoryId
                  ? { categoryId: pendingData.categoryId }
                  : {}),
                ...(pendingData.playlistId
                  ? { playlistId: pendingData.playlistId }
                  : {}),
                ...(pendingData.containsSyntheticMedia
                  ? { containsSyntheticMedia: true }
                  : {}),
                ...(pendingData.firstComment
                  ? { firstComment: pendingData.firstComment }
                  : {}),
              },
            },
          ],
          ...(pendingData.tags.length ? { tags: pendingData.tags } : {}),
          // Postiz already waited for the scheduled time in its workflow
          publishNow: true,
        },
        pendingData.requestId
      );

      const zernioPostId = created.post?._id || created.duplicateOf;
      if (!zernioPostId) {
        throw new BadBody(
          this.identifier,
          '{}',
          '{}',
          'Zernio did not return a post id'
        );
      }

      return {
        status: 'pending',
        pendingData: {
          ...pendingData,
          video,
          ...(thumbnail ? { thumbnail } : {}),
          zernioPostId,
        },
      };
    } catch (err) {
      // network error / Zernio outage: a plain error lets the workflow check
      // again, and the retry is idempotent (same x-request-id / content)
      if (
        err instanceof ZernioApiError &&
        (err.status === 0 || err.status === 429 || err.status >= 500)
      ) {
        throw new Error(err.message);
      }
      this.toBadBody(err, 'Could not publish through Zernio');
    }
  }
}
