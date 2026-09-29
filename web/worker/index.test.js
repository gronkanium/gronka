import { test, expect, afterEach } from 'bun:test';
import crypto from 'node:crypto';
import worker, { verifyToken } from './index.js';

const KEY = 'test-key';
const env = { STREAM_KEY: KEY };
const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

function sign(payload, key = KEY) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`;
}
const payload = (over = {}) => ({
  u: 'https://video.example/a.mp4',
  h: { 'user-agent': 'ua' },
  n: 'clip "1".mp4',
  e: Math.floor(Date.now() / 1000) + 60,
  ...over,
});
const get = (path, init) => worker.fetch(new Request(`https://dl.gronka.dev${path}`, init), env);

test('accepts a token signed the way gronka-web signs it', async () => {
  expect((await verifyToken(sign(payload()), KEY)).u).toBe('https://video.example/a.mp4');
});

test('rejects a wrong key, an expired token and a non-http url', async () => {
  expect(await verifyToken(sign(payload(), 'other'), KEY)).toBeNull();
  expect(await verifyToken(sign(payload({ e: 1 })), KEY)).toBeNull();
  expect(await verifyToken(sign(payload({ u: 'file:///etc/passwd' })), KEY)).toBeNull();
  expect(await verifyToken('garbage', KEY)).toBeNull();
});

test('a tampered payload fails', async () => {
  const [, sig] = sign(payload()).split('.');
  const forged = Buffer.from(JSON.stringify(payload({ u: 'https://evil.example/' }))).toString(
    'base64url'
  );
  expect((await get(`/f/${forged}.${sig}`)).status).toBe(403);
});

test('streams the source with our headers, forcing non-media types to octet-stream', async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, headers: init.headers };
    return new Response('<html>', {
      status: 206,
      headers: { 'content-type': 'text/html', 'content-range': 'bytes 0-5/6', 'set-cookie': 'x' },
    });
  };
  const res = await get(`/f/${sign(payload())}`, { headers: { range: 'bytes=0-5' } });
  expect(res.status).toBe(206);
  expect(sent.url).toBe('https://video.example/a.mp4');
  expect(sent.headers.get('range')).toBe('bytes=0-5');
  expect(sent.headers.get('user-agent')).toBe('ua');
  expect(res.headers.get('content-type')).toBe('application/octet-stream');
  expect(res.headers.get('content-disposition')).toContain('filename="clip _1_.mp4"');
  expect(res.headers.get('set-cookie')).toBeNull();
  expect(await res.text()).toBe('<html>');
});

test('probe reports whether the source serves this edge, with its size', async () => {
  globalThis.fetch = async () =>
    new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/1234' } });
  expect(await (await get(`/probe/${sign(payload())}`)).json()).toEqual({
    ok: true,
    status: 206,
    size: 1234,
  });
  globalThis.fetch = async () => new Response('no', { status: 403 });
  expect((await (await get(`/probe/${sign(payload())}`)).json()).ok).toBe(false);
});

test('a refused source is a 502, other paths 404', async () => {
  globalThis.fetch = async () => new Response('no', { status: 403 });
  expect((await get(`/f/${sign(payload())}`)).status).toBe(502);
  expect((await get('/anything')).status).toBe(404);
});

test('the root sends visitors to the page and other paths explain themselves', async () => {
  const root = await get('/');
  expect(root.status).toBe(302);
  expect(root.headers.get('location')).toBe('https://web.gronka.dev/');
  const other = await get('/nope');
  expect(other.status).toBe(404);
  expect(await other.text()).toContain('web.gronka.dev');
});
