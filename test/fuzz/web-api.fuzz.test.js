import { test, describe, expect, beforeAll } from 'bun:test';
import { createHandler } from '../../src/web-server.js';
import { ensureWebSchema } from '../../src/web/keys.js';
import { AppError, NetworkError, ValidationError } from '../../src/utils/errors.js';
import { rng, junk, SEED, ITERATIONS, describeCase, ASCII } from './rng.js';

process.env.WEB_PEPPER ??= 'test-pepper-test-pepper-test-pepper-0123';

const CANARY = 'canary-/home/bun/.secret-7f3a';
const INTERNALS = /canary-|\/home\/|\/app\/|node_modules|at .*\.js:\d+|postgres|ECONNREFUSED/i;
const STATUSES = new Set([200, 201, 204, 400, 401, 403, 404, 413, 429, 499, 502]);

function failure(r) {
  return r.pick([
    () => new Error(`boom ${CANARY}`),
    () => Object.assign(new Error(CANARY), { code: 'ECONNREFUSED' }),
    () => new TypeError(`cannot read ${CANARY}`),
    () => new ValidationError('that link is not supported.'),
    () => new NetworkError('could not reach that site.', 'SITE_DOWN'),
    () => new AppError('gone.', 'CONTENT_GONE', 500),
    () => ({ not: 'an error', CANARY }),
    () => 'a string',
  ])();
}

function randomJson(r, depth = 0) {
  const roll = r.next();
  if (roll < 0.3) return junk(r, 40);
  if (roll < 0.45) return r.pick([null, true, false, 0, -1, 1e308, '']);
  if (roll < 0.6 && depth < 3)
    return Array.from({ length: r.int(4) }, () => randomJson(r, depth + 1));
  if (roll < 0.9 && depth < 3) {
    const out = {};
    for (const key of [
      'url',
      'mode',
      'start',
      'end',
      'split',
      'format',
      'thread',
      'transcript',
      'depth',
      'comments',
      'turnstile',
      junk(r, 6),
    ]) {
      if (r.chance(0.5)) out[key] = randomJson(r, depth + 1);
    }
    if (r.chance(0.6))
      out.url = r.pick([
        'https://x.com/a/status/1',
        'http://127.0.0.1/',
        `https://${r.chars('abc.-'.split(''), 12, 1)}/${junk(r, 10)}`,
      ]);
    return out;
  }
  return 'https://x.com/a/status/1';
}

function randomRequest(r) {
  const method = r.pick([
    'GET',
    'POST',
    'POST',
    'POST',
    'DELETE',
    'OPTIONS',
    'PUT',
    'PATCH',
    'HEAD',
  ]);
  const path = r.pick([
    '/',
    '/v1',
    '/v1/',
    '/health',
    '/v1/health',
    '/v1/download',
    '/v1/download',
    '/v1/content',
    '/v1/keys',
    `/${junk(r, 20)}`,
    '/v1/download/../keys',
    '/v1/%64ownload',
  ]);
  const headers = {
    'cf-connecting-ip': r.chance(0.8) ? `203.0.113.${r.int(256)}` : r.chars(ASCII, 30),
  };
  if (r.chance(0.5))
    headers['content-type'] = r.pick(['application/json', 'text/plain', r.chars(ASCII, 20)]);
  if (r.chance(0.3))
    headers.authorization = r.pick([
      `Bearer ${r.chars(ASCII, 60)}`,
      r.chars(ASCII, 60),
      'Bearer ',
      `Bearer gk_${r.chars('0123456789abcdefghjkmnpqrstvwxyz'.split(''), 8, 8)}_${r.chars(ASCII, 51, 51)}`,
    ]);
  if (r.chance(0.3))
    headers.origin = r.pick(['https://gronka.dev', 'https://evil.example', r.chars(ASCII, 20)]);
  if (r.chance(0.2)) headers['content-length'] = r.pick(['-1', '99999999', 'abc', '0']);
  let body;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const roll = r.next();
    body =
      roll < 0.6
        ? JSON.stringify(randomJson(r))
        : roll < 0.8
          ? junk(r, 200)
          : roll < 0.9
            ? ''
            : 'x'.repeat(r.int(40000));
  }
  let url;
  try {
    url = new URL(path, 'http://web').href;
  } catch {
    url = 'http://web/';
  }
  const init = { method, headers };
  if (body !== undefined) init.body = body;
  return new Request(url, init);
}

