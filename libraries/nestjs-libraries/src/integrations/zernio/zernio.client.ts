// Thin client for the Zernio REST API (https://docs.zernio.com, OpenAPI:
// https://zernio.com/openapi.json). Every Zernio call made by Postiz goes
// through this file, so a change in the Zernio API only has to be handled here.
//
// Auth: `Authorization: Bearer <ZERNIO_API_KEY>`. The key is only ever sent in
// that header - never in a URL or body - and is scrubbed from every error
// message, so it can't leak into logs, Temporal history or the UI.

export const ZERNIO_DEFAULT_BASE_URL = 'https://zernio.com/api';

export type ZernioPostStatus =
  | 'draft'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type ZernioPlatformStatus =
  | 'pending'
  | 'processing'
  | 'uploading'
  | 'published'
  | 'failed'
  | 'cancelled';

export interface ZernioProfile {
  _id: string;
  name: string;
  isDefault?: boolean;
}

export interface ZernioAccount {
  _id: string;
  platform: string;
  profileId: string | { _id: string };
  username?: string;
  displayName?: string;
  profilePicture?: string | null;
  profileUrl?: string;
  isActive?: boolean;
  needsReconnection?: boolean;
  followersCount?: number;
}

export interface ZernioMediaItem {
  type: 'image' | 'video' | 'gif' | 'document';
  url: string;
  thumbnail?: string;
}

export interface ZernioYoutubePlatformData {
  title?: string;
  visibility?: 'public' | 'private' | 'unlisted';
  madeForKids?: boolean;
  containsSyntheticMedia?: boolean;
  categoryId?: string;
  playlistId?: string;
  firstComment?: string;
}

export interface ZernioCreatePostBody {
  content?: string;
  mediaItems?: ZernioMediaItem[];
  platforms: Array<{
    platform: string;
    accountId: string;
    customContent?: string;
    platformSpecificData?: ZernioYoutubePlatformData | Record<string, any>;
  }>;
  scheduledFor?: string;
  timezone?: string;
  publishNow?: boolean;
  isDraft?: boolean;
  tags?: string[];
}

export interface ZernioPlatformTarget {
  platform: string;
  accountId: string | ZernioAccount;
  status?: ZernioPlatformStatus;
  platformPostId?: string;
  platformPostUrl?: string | null;
  publishedAt?: string;
  errorMessage?: string;
  errorCategory?: string;
  errorSource?: 'user' | 'platform' | 'system';
}

export interface ZernioPost {
  _id: string;
  status: ZernioPostStatus;
  platforms: ZernioPlatformTarget[];
  scheduledFor?: string;
}

export interface ZernioPresignResponse {
  uploadUrl: string;
  publicUrl: string;
  key?: string;
  expiresIn?: number;
}

export interface ZernioPlaylist {
  id: string;
  title: string;
  privacy?: 'public' | 'private' | 'unlisted';
  itemCount?: number;
}

// Shared "account insights" envelope (metricType=time_series)
export interface ZernioInsights {
  dateRange?: { since: string; until: string };
  metrics: Record<
    string,
    { total: number; values?: Array<{ date: string; value: number }> }
  >;
  unavailableMetrics?: string[];
}

export interface ZernioPostAnalytics {
  _id?: string;
  postId?: string;
  platform?: string;
  platformPostUrl?: string | null;
  syncStatus?: 'synced' | 'pending' | 'partial' | 'unavailable';
  analytics?: {
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    impressions?: number;
  };
}

export class ZernioApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    // Parsed Zernio ErrorResponse ({ error, type, code, param, details, ... })
    public readonly body: any = {}
  ) {
    super(message);
    this.name = 'ZernioApiError';
  }

  get code(): string | undefined {
    return this.body?.code;
  }

  get details(): any {
    return this.body?.details;
  }
}

export interface ZernioClientOptions {
  apiKey?: string;
  baseUrl?: string;
  // Injectable for tests
  fetchImpl?: typeof fetch;
}

