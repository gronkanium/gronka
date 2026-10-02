import { test, expect, describe } from 'bun:test';
import crypto from 'node:crypto';
import {
  createHandler,
  parseDownloadRequest,
  parseContentRequest,
  contentDisposition,
  signStreamToken,
  directStreamInfo,
  stripAudio,
} from '../../src/web-server.js';
import { trimItem } from '../../src/utils/video-processor/trim-item.js';
import { redactForWeb } from '../../src/utils/logger.js';
import { NetworkError, ValidationError } from '../../src/utils/errors.js';

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

  test('a download that finishes in time answers with its result and a real status', async () => {
    const handle = createHandler({ verify: ok, download: async () => result });
    const res = await handle(post(body));
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual(result);
    expect(handle.stats().lanes.direct).toBe(1);
  });

  test('a download past the answer window keeps the line open with padded json', async () => {
    const handle = createHandler({
      verify: ok,
      download: () => new Promise(resolve => setTimeout(resolve, 20, result)),
      answerWithinMs: 0,
    });
    const res = await handle(post(body));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.startsWith(' ')).toBe(true);
    expect(JSON.parse(text)).toEqual(result);
  });

  test('failures carry their status: 400 for the user, 502 for the source, curated internals', async () => {
    const failing = error =>
      createHandler({
        verify: ok,
        download: async () => {
          throw error;
        },
      });
    const internal = await failing(new Error('ENOENT /app/temp/secret-path'))(post(body));
    expect(internal.status).toBe(502);
    expect((await readJson(internal)).error).toEqual({
      code: 'DOWNLOAD_FAILED',
      message: 'could not download this content.',
    });
    const user = await failing(new ValidationError('video is too long.'))(post(body));
    expect(user.status).toBe(400);
    expect((await readJson(user)).error.message).toBe('video is too long.');
    const source = await failing(new NetworkError('this post is unavailable.'))(post(body));
    expect(source.status).toBe(502);
  });

  test('a dropped request cancels the download it started', async () => {
    let seen;
    const handle = createHandler({
      verify: ok,
      download: (_job, signal) =>
        new Promise((_, reject) => {
          seen = signal;
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    });
    const client = new AbortController();
    const req = new Request(post(body), { signal: client.signal });
    const pending = handle(req);
    await new Promise(resolve => setTimeout(resolve, 10));
    client.abort();
    const res = await pending;
    expect(seen.aborted).toBe(true);
    expect(res.status).toBe(499);
    expect(handle.stats().cancelled).toBe(1);
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
  const out = await stripAudio({ path: clip, filename: 'clip.mp4', contentType: 'video/mp4' });
  const streams = execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type',
    '-of',
    'csv=p=0',
    out.path,
  ])
    .toString()
    .trim();
  expect(streams).toBe('video');
  const image = { path: '/nonexistent.jpg', filename: 'a.jpg', contentType: 'image/jpeg' };
  expect(await stripAudio(image)).toBe(image);
  fs.rmSync(dir, { recursive: true });
  expect(parseDownloadRequest({ url: 'https://x.com/a/status/1', mode: 'mute' }).mute).toBe(true);
});

test('trimItem cuts a video to the requested section and leaves images alone', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const dir = fs.mkdtempSync('/tmp/trim-test-');
  const clip = `${dir}/clip.mp4`;
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=64x64:duration=6',
    '-c:v',
    'libx264',
    clip,
  ]);
  const out = await trimItem(
    { path: clip, filename: 'clip.mp4', contentType: 'video/mp4' },
    { startTime: 1, duration: 2 }
  );
  const seconds = Number(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      out.path,
    ])
  );
  expect(seconds).toBeGreaterThan(1.5);
  expect(seconds).toBeLessThan(2.5);
  const image = { path: '/nonexistent.jpg', filename: 'a.jpg', contentType: 'image/jpeg' };
  expect(await trimItem(image, { startTime: 1, duration: 2 })).toBe(image);
  fs.rmSync(dir, { recursive: true });
});

