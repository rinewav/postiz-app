// Minimal Zernio API mock for local/CI end-to-end tests of the YouTube (Zernio)
// integration. Implements only the endpoints Postiz uses, following the shapes
// of the official OpenAPI spec (https://zernio.com/openapi.json):
//   GET  /api/v1/profiles             GET  /api/v1/accounts
//   GET  /api/v1/connect/:platform    POST /api/v1/media/presign
//   POST /api/v1/posts                GET  /api/v1/posts/:id
//   POST /api/v1/posts/:id/retry
// plus the presigned upload target (PUT /upload/:key), a fake OAuth page
// (/mock-oauth) and an inspection endpoint (GET /__mock/state).
//
// Special titles drive failure scenarios:
//   "[fail-once]"  first publish fails with a retryable platform_error
//   "[fail]"       every publish fails with a retryable platform_error
//   "[user-error]" publish fails with a non-retryable user_content error
//
// Env: PORT (4010), MOCK_API_KEY (sk_mock), PUBLIC_URL (browser-facing base),
// INTERNAL_URL (container-facing base), PUBLISH_DELAY_MS (3000)
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 4010);
const API_KEY = process.env.MOCK_API_KEY || 'sk_mock';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const INTERNAL_URL = process.env.INTERNAL_URL || PUBLIC_URL;
const PUBLISH_DELAY_MS = Number(process.env.PUBLISH_DELAY_MS || 3000);

const profile = { _id: 'mockprofile000000000001', name: 'Mock', isDefault: true };
const accounts = [
  {
    _id: 'mockaccount0000000000001',
    platform: 'youtube',
    profileId: profile._id,
    username: '@mock-channel',
    displayName: 'Mock YouTube Channel',
    profilePicture: null,
    isActive: true,
    followersCount: 1234,
  },
];

const state = {
  uploads: {}, // key -> { size, contentType }
  posts: {}, // id -> post
  requestIds: {}, // x-request-id -> post id
  hashes: {}, // content hash -> post id
  requests: [], // log without Authorization
};

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // keep only the first MB in memory, count the rest
      if (size < 1024 * 1024) chunks.push(c);
    });
    req.on('end', () => resolve({ buffer: Buffer.concat(chunks), size }));
  });