export class ZernioClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ZernioClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ZERNIO_API_KEY ?? '';
    this.baseUrl = (
      options.baseUrl ||
      process.env.ZERNIO_API_URL ||
      ZERNIO_DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  static isConfigured() {
    return !!process.env.ZERNIO_API_KEY;
  }

  // Never let the API key appear in anything we hand back to callers.
  private scrub(text: string) {
    return this.apiKey ? text.split(this.apiKey).join('[REDACTED]') : text;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: any;
      headers?: Record<string, string>;
      timeoutMs?: number;
      // statuses treated as success besides 2xx (e.g. 409 for dedup handling)
      acceptStatus?: number[];
    } = {}
  ): Promise<{ status: number; data: T }> {
    if (!this.apiKey) {
      throw new ZernioApiError(
        'ZERNIO_API_KEY is not set on the Postiz server',
        0
      );
    }

    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(options.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...(options.headers || {}),
        },
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
    } catch (err: any) {
      // network error / timeout: the outcome is unknown to the caller
      throw new ZernioApiError(
        this.scrub(`Zernio request failed: ${err?.message || err}`),
        0
      );
    }

    const text = await response.text().catch(() => '');
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text.slice(0, 500) };
    }

    if (response.ok || options.acceptStatus?.includes(response.status)) {
      return { status: response.status, data };
    }

    throw new ZernioApiError(
      this.scrub(
        `Zernio API ${response.status}: ${
          data?.error || data?.message || response.statusText || 'error'
        }`
      ),
      response.status,
      JSON.parse(this.scrub(JSON.stringify(data)))
    );
  }

  // --- profiles & accounts --------------------------------------------------

  async listProfiles(): Promise<ZernioProfile[]> {
    const { data } = await this.request<{ profiles: ZernioProfile[] }>(
      'GET',
      '/v1/profiles'
    );
    return data.profiles || [];
  }

  // ZERNIO_PROFILE_ID when set, otherwise the default (or first) profile.
  async resolveProfileId(): Promise<string> {
    if (process.env.ZERNIO_PROFILE_ID) {
      return process.env.ZERNIO_PROFILE_ID;
    }
    const profiles = await this.listProfiles();
    const profile = profiles.find((p) => p.isDefault) || profiles[0];
    if (!profile) {
      throw new ZernioApiError(
        'No Zernio profile found, create one in the Zernio dashboard',
        404
      );
    }
    return profile._id;
  }

  async listAccounts(
    params: { platform?: string; profileId?: string } = {}
  ): Promise<ZernioAccount[]> {
    const { data } = await this.request<{ accounts: ZernioAccount[] }>(
      'GET',
      '/v1/accounts',
      { query: params }
    );
    return data.accounts || [];
  }

  // Starts Zernio's hosted OAuth flow. On success Zernio redirects to
  // `redirectUrl` keeping its query string and appending
  // connected=<platform>&profileId=..&accountId=..&username=..
  async getConnectUrl(
    platform: string,
    profileId: string,
    redirectUrl: string
  ): Promise<string> {
    const { data } = await this.request<{ authUrl: string }>(
      'GET',
      `/v1/connect/${encodeURIComponent(platform)}`,
      { query: { profileId, redirect_url: redirectUrl } }
    );
    return data.authUrl;
  }

  // --- media ----------------------------------------------------------------

  async presignMedia(params: {
    filename: string;
    contentType: string;
    size?: number;
  }): Promise<ZernioPresignResponse> {
    const { data } = await this.request<ZernioPresignResponse>(
      'POST',
      '/v1/media/presign',
      { body: params }
    );
    return data;
  }

  // PUT the file bytes to a presigned URL. The URL is signed by Zernio's
  // storage, so no Authorization header is sent here.
  async uploadToPresignedUrl(
    uploadUrl: string,
    body: any,
    contentType: string,
    size: number,
    timeoutMs = 25 * 60 * 1000
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(size),
        },
        body,
        // required by undici when streaming a request body
        duplex: 'half',
        signal: AbortSignal.timeout(timeoutMs),
      } as any);
    } catch (err: any) {
      throw new ZernioApiError(
        `Zernio media upload failed: ${err?.message || err}`,
        0
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ZernioApiError(
        `Zernio media upload failed with ${response.status}: ${text.slice(
          0,
          300
        )}`,
        response.status
      );
    }
  }

  // --- posts ----------------------------------------------------------------

  // `requestId` is Zernio's idempotency key (x-request-id): a repeat with the
  // same id within ~5 minutes returns the original post instead of a new one.
  // A 409 means the same content already went to that account in the last
  // 24h; the existing post id is returned so callers can adopt it.
  async createPost(
    body: ZernioCreatePostBody,
    requestId: string,
    timeoutMs = 10 * 60 * 1000
  ): Promise<{ post?: ZernioPost; duplicateOf?: string; status: number }> {
    const { status, data } = await this.request<any>('POST', '/v1/posts', {
      body,
      headers: { 'x-request-id': requestId },
      timeoutMs,
      acceptStatus: [409],
    });

    if (status === 409) {
      const duplicateOf = data?.details?.existingPostId;
      if (!duplicateOf) {
        throw new ZernioApiError(
          `Zernio API 409: ${data?.error || 'duplicate post'}`,
          409,
          data
        );
      }
      return { duplicateOf, status };
    }

    return { post: data?.post || data?.existingPost, status };
  }

  async getPost(postId: string): Promise<ZernioPost> {
    const { data } = await this.request<{ post: ZernioPost }>(
      'GET',
      `/v1/posts/${encodeURIComponent(postId)}`
    );
    return data.post;
  }

  // --- YouTube helpers ------------------------------------------------------

  async listYoutubePlaylists(accountId: string): Promise<ZernioPlaylist[]> {
    const { data } = await this.request<{ playlists: ZernioPlaylist[] }>(
      'GET',
      `/v1/accounts/${encodeURIComponent(accountId)}/youtube-playlists`
    );
    return data.playlists || [];
  }

  // --- analytics ------------------------------------------------------------

  // Channel metrics from the YouTube Analytics API (2-3 day delay, max 89 days)
  async getYoutubeChannelInsights(params: {
    accountId: string;
    since: string;
    until: string;
    metrics: string[];
  }): Promise<ZernioInsights> {
    const { data } = await this.request<ZernioInsights>(
      'GET',
      '/v1/analytics/youtube/channel-insights',
      {
        query: {
          accountId: params.accountId,
          since: params.since,
          until: params.until,
          metrics: params.metrics.join(','),
          metricType: 'time_series',
        },
      }
    );
    return data;
  }

  // Analytics of one Zernio post (202 = still syncing from the platform)
  async getPostAnalytics(postId: string): Promise<ZernioPostAnalytics> {
    const { data } = await this.request<ZernioPostAnalytics>(
      'GET',
      '/v1/analytics',
      { query: { postId } }
    );
    return data;
  }

  // Zernio posts of an account, used to map a YouTube video id back to its
  // Zernio post id
  async listPostAnalytics(params: {
    accountId: string;
    platform: string;
    fromDate?: string;
    limit?: number;
    page?: number;
  }): Promise<ZernioPostAnalytics[]> {
    const { data } = await this.request<{ posts: ZernioPostAnalytics[] }>(
      'GET',
      '/v1/analytics',
      { query: params }
    );
    return data.posts || [];
  }

  async retryPost(postId: string): Promise<ZernioPost | undefined> {
    const { data } = await this.request<{ post: ZernioPost }>(
      'POST',
      `/v1/posts/${encodeURIComponent(postId)}/retry`,
      // 409: already publishing - nothing to retry, keep polling
      { acceptStatus: [409] }
    );
    return data?.post;
  }
}
