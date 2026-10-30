import { test, describe, expect } from 'bun:test';
import { parseTimestamp, firstUrlIn } from '../../src/utils/validation.js';
import { parseDownloadRequest, parseContentRequest } from '../../src/web-server.js';
import {
  isMediaResponse,
  isDirectMediaUrl,
  TENOR_VIEW_URL,
} from '../../src/utils/file-downloader.js';
import { detectFileType } from '../../src/utils/storage.js';
import { classifyYtdlpFailure } from '../../src/utils/ytdlp.js';
import { parseMegaUrl, megaKeys } from '../../src/utils/mega.js';
import { AppError } from '../../src/utils/errors.js';
import { rng, junk, SEED, ITERATIONS, describeCase, ASCII } from './rng.js';

const DAY = 24 * 60 * 60;
const TIME_CHARS = '0123456789:.:. -+eE∞x٣１'.split('');

function randomValue(r, depth = 0) {
  const roll = r.next();
  if (roll < 0.2) return junk(r, 40);
  if (roll < 0.35) return r.pick([null, undefined, true, false, 0, -1, 1e308, NaN, Infinity, '']);
  if (roll < 0.5) return r.int(1e6) - 5e5;
  if (roll < 0.6) return r.chars(TIME_CHARS, 12);
  if (roll < 0.7 && depth < 2)
    return Array.from({ length: r.int(4) }, () => randomValue(r, depth + 1));
  if (roll < 0.8 && depth < 2)
    return Object.fromEntries(
      Array.from({ length: r.int(4) }, () => [junk(r, 6), randomValue(r, depth + 1)])
    );
  return r.pick([
    'auto',
    'audio',
    'mute',
    'json',
    'text',
    'en',
    'en-US',
    'https://x.com/a/status/1',
    'http://127.0.0.1/',
  ]);
}

function randomBody(r) {
  if (r.chance(0.15)) return randomValue(r);
  const body = {};
  for (const field of [
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
    junk(r, 8),
  ]) {
    if (r.chance(0.6)) body[field] = randomValue(r);
  }
  if (r.chance(0.5)) body.url = `${junk(r, 10)} https://x.com/${r.chars(ASCII, 30)} ${junk(r, 10)}`;
  return body;
}

