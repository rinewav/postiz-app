// Runs the real ZernioClient + YoutubeZernioProvider over HTTP against the
// Zernio mock server (tools/zernio-mock/server.mjs).
import { ChildProcess, spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { YoutubeZernioProvider } from '@gitroom/nestjs-libraries/integrations/social/youtube.zernio.provider';
import { BadBody } from '@gitroom/nestjs-libraries/integrations/social.abstract';

const PORT = 4400 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = resolve(__dirname, '../../../../..');

const uploadDir = mkdtempSync(join(tmpdir(), 'zernio-it-'));
mkdirSync(join(uploadDir, 'v'), { recursive: true });
writeFileSync(join(uploadDir, 'v/clip.mp4'), Buffer.alloc(256 * 1024, 7));
writeFileSync(join(uploadDir, 'v/thumb.jpg'), Buffer.alloc(2048, 3));

let mock: ChildProcess;

const waitForMock = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('zernio mock did not start');
};

const mockState = async () => (await fetch(`${BASE}/__mock/state`)).json();

// Drives the provider the way post.workflow does: postPending, then
// checkPostStatus / finalizePost until completed (or an error is thrown).
const publish = async (provider: YoutubeZernioProvider, title: string) => {
  const [pending] = await provider.postPending(
    'mockaccount0000000000001',
    'mockprofile000000000001',
    [
      {
        id: 'p1',
        message: `Description for ${title}`,
        settings: {
          title,
          type: 'private',
          selfDeclaredMadeForKids: 'no',
          tags: [],
          thumbnail: { id: 't', path: 'http://localhost:4007/uploads/v/thumb.jpg' },
        },
        media: [{ type: 'video', path: 'http://localhost:4007/uploads/v/clip.mp4' }],
      },
    ],
    {} as any
  );
  let pendingData = pending.pendingData;
  for (let i = 0; i < 100; i++) {
    let result = await provider.checkPostStatus('', pendingData, {} as any);
    if (result.status === 'ready') {
      result = await provider.finalizePost('', result.pendingData, {} as any);
    }
    if (result.status === 'completed') {
      return { result, pendingData };
    }
    pendingData = result.pendingData;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('never completed');
};

describe('YouTube (Zernio) against the Zernio mock', () => {
  beforeAll(async () => {
    mock = spawn(process.execPath, [join(repoRoot, 'tools/zernio-mock/server.mjs')], {
      env: { ...process.env, PORT: String(PORT), PUBLISH_DELAY_MS: '100', PUBLIC_URL: BASE },
      stdio: 'ignore',
    });
    await waitForMock();
    process.env.ZERNIO_API_URL = `${BASE}/api`;
    process.env.ZERNIO_API_KEY = 'sk_mock';
    process.env.FRONTEND_URL = 'http://localhost:4007';
    process.env.UPLOAD_DIRECTORY = uploadDir;
  });

  afterAll(() => {
    mock?.kill();
  });

  it('gets the Zernio account (channel picker)', async () => {
    const provider = new YoutubeZernioProvider();
    const auth: any = await provider.authenticate({ code: 'c', codeVerifier: 'v' });
    expect(auth.accessToken).toBe('mockprofile000000000001');
    const pages = await provider.pages(auth.accessToken);
    expect(pages.map((p) => p.id)).toEqual(['mockaccount0000000000001']);
  });

  it('returns a connect URL that redirects back to the Postiz callback', async () => {
    const provider = new YoutubeZernioProvider();
    const { url, state } = await provider.generateAuthUrl();
    const page = await (await fetch(url)).text();
    const href = decodeURIComponent(page.match(/href="([^"]+)"/)![1].replace(/&amp;/g, '&'));
    expect(href).toContain('/integrations/social/youtube-zernio?state=' + state);
    expect(href).toContain('accountId=mockaccount0000000000001');
  });

  it('uploads media, creates the post and completes', async () => {
    const provider = new YoutubeZernioProvider();
    const { result } = await publish(provider, 'Integration video');
    expect(result).toMatchObject({ status: 'completed' });
    expect((result as any).releaseURL).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=mock/);

    const state = await mockState();
    const uploads = Object.values(state.uploads) as any[];
    expect(uploads.some((u) => u.size === 256 * 1024 && u.contentType === 'video/mp4')).toBe(true);
    expect(uploads.some((u) => u.contentType === 'image/jpeg')).toBe(true);
    const post: any = Object.values(state.posts).find(
      (p: any) => p.platforms[0].platformSpecificData.title === 'Integration video'
    );
    expect(post.platforms[0].platformSpecificData.visibility).toBe('private');
    expect(post.mediaItems[0].thumbnail).toContain('thumb.jpg');
    // the API key never shows up outside the Authorization header
    expect(JSON.stringify(state.requests)).not.toContain('sk_mock');
  });

  it('retries a transient failure and then publishes', async () => {
    const provider = new YoutubeZernioProvider();
    const { result, pendingData } = await publish(provider, 'Retry video [fail-once]');
    expect(result.status).toBe('completed');
    expect(pendingData.retries).toBe(1);
  });

  it('reports a permanent failure', async () => {
    const provider = new YoutubeZernioProvider();
    await expect(publish(provider, 'Broken video [user-error]')).rejects.toBeInstanceOf(BadBody);
  });

  it('fails clearly with a wrong API key', async () => {
    process.env.ZERNIO_API_KEY = 'sk_wrong';
    const provider = new YoutubeZernioProvider();
    const err = await publish(provider, 'Wrong key').catch((e) => e);
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toContain('ZERNIO_API_KEY');
    process.env.ZERNIO_API_KEY = 'sk_mock';
  });
});