test('a client that hangs up mid-download cancels it on a real server', async () => {
  let seen;
  const handle = createHandler({
    verify: ok,
    download: (_job, signal) =>
      new Promise((_, reject) => {
        seen = signal;
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  });
  const server = Bun.serve({ port: 0, fetch: (req, srv) => handle(req, srv) });
  try {
    const client = new AbortController();
    const res = fetch(`http://127.0.0.1:${server.port}/v1/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: client.signal,
    }).catch(() => null);
    await new Promise(resolve => setTimeout(resolve, 100));
    client.abort();
    await res;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(seen?.aborted).toBe(true);
  } finally {
    server.stop(true);
  }
});

describe('content', () => {
  const sample = {
    source: 'twitter',
    url: 'https://x.com/a/status/1',
    post: {
      id: '1',
      author: { handle: 'a', name: 'A', url: 'https://x.com/a' },
      text: 'hi',
      media: [],
    },
    thread: [],
    comments: [],
    truncated: false,
  };
  const postContent = (body, headers = {}) =>
    new Request('http://web/v1/content', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.9',
        ...headers,
      },
      body: JSON.stringify(body),
    });

  test('parseContentRequest validates format, thread and the caps', () => {
    expect(
      parseContentRequest({ url: 'see https://x.com/a/status/1', depth: 2, comments: 5 })
    ).toEqual({
      url: 'https://x.com/a/status/1',
      format: 'json',
      transcript: false,
      thread: true,
      depth: 2,
      comments: 5,
    });
    expect(
      parseContentRequest({ url: 'https://x.com/a/status/1', format: 'text', thread: false })
    ).toMatchObject({
      format: 'text',
      thread: false,
      depth: undefined,
    });
    expect(() => parseContentRequest({ url: 'https://x.com/a/status/1', format: 'xml' })).toThrow();
    expect(() => parseContentRequest({ url: 'https://x.com/a/status/1', depth: 11 })).toThrow();
    expect(() => parseContentRequest({ url: 'https://x.com/a/status/1', comments: -1 })).toThrow();
    expect(() => parseContentRequest({ url: 'https://x.com/a/status/1', comments: 21 })).toThrow();
    expect(() => parseContentRequest({ url: 'https://x.com/a/status/1', thread: 'yes' })).toThrow();
    expect(
      parseContentRequest({ url: 'https://youtu.be/abc', transcript: 'pt-BR' }).transcript
    ).toBe('pt-BR');
    expect(() => parseContentRequest({ url: 'https://youtu.be/a', transcript: 'x y' })).toThrow();
    expect(() => parseContentRequest({ url: 'http://127.0.0.1/' })).toThrow();
  });

  test('answers json, or plain text on request, and hands the options to the reader', async () => {
    let seen;
    const handle = createHandler({
      verify: ok,
      content: async (url, options) => ((seen = { url, options }), sample),
    });
    const res = await handle(postContent({ ...body, depth: 1 }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await readJson(res)).toEqual(sample);
    expect(seen.url).toBe('https://x.com/a/status/1');
    expect(seen.options).toMatchObject({ depth: 1, thread: true });
    expect(handle.stats().content.twitter).toBe(1);

    const text = await handle(postContent({ ...body, format: 'text' }));
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await text.text()).toBe('twitter: https://x.com/a/status/1\n\n@a (A)\nhi\n');
  });

  test('source errors use the http status; unknown errors are curated', async () => {
    const { NetworkError, AppError } = await import('../../src/utils/errors.js');
    const failing = error =>
      createHandler({
        verify: ok,
        content: async () => {
          throw error;
        },
      });
    const gone = await failing(new NetworkError('gone', 'CONTENT_GONE'))(postContent(body));
    expect(gone.status).toBe(404);
    expect((await readJson(gone)).error).toEqual({ code: 'CONTENT_GONE', message: 'gone' });
    const unsupported = await failing(new AppError('nope', 'UNSUPPORTED_SOURCE', 400))(
      postContent(body)
    );
    expect(unsupported.status).toBe(400);
    const down = await failing(new NetworkError('failed to reach x'))(postContent(body));
    expect(down.status).toBe(502);
    const raw = await failing(new Error('ENOENT /app/secret'))(postContent(body));
    expect(raw.status).toBe(502);
    expect((await readJson(raw)).error).toEqual({
      code: 'CONTENT_FAILED',
      message: 'could not read this content.',
    });
  });

  test('downloads and content reads share one quota per caller', async () => {
    const handle = createHandler({
      verify: ok,
      download: async () => result,
      content: async () => sample,
      ipLimit: 2,
    });
    expect((await handle(post(body))).status).toBe(200);
    expect((await handle(postContent(body))).status).toBe(200);
    expect((await handle(postContent(body))).status).toBe(429);
  });
});
