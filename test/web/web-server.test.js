import { test, expect, describe } from 'bun:test';
import crypto from 'node:crypto';
import {
  createHandler,
  parseDownloadRequest,
  contentDisposition,
  signStreamToken,
  directStreamInfo,
  stripAudio,
} from '../../src/web-server.js';
import { redactForWeb } from '../../src/utils/logger.js';

const ok = async () => true;
const result = { lane: 'direct', files: [{ url: 'https://video.example/a.mp4' }] };

function post(body, headers = {}) {
  return new Request('http://web/v1/download', {
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
    ).toEqual({
      url: 'https://x.com/a/status/1',
      audio: false,
      mute: false,
      split: true,
      startTime: 60,
      duration: 30,
    });
    expect(parseDownloadRequest({ url: 'https://x.com/a/status/1', split: false }).split).toBe(
      false
    );
    expect(() => parseDownloadRequest({ url: 'https://x.com/a/status/1', split: 'no' })).toThrow();
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
    expect((await handle(new Request('http://web/v1/health'))).status).toBe(200);
    for (const path of ['/', '/v1']) {
      const index = await handle(new Request(`http://web${path}`));
      expect(index.status).toBe(200);
      expect((await readJson(index)).docs).toBe('https://web.gronka.dev/docs/');
    }
    const pre = await handle(
      new Request('http://web/v1/download', {
        method: 'OPTIONS',
        headers: { origin: 'https://web.gronka.dev' },
      })
    );
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://web.gronka.dev');
    const foreign = await handle(
      new Request('http://web/v1/health', { headers: { origin: 'https://evil.example' } })
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

  test('per-ip limit', async () => {
    const limited = createHandler({ verify: ok, download: async () => result, ipLimit: 2 });
    expect((await limited(post(body))).status).toBe(200);
    expect((await limited(post(body))).status).toBe(200);
    const over = await limited(post(body));
    expect(over.status).toBe(429);
    const wait = Number(over.headers.get('retry-after'));
    expect(wait).toBeGreaterThan(590);
    expect((await readJson(over)).error.retryAfter).toBe(wait);
    expect((await limited(post(body, { 'cf-connecting-ip': '198.51.100.1' }))).status).toBe(200);
  });
});

test('redaction strips links, addresses, keys and account numbers', () => {
  const line = redactForWeb(
    'fetched https://cdn.example/v.mp4?sig=1 for 203.0.113.9 and 2001:db8::1 key gk_abc_def GW 7K3P9 ABCDE'
  );
  expect(line).toBe('fetched <url> for <ip> and <ip> key <key> <account>');
});

test('redaction blanks id-like tokens such as video ids', () => {
  expect(redactForWeb('ERROR: [Imgur] kq9tJGv: not available, retry 2 of 3')).toBe(
    'ERROR: [Imgur] <id>: not available, retry 2 of 3'
  );
});

test('a plain media link becomes one worker part named after the file', () => {
  expect(directStreamInfo('https://i.ibb.co/ab/cat%20pic.JPG?x=1')).toEqual({
    title: 'cat pic.JPG',
    ext: 'jpg',
    parts: [
      { url: 'https://i.ibb.co/ab/cat%20pic.JPG?x=1', headers: {}, ext: 'jpg', kind: 'file' },
    ],
  });
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

test('mute mode drops the audio track and keeps the video untouched', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const dir = fs.mkdtempSync('/tmp/mute-test-');
  const clip = `${dir}/clip.mp4`;
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=64x64:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=duration=1',
    '-shortest',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    clip,
  ]);
  const out = await stripAudio({
    buffer: fs.readFileSync(clip),
    filename: 'clip.mp4',
    contentType: 'video/mp4',
  });
  fs.writeFileSync(`${dir}/out.mp4`, out.buffer);
  const streams = execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type',
    '-of',
    'csv=p=0',
    `${dir}/out.mp4`,
  ])
    .toString()
    .trim();
  expect(streams).toBe('video');
  const image = { buffer: Buffer.from('x'), filename: 'a.jpg', contentType: 'image/jpeg' };
  expect(await stripAudio(image)).toBe(image);
  fs.rmSync(dir, { recursive: true });
  expect(parseDownloadRequest({ url: 'https://x.com/a/status/1', mode: 'mute' }).mute).toBe(true);
});