describe('web api fuzz', () => {
  beforeAll(() => ensureWebSchema());

  test(`every request gets a curated json answer, never a 500 or an internal detail (seed ${SEED})`, async () => {
    const r = rng(SEED);
    const handler = createHandler({
      verify: async () => r.chance(0.8),
      download: async () => {
        if (r.chance(0.5)) throw failure(r);
        return { lane: 'direct', files: [{ url: 'https://video.example/a.mp4' }] };
      },
      content: async () => {
        if (r.chance(0.5)) throw failure(r);
        return { source: 'reddit', posts: [] };
      },
      ipLimit: 1_000_000,
      authLimit: 1_000_000,
      signupLimit: 1_000_000,
    });
    for (let i = 0; i < ITERATIONS; i++) {
      const req = randomRequest(r);
      const why = describeCase(SEED, i, {
        method: req.method,
        url: req.url,
        headers: Object.fromEntries(req.headers),
      });
      let res;
      try {
        res = await handler(req, { requestIP: () => ({ address: '198.51.100.1' }) });
      } catch (error) {
        throw new Error(`handler threw on ${why}: ${error.stack}`, { cause: error });
      }
      const text = await res.text();
      const whyRes = `${why} -> ${res.status} ${text.slice(0, 300)}`;
      expect([whyRes, STATUSES.has(res.status)]).toEqual([whyRes, true]);
      expect([why, INTERNALS.test(text)]).toEqual([why, false]);
      if (res.status === 204) continue;
      expect([why, res.headers.get('content-type')]).toEqual([why, 'application/json']);
      expect([why, res.headers.get('x-content-type-options')]).toEqual([why, 'nosniff']);
      const allowOrigin = res.headers.get('access-control-allow-origin');
      expect([why, allowOrigin === null || allowOrigin === 'https://gronka.dev']).toEqual([
        why,
        true,
      ]);
      let parsed;
      expect(() => (parsed = JSON.parse(text))).not.toThrow();
      if (res.status >= 400) {
        expect([why, typeof parsed.error?.code, typeof parsed.error?.message]).toEqual([
          why,
          'string',
          'string',
        ]);
      }
    }
  });

  test(`the per-address limit holds whatever the address header looks like (seed ${SEED})`, async () => {
    const r = rng(SEED + 1);
    const handler = createHandler({
      verify: async () => true,
      download: async () => ({ lane: 'direct', files: [] }),
      ipLimit: 3,
    });
    for (let i = 0; i < 30; i++) {
      const ip = r.chance(0.5)
        ? r.chars(ASCII, 40)
        : r.pick([
            '',
            '2001:db8::1',
            '2001:db8::2',
            '::ffff:203.0.113.5',
            '203.0.113.5',
            '203.0.113.5, 10.0.0.1',
          ]);
      const statuses = [];
      for (let n = 0; n < 5; n++) {
        const res = await handler(
          new Request('http://web/v1/download', {
            method: 'POST',
            headers: { 'cf-connecting-ip': ip },
            body: JSON.stringify({ url: 'https://x.com/a/status/1', turnstile: 't' }),
          }),
          { requestIP: () => ({ address: '198.51.100.1' }) }
        );
        statuses.push(res.status);
      }
      const why = describeCase(SEED, i, ip);
      expect([why, statuses.filter(s => s === 429).length >= 2]).toEqual([why, true]);
    }
  });
});
