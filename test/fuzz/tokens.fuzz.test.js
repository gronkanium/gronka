import { test, describe, expect } from 'bun:test';
import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';
import { parseApiKey } from '../../src/web/keys.js';
import { signStreamToken } from '../../src/web-server.js';
import { verifyToken } from '../../web/worker/index.js';
import { rng, junk, SEED, ITERATIONS, describeCase, ASCII } from './rng.js';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const KEY = 'fuzz-stream-key-0123456789abcdef';

function realKey(r) {
  const id = r.chars(CROCKFORD.split(''), 8, 8);
  const secret = crypto.randomBytes(32).toString('base64url');
  const body = `gk_${id}_${secret}`;
  return { id, key: body + crc32(body).toString(16).padStart(8, '0') };
}

function mutate(r, text) {
  const at = r.int(text.length);
  const how = r.pick(['replace', 'drop', 'insert', 'swap']);
  if (how === 'drop') return text.slice(0, at) + text.slice(at + 1);
  if (how === 'insert') return text.slice(0, at) + r.pick(ASCII) + text.slice(at);
  if (how === 'swap' && at + 1 < text.length && text[at] !== text[at + 1])
    return text.slice(0, at) + text[at + 1] + text[at] + text.slice(at + 2);
  let replacement = r.pick(ASCII);
  while (replacement === text[at]) replacement = r.pick(ASCII);
  return text.slice(0, at) + replacement + text.slice(at + 1);
}

describe('token fuzz', () => {
  test(`a real api key parses and any one-character change does not (seed ${SEED})`, () => {
    const r = rng(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const { id, key } = realKey(r);
      expect(parseApiKey(key)?.id).toBe(id);
      const damaged = mutate(r, key);
      if (damaged === key) continue;
      let parsed;
      expect(() => (parsed = parseApiKey(damaged))).not.toThrow();
      expect([describeCase(SEED, i, damaged), parsed]).toEqual([
        describeCase(SEED, i, damaged),
        null,
      ]);
      expect(parseApiKey(junk(r, 80))).toBe(null);
      expect(parseApiKey(r.pick([null, undefined, 1, {}, [], key.repeat(2)]))).toBe(null);
    }
  });

  test(`a signed stream token verifies and any change, expiry or non-http target is refused (seed ${SEED})`, async () => {
    const r = rng(SEED + 1);
    const now = 1_800_000_000_000;
    for (let i = 0; i < ITERATIONS; i++) {
      const payload = {
        u: `https://cdn.example/${r.chars(ASCII, 20)}`,
        h: { referer: junk(r, 20) },
        n: junk(r, 30),
        e: Math.floor(now / 1000) + r.int(3600, 1),
      };
      const token = signStreamToken(payload, KEY);
      expect((await verifyToken(token, KEY, now))?.u).toBe(payload.u);

      const why = describeCase(SEED, i, token);
      const damaged = mutate(r, token);
      if (damaged !== token) {
        let out;
        try {
          out = await verifyToken(damaged, KEY, now);
        } catch (error) {
          throw new Error(`verifyToken threw on ${why}: ${error.message}`, { cause: error });
        }
        // Base64 padding bits and text after a second dot leave the signed bytes intact.
        expect([why, out]).toEqual([why, out === null ? null : payload]);
      }
      expect(await verifyToken(token, `${KEY}x`, now)).toBe(null);
      expect(await verifyToken(token, KEY, (payload.e + 1) * 1000)).toBe(null);
      const bad = signStreamToken(
        {
          ...payload,
          u: r.pick([
            'file:///etc/passwd',
            'javascript:1',
            'ftp://x',
            '//cdn.example/a',
            junk(r, 20),
          ]),
        },
        KEY
      );
      expect(await verifyToken(bad, KEY, now)).toBe(null);
      let garbage;
      try {
        garbage = await verifyToken(junk(r, 100), KEY, now);
      } catch (error) {
        throw new Error(`verifyToken threw on garbage ${why}: ${error.message}`, { cause: error });
      }
      expect(garbage).toBe(null);
    }
  });
});
