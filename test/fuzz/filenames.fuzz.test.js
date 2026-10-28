import { test, describe, expect } from 'bun:test';
import path from 'node:path';
import { sanitizeFilename, validateFileExtension } from '../../src/utils/validation.js';
import { contentDisposition, directStreamInfo } from '../../src/web-server.js';
import { tempPath, withJobDir, JOBS_ROOT } from '../../src/utils/media-file.js';
import { writeZip } from '../../src/utils/archive.js';
import { rng, junk, SEED, ITERATIONS, describeCase, NASTY, CONTROL } from './rng.js';

const JAIL = '/jail';
const escapes = name => !path.resolve(JAIL, name).startsWith(`${JAIL}/`);
// eslint-disable-next-line no-control-regex
const hasControl = s => /[\x00-\x1f\x7f-\x9f]/.test(s);

describe('filename fuzz', () => {
  test(`sanitizeFilename output is one safe path segment (seed ${SEED})`, () => {
    const r = rng(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const input = r.chance(0.3)
        ? r.pick([
            null,
            undefined,
            42,
            {},
            [],
            '',
            ' ',
            '.',
            '..',
            '...',
            '/',
            '\\',
            '..\\..\\x',
            '../../etc/passwd',
          ])
        : junk(r, 400);
      let out;
      expect(() => (out = sanitizeFilename(input))).not.toThrow();
      const why = describeCase(SEED, i, input);
      expect([why, typeof out]).toEqual([why, 'string']);
      expect([why, out.length > 0 && out.length <= 255]).toEqual([why, true]);
      expect([why, out.includes('/') || out.includes('\\')]).toEqual([why, false]);
      expect([why, hasControl(out)]).toEqual([why, false]);
      expect([why, /^[.\s]/.test(out)]).toEqual([why, false]);
      expect([why, out === '.' || out === '..']).toEqual([why, false]);
      expect([why, path.basename(out)]).toEqual([why, out]);
      expect([why, escapes(out)]).toEqual([why, false]);
    }
  });

  test(`contentDisposition is one header line that parses back to the name (seed ${SEED})`, () => {
    const r = rng(SEED + 1);
    for (let i = 0; i < ITERATIONS; i++) {
      const name = sanitizeFilename(junk(r, 300));
      let header;
      expect(() => (header = contentDisposition(name))).not.toThrow();
      const why = describeCase(SEED, i, name);
      // eslint-disable-next-line no-control-regex
      expect([why, /[\r\n\x00]/.test(header)]).toEqual([why, false]);
      const match = header.match(
        /^attachment; filename="([\x20-\x7e]*)"; filename\*=UTF-8''([A-Za-z0-9%!'()*._~-]*)$/
      );
      expect([why, !!match]).toEqual([why, true]);
      expect([why, match[1].includes('"')]).toEqual([why, false]);
      let decoded;
      expect(() => (decoded = decodeURIComponent(match[2]))).not.toThrow();
      expect([why, decoded]).toEqual([why, name]);
    }
  });

  test(`tempPath keeps every extension inside the job dir as one hex name (seed ${SEED})`, async () => {
    const r = rng(SEED + 2);
    await withJobDir(async () => {
      const dir = path.dirname(await tempPath());
      expect(dir.startsWith(JOBS_ROOT)).toBe(true);
      for (let i = 0; i < ITERATIONS; i++) {
        const ext = r.chance(0.3) ? `.${r.chars('abcxyz0129'.split(''), 6, 1)}` : junk(r, 20);
        const out = await tempPath(ext);
        const why = describeCase(SEED, i, ext);
        expect([why, path.dirname(out)]).toEqual([why, dir]);
        expect([why, /^[0-9a-f]{16}(\.[a-z0-9]{1,5})?$/.test(path.basename(out))]).toEqual([
          why,
          true,
        ]);
      }
    });
  });

  test(`validateFileExtension never throws and only matches the listed extensions (seed ${SEED})`, () => {
    const r = rng(SEED + 3);
    const allowed = ['mp4', '.gif', 'png'];
    for (let i = 0; i < ITERATIONS; i++) {
      const name = junk(r, 80);
      let ok;
      expect(() => (ok = validateFileExtension(name, allowed))).not.toThrow();
      const ext = path.extname(name).toLowerCase().slice(1);
      expect([describeCase(SEED, i, name), ok]).toEqual([
        describeCase(SEED, i, name),
        ['mp4', 'gif', 'png'].includes(ext),
      ]);
    }
  });

  test(`directStreamInfo never throws on a hostile path (seed ${SEED})`, () => {
    const r = rng(SEED + 4);
    for (let i = 0; i < ITERATIONS; i++) {
      const url = `https://cdn.example/${r.chars([...NASTY, ...CONTROL, 'a', '.', '%', '%2', '%zz', '%E0%A4%A'], 40)}`;
      let info;
      try {
        info = directStreamInfo(url);
      } catch (error) {
        throw new Error(
          `directStreamInfo threw on ${describeCase(SEED, i, url)}: ${error.message}`,
          { cause: error }
        );
      }
      expect(typeof info.title).toBe('string');
      expect(typeof info.ext === 'string' && info.ext.length > 0 && !info.ext.includes('/')).toBe(
        true
      );
    }
  });

  test(`writeZip entry names are flat ascii and never collide (seed ${SEED})`, async () => {
    const r = rng(SEED + 5);
    await withJobDir(async () => {
      const file = await tempPath('.bin');
      await Bun.write(file, 'x');
      const files = Array.from({ length: 12 }, () => ({
        path: file,
        size: 1,
        filename: r.chance(0.5) ? junk(r, 300) : 'a.mp4',
      }));
      const zip = await writeZip(files, 'out.zip');
      const bytes = new Uint8Array(await Bun.file(zip.path).arrayBuffer());
      const names = [];
      for (let at = 0; at + 30 <= bytes.length;) {
        const view = new DataView(bytes.buffer, at);
        if (view.getUint32(0, true) !== 0x04034b50) break;
        const nameLength = view.getUint16(26, true);
        const size = view.getUint32(18, true);
        names.push(Buffer.from(bytes.subarray(at + 30, at + 30 + nameLength)).toString());
        at += 30 + nameLength + size;
      }
      expect(names.length).toBe(12);
      expect(new Set(names).size).toBe(12);
      for (const name of names) {
        expect([name, /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,239}$/.test(name)]).toEqual([name, true]);
      }
    });
  });
});