const schedulePublish = (post) => {
  const target = post.platforms[0];
  const title = target.platformSpecificData?.title || '';
  target.status = 'uploading';
  post.status = 'publishing';
  setTimeout(() => {
    post.attempts = (post.attempts || 0) + 1;
    const fail =
      title.includes('[fail]') ||
      (title.includes('[fail-once]') && post.attempts === 1);
    if (title.includes('[user-error]')) {
      Object.assign(target, {
        status: 'failed',
        errorMessage: 'Mock: video rejected (user error)',
        errorCategory: 'user_content',
        errorSource: 'user',
      });
      post.status = 'failed';
    } else if (fail) {
      Object.assign(target, {
        status: 'failed',
        errorMessage: 'Mock: YouTube backend error',
        errorCategory: 'platform_error',
        errorSource: 'platform',
      });
      post.status = 'failed';
    } else {
      const videoId = 'mock' + randomUUID().replace(/-/g, '').slice(0, 7);
      Object.assign(target, {
        status: 'published',
        platformPostId: videoId,
        platformPostUrl: `https://www.youtube.com/watch?v=${videoId}`,
        publishedAt: new Date().toISOString(),
        errorMessage: undefined,
        errorCategory: undefined,
        errorSource: undefined,
      });
      post.status = 'published';
    }
  }, PUBLISH_DELAY_MS);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  const path = url.pathname;
  const { buffer, size } = await readBody(req);
  const headers = { ...req.headers };
  delete headers.authorization;
  state.requests.push({ method: req.method, path, headers, size });

  // --- non-API routes ------------------------------------------------------
  if (req.method === 'PUT' && path.startsWith('/upload/')) {
    const key = decodeURIComponent(path.slice('/upload/'.length));
    state.uploads[key] = { size, contentType: req.headers['content-type'] };
    res.writeHead(200);
    return res.end();
  }
  if (req.method === 'GET' && path.startsWith('/media/')) {
    const key = decodeURIComponent(path.slice('/media/'.length));
    return state.uploads[key] ? json(res, 200, state.uploads[key]) : json(res, 404, {});
  }
  if (req.method === 'GET' && path === '/mock-oauth') {
    const target = new URL(url.searchParams.get('redirect_url'));
    target.searchParams.set('connected', 'youtube');
    target.searchParams.set('profileId', profile._id);
    target.searchParams.set('accountId', accounts[0]._id);
    target.searchParams.set('username', accounts[0].username);
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(
      `<html><body><h1>Mock Zernio / Google consent</h1>` +
        `<a id="allow" href="${target.toString().replace(/&/g, '&amp;')}">Allow</a></body></html>`
    );
  }
  if (req.method === 'GET' && path === '/__mock/state') {
    return json(res, 200, state);
  }
  if (req.method === 'GET' && path === '/health') {
    return json(res, 200, { ok: true });
  }

  // --- API -----------------------------------------------------------------
  if (!path.startsWith('/api/v1/')) {
    return json(res, 404, { error: 'Not found' });
  }
  if (req.headers.authorization !== `Bearer ${API_KEY}`) {
    return json(res, 401, { error: 'Invalid API key', type: 'authentication_error' });
  }
  const body = buffer.length ? JSON.parse(buffer.toString() || '{}') : {};

  if (req.method === 'GET' && path === '/api/v1/profiles') {
    return json(res, 200, { profiles: [profile], total: 1, skip: 0, limit: 50 });
  }
  if (req.method === 'GET' && path === '/api/v1/accounts') {
    const platform = url.searchParams.get('platform');
    return json(res, 200, {
      accounts: accounts.filter((a) => !platform || a.platform === platform),
      hasAnalyticsAccess: false,
    });
  }
  const connect = path.match(/^\/api\/v1\/connect\/([^/]+)$/);
  if (req.method === 'GET' && connect) {
    const redirect = url.searchParams.get('redirect_url');
    if (!redirect || !/^https?:\/\//.test(redirect)) {
      return json(res, 400, { error: 'redirect_url must be absolute', code: 'INVALID_REDIRECT_URL' });
    }
    const authUrl = new URL('/mock-oauth', PUBLIC_URL);
    authUrl.searchParams.set('redirect_url', redirect);
    return json(res, 200, { authUrl: authUrl.toString(), state: randomUUID() });
  }
  if (req.method === 'POST' && path === '/api/v1/media/presign') {
    if (!body.filename || !body.contentType) {
      return json(res, 400, { error: 'filename and contentType are required' });
    }
    const key = `${randomUUID()}/${body.filename}`;
    return json(res, 200, {
      uploadUrl: `${INTERNAL_URL}/upload/${encodeURIComponent(key)}`,
      publicUrl: `${INTERNAL_URL}/media/${encodeURIComponent(key)}`,
      key,
      expiresIn: 3600,
    });
  }
  if (req.method === 'POST' && path === '/api/v1/posts') {
    const requestId = req.headers['x-request-id'];
    if (requestId && state.requestIds[requestId]) {
      return json(res, 200, { existingPost: state.posts[state.requestIds[requestId]] });
    }
    const target = body.platforms?.[0];
    if (!target?.accountId || !accounts.find((a) => a._id === target.accountId)) {
      return json(res, 403, { error: 'Account not found' });
    }
    for (const item of body.mediaItems || []) {
      for (const u of [item.url, item.thumbnail].filter(Boolean)) {
        const key = decodeURIComponent(u.split('/media/')[1] || '');
        if (!state.uploads[key]) {
          return json(res, 400, { error: `Media not uploaded: ${u}`, type: 'invalid_request_error' });
        }
      }
    }
    if ((target.platformSpecificData?.title || '').length > 100) {
      return json(res, 400, { error: 'title must be at most 100 characters', param: 'title' });
    }
    const hash = createHash('sha256')
      .update(JSON.stringify([target.accountId, body.content, body.mediaItems]))
      .digest('hex');
    if (state.hashes[hash]) {
      return json(res, 409, {
        error: 'This exact content is already scheduled, publishing, or was posted to this account within the last 24 hours.',
        details: { accountId: target.accountId, platform: 'youtube', existingPostId: state.hashes[hash] },
      });
    }
    const post = {
      _id: randomUUID().replace(/-/g, '').slice(0, 24),
      content: body.content,
      mediaItems: body.mediaItems,
      tags: body.tags,
      status: 'scheduled',
      platforms: [{ ...target, status: 'pending' }],
      createdAt: new Date().toISOString(),
    };
    state.posts[post._id] = post;
    state.hashes[hash] = post._id;
    if (requestId) state.requestIds[requestId] = post._id;
    schedulePublish(post);
    return json(res, 201, { message: 'Post created', post });
  }
  const getPost = path.match(/^\/api\/v1\/posts\/([^/]+)$/);
  if (req.method === 'GET' && getPost) {
    const post = state.posts[getPost[1]];
    return post ? json(res, 200, { post }) : json(res, 404, { error: 'Post not found' });
  }
  const retry = path.match(/^\/api\/v1\/posts\/([^/]+)\/retry$/);
  if (req.method === 'POST' && retry) {
    const post = state.posts[retry[1]];
    if (!post) return json(res, 404, { error: 'Post not found' });
    if (post.status === 'publishing') return json(res, 409, { error: 'Post is currently publishing' });
    if (post.status !== 'failed') return json(res, 400, { error: 'Invalid state' });
    schedulePublish(post);
    return json(res, 200, { message: 'Retrying', post });
  }

  return json(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`zernio-mock listening on :${PORT} (public ${PUBLIC_URL}, internal ${INTERNAL_URL})`);
});