describe('parser fuzz', () => {
  test(`parseTimestamp never throws and only yields a finite number of seconds within a day (seed ${SEED})`, () => {
    const r = rng(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const input = r.chance(0.2)
        ? r.pick([
            null,
            undefined,
            5,
            {},
            [],
            '1e3',
            '0x10',
            'Infinity',
            '-1',
            ' 5',
            '5 ',
            '１０',
            '٣',
            '1:60',
            '60:00',
            '24:00:00',
            '23:59:59.999',
            '1:2:3:4',
          ])
        : r.chars(TIME_CHARS, 20);
      let out;
      expect(() => (out = parseTimestamp(input))).not.toThrow();
      const why = describeCase(SEED, i, input);
      if (!out.valid) {
        expect([why, typeof out.error]).toEqual([why, 'string']);
        continue;
      }
      expect([why, Number.isFinite(out.seconds) && out.seconds >= 0 && out.seconds <= DAY]).toEqual(
        [why, true]
      );
      expect([why, /^[0-9:.\s]+$/.test(input)]).toEqual([why, true]);
    }
  });

  test(`parseDownloadRequest and parseContentRequest fail only with a 400 AppError (seed ${SEED})`, () => {
    const r = rng(SEED + 1);
    for (let i = 0; i < ITERATIONS; i++) {
      const body = randomBody(r);
      const why = describeCase(SEED, i, body);
      for (const parse of [parseDownloadRequest, parseContentRequest]) {
        let out;
        try {
          out = parse(body);
        } catch (error) {
          expect([why, error instanceof AppError, error.statusCode]).toEqual([why, true, 400]);
          expect([why, /[\\/]home|[\\/]app|node_modules|at .*:\d+/.test(error.message)]).toEqual([
            why,
            false,
          ]);
          continue;
        }
        expect([why, /^https?:\/\//i.test(out.url)]).toEqual([why, true]);
        if (parse === parseDownloadRequest) {
          for (const n of [out.startTime, out.duration]) {
            expect([why, n === null || (Number.isFinite(n) && n >= 0 && n <= DAY)]).toEqual([
              why,
              true,
            ]);
          }
          if (out.duration !== null) expect([why, out.duration > 0]).toEqual([why, true]);
        } else {
          for (const n of [out.depth, out.comments]) {
            expect([why, n === undefined || (Number.isInteger(n) && n >= 0)]).toEqual([why, true]);
          }
        }
      }
    }
  });

  test(`url regexes finish fast on adversarial text (seed ${SEED})`, () => {
    const r = rng(SEED + 2);
    const blocks = [
      'a',
      '-gif-',
      '.',
      '/',
      'www.',
      'http://',
      'https://tenor.com/view/',
      ')',
      '(',
      ' ',
      '-',
    ];
    for (let i = 0; i < 40; i++) {
      const text = Array.from({ length: 4096 / 4 }, () => r.pick(blocks))
        .join('')
        .slice(0, 4096);
      const started = Date.now();
      firstUrlIn(text);
      TENOR_VIEW_URL.test(text);
      isDirectMediaUrl(text);
      const took = Date.now() - started;
      expect([describeCase(SEED, i, text.slice(0, 60)), took < 100]).toEqual([
        describeCase(SEED, i, text.slice(0, 60)),
        true,
      ]);
    }
  });

  test(`media sniffing never throws on any header or head bytes (seed ${SEED})`, () => {
    const r = rng(SEED + 3);
    for (let i = 0; i < ITERATIONS; i++) {
      const type = r.chance(0.3)
        ? r.pick([
            undefined,
            null,
            '',
            'video/mp4',
            'application/octet-stream; charset=x',
            'IMAGE/GIF',
          ])
        : junk(r, 30);
      const head = r.chance(0.2)
        ? null
        : Buffer.from(Array.from({ length: r.int(20) }, () => r.int(256)));
      const ext = r.chance(0.5) ? `.${r.chars('abgifmp4zp'.split(''), 5)}` : junk(r, 8);
      let media;
      expect(() => (media = isMediaResponse(type, head))).not.toThrow();
      expect(typeof media).toBe('boolean');
      let kind;
      expect(() => (kind = detectFileType(ext, type ?? '', head))).not.toThrow();
      expect(
        ['video', 'gif', 'image', 'audio', 'archive', 'other', 'unknown', 'file'].includes(kind) ||
          typeof kind === 'string'
      ).toBe(true);
    }
  });

  test(`yt-dlp failures are curated: no stderr fragment reaches the user (seed ${SEED})`, () => {
    const r = rng(SEED + 4);
    const canaries = [
      '/home/bun/cookies.json',
      'sk_live_canary',
      'Traceback (most recent call last)',
      '/app/temp/job-abc',
    ];
    const lines = [
      'ERROR: [youtube] abc: Sign in to confirm',
      'ERROR: HTTP Error 429: Too Many Requests',
      'ERROR: Unsupported URL',
      'File is larger than max-filesize',
      'is not a valid URL',
      'ERROR: [TikTok] 123: Video not available',
    ];
    for (let i = 0; i < ITERATIONS; i++) {
      const canary = r.pick(canaries);
      const output =
        Array.from({ length: r.int(6, 1) }, () =>
          r.chance(0.5) ? r.pick(lines) : junk(r, 60)
        ).join('\n') + `\n${canary}\n`;
      const url = r.chance(0.7)
        ? `https://${r.pick(['youtube.com', 'tiktok.com', 'x.com', 'instagram.com', 'medal.tv', 'example.org'])}/${r.chars(ASCII, 20)}`
        : junk(r, 40);
      let error;
      try {
        error = classifyYtdlpFailure(output, url, { maxSize: 100 * 2 ** 20 });
      } catch (caught) {
        throw new Error(
          `classifyYtdlpFailure threw on ${describeCase(SEED, i, { output, url })}: ${caught.message}`,
          { cause: caught }
        );
      }
      const why = describeCase(SEED, i, { output, url });
      expect([why, error instanceof AppError]).toEqual([why, true]);
      expect([why, error.message.includes(canary)]).toEqual([why, false]);
      expect([why, /Traceback|\/home\/|\/app\/|node_modules/.test(error.message)]).toEqual([
        why,
        false,
      ]);
    }
  });

  test(`mega link parsing never throws and only yields 32-byte keys (seed ${SEED})`, () => {
    const r = rng(SEED + 5);
    for (let i = 0; i < ITERATIONS; i++) {
      const id = r.chars('abcXYZ019_-'.split(''), 10, 6);
      const key = r.chars('abcXYZ019_-+/='.split(''), 46, 40);
      const url = r.chance(0.3)
        ? junk(r, 60)
        : `https://${r.pick(['mega.nz', 'mega.io', 'www.mega.nz', 'evil.mega.nz', 'mega.nz.evil'])}/${r.pick([`file/${id}#${key}`, `#!${id}!${key}`, `folder/${id}#${key}`])}`;
      let parsed;
      expect(() => (parsed = parseMegaUrl(url))).not.toThrow();
      if (!parsed) continue;
      const why = describeCase(SEED, i, url);
      expect([why, parsed.key.length]).toEqual([why, 32]);
      expect([why, /^[\w-]{8}$/.test(parsed.id)]).toEqual([why, true]);
      expect(() => megaKeys(parsed.key)).not.toThrow();
    }
  });
});
