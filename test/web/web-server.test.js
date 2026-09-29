import { test, expect, describe } from 'bun:test';
import crypto from 'node:crypto';
import {
  createHandler,
  parseDownloadRequest,
  contentDisposition,
  signStreamToken,
} from '../../src/web-server.js';
import { redactForWeb } from '../../src/utils/logger.js';

const ok = async () => true;
const result = { lane: 'direct', files: [{ url: 'https://video.example/a.mp4' }] };

function post(body, headers = {}) {
  return new Request('http://web/api/download', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const body = { url: 'https://x.com/a/status/1', turnstile: 'token' };
const readJson = async res => JSON.parse(await res.text());

describe('parseDownloadRequest', () => {
  test('pulls the link out of pasted text and converts trims to start + duration', () => {
    expect(
      parseDownloadRequest({ url: 'look https://x.com/a/status/1 lol', start: '1:00', end: '90' })
    ).toEqual({ url: 'https://x.com/a/status/1', audio: false, startTime: 60, duration: 30 });
  });

  test('refuses private hosts, bad modes and backwards trims', () => {
    expect(() => parseDownloadRequest({ url: 'http://127.0.0.1/' })).toThrow();
    expect(() => parseDownloadRequest({ url: 'http://192.168.0.212:3000/' })).toThrow();
    expect(() => parseDownloadRequest({ url: 'no link here' })).toThrow();
    expect(() => parseDownloadRequest({ url: 'https://x.com/', mode: 'gif' })).toThrow();
    expect(() => parseDownloadRequest({ url: 'https://x.com/', start: '20', end: '10' })).toThrow();
  });
});

describe('handler', () => {
  test('health, preflight from the page, and unknown routes', async () => {
    const handle = createHandler({ verify: ok });
    expect((await handle(new Request('http://web/api/health'))).status).toBe(200);
    const pre = await handle(
      new Request('http://web/api/download', {
        method: 'OPTIONS',
        headers: { origin: 'https://web.gronka.dev' },
      })
    );
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://web.gronka.dev');
    const foreign = await handle(
      new Request('http://web/api/health', { headers: { origin: 'https://evil.example' } })
    );
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    expect((await handle(new Request('http://web/nope'))).status).toBe(404);
  });

  test('bad json and failed verification never reach the downloader', async () => {
    let calls = 0;
    const download = async () => (calls++, result);
    const handle = createHandler({ verify: async () => false, download });
    expect((await handle(post('{nope'))).status).toBe(400);
    const res = await handle(post(body));
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('VERIFICATION_FAILED');
    expect(calls).toBe(0);
  });

  test('a download answers with padded json carrying the result', async () => {
    const handle = createHandler({ verify: ok, download: async () => result });
    const res = await handle(post(body));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.startsWith(' ')).toBe(true);
    expect(JSON.parse(text)).toEqual(result);
    expect(handle.stats().lanes.direct).toBe(1);
  });

  test('internal errors are curated, AppErrors pass through', async () => {
    const handle = createHandler({
      verify: ok,
      download: async () => {
        throw new Error('ENOENT /app/temp/secret-path');
      },
    });
    const out = await readJson(await handle(post(body)));
    expect(out.error).toEqual({
      code: 'DOWNLOAD_FAILED',
      message: 'could not download this content.',
    });
  });

  test('per-ip limit, one job per ip, and the global cap', async () => {
    const limited = createHandler({ verify: ok, download: async () => result, ipLimit: 2 });
    expect((await limited(post(body))).status).toBe(200);
    expect((await limited(post(body))).status).toBe(200);
    expect((await limited(post(body))).status).toBe(429);
    expect((await limited(post(body, { 'cf-connecting-ip': '198.51.100.1' }))).status).toBe(200);

    let release;
    const slow = () => new Promise(resolve => (release = () => resolve(result)));
    const capped = createHandler({ verify: ok, download: slow, maxJobs: 1 });
    const first = await capped(post(body));
    expect((await capped(post(body))).status).toBe(429);
    expect((await capped(post(body, { 'cf-connecting-ip': '198.51.100.2' }))).status).toBe(503);
    release();
    await first.text();
  });
});

test('redaction strips links, addresses, keys and account numbers', () => {
  const line = redactForWeb(
    'fetched https://cdn.example/v.mp4?sig=1 for 203.0.113.9 and 2001:db8::1 key gk_abc_def GW-7K3P9-ABCD'
  );
  expect(line).toBe('fetched <url> for <ip> and <ip> key <key> <account>');
});

test('content disposition keeps unicode names but sanitizes the ascii fallback', () => {
  expect(contentDisposition('ça "va".mp4')).toBe(
    `attachment; filename="_a _va_.mp4"; filename*=UTF-8''%C3%A7a%20%22va%22.mp4`
  );
});

test('stream tokens are body.sig with an hmac the worker can verify', () => {
  const token = signStreamToken({ u: 'https://a/b', e: 1 }, 'k');
  const [bodyPart, sig] = token.split('.');
  expect(JSON.parse(Buffer.from(bodyPart, 'base64url').toString())).toEqual({
    u: 'https://a/b',
    e: 1,
  });
  expect(sig).toBe(crypto.createHmac('sha256', 'k').update(bodyPart).digest('base64url'));
});
