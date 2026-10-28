import { test, describe, expect, beforeAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withJobDir, tempPath, JOBS_ROOT } from '../../src/utils/media-file.js';
import { getVideoMetadata } from '../../src/utils/video-processor/metadata.js';
import { convertToGif } from '../../src/utils/video-processor/convert-to-gif.js';
import { convertToFormat } from '../../src/utils/video-processor/convert-format.js';
import { trimVideo } from '../../src/utils/video-processor/trim-video.js';
import { trimGif } from '../../src/utils/video-processor/trim-gif.js';
import { AppError } from '../../src/utils/errors.js';
import { rng, SEED, ITERATIONS, describeCase } from './rng.js';

// Minutes of ffmpeg per run: opt in with FUZZ_MEDIA=1 bun run test:fuzz
const enabled = !!process.env.FUZZ_MEDIA;
const ROUNDS = Math.max(1, Math.floor(ITERATIONS / 25));
const STEP_MS = 20_000;

const originals = {};

function render(file, args) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args, file]);
}

async function corrupt(r, bytes) {
  const out = Buffer.from(bytes);
  const how = r.pick(['flip', 'flip', 'zero', 'truncate', 'splice', 'header', 'grow']);
  if (how === 'flip') {
    for (let n = r.int(64, 1); n > 0; n--) out[r.int(out.length)] ^= 1 << r.int(8);
    return out;
  }
  if (how === 'zero') {
    const at = r.int(out.length);
    out.fill(0, at, Math.min(out.length, at + r.int(4096, 1)));
    return out;
  }
  if (how === 'truncate') return out.subarray(0, r.int(out.length, 1));
  if (how === 'splice') {
    const a = r.int(out.length);
    const b = r.int(out.length);
    return Buffer.concat([out.subarray(0, a), out.subarray(b)]);
  }
  if (how === 'header') {
    for (let i = 0; i < Math.min(64, out.length); i++) if (r.chance(0.3)) out[i] = r.int(256);
    return out;
  }
  return Buffer.concat([out, Buffer.alloc(r.int(1 << 16), r.int(256))]);
}

const within = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`hung for ${ms}ms`)), ms)),
  ]);

describe.skipIf(!enabled)('media fuzz', () => {
  beforeAll(async () => {
    await withJobDir(async () => {
      const mp4 = await tempPath('.mp4');
      render(mp4, [
        '-f',
        'lavfi',
        '-i',
        'testsrc=d=1:s=96x64',
        '-f',
        'lavfi',
        '-i',
        'sine=d=1',
        '-shortest',
      ]);
      const gif = await tempPath('.gif');
      render(gif, ['-f', 'lavfi', '-i', 'testsrc=d=1:s=48x32:r=5']);
      const mp3 = await tempPath('.mp3');
      render(mp3, ['-f', 'lavfi', '-i', 'sine=d=1']);
      const png = await tempPath('.png');
      render(png, ['-f', 'lavfi', '-i', 'testsrc=d=1:s=48x32', '-frames:v', '1']);
      for (const [ext, file] of Object.entries({ mp4, gif, mp3, png })) {
        originals[ext] = await fs.readFile(file);
      }
    });
  });

  test(`corrupted media never hangs, escapes the job dir or throws a raw error past the processor (seed ${SEED}, ${ROUNDS} rounds)`, async () => {
    const r = rng(SEED);
    for (let i = 0; i < ROUNDS; i++) {
      const ext = r.pick(Object.keys(originals));
      const bytes = await corrupt(r, originals[ext]);
      const why = describeCase(SEED, i, { ext, size: bytes.length });
      await withJobDir(async () => {
        const dir = path.dirname(await tempPath());
        const input = await tempPath(`.${ext}`);
        await fs.writeFile(input, bytes);
        const steps = [
          () => getVideoMetadata(input),
          () => convertToGif(input, path.join(dir, 'out.gif'), { width: 48, fps: 5, duration: 1 }),
          () =>
            convertToFormat({ path: input, filename: `in.${ext}` }, r.pick(['mp4', 'mp3', 'webm'])),
          () => trimVideo(input, path.join(dir, 'cut.mp4'), { startTime: 0.2, duration: 0.5 }),
          () => trimGif(input, path.join(dir, 'cut.gif'), { startTime: 0.2, duration: 0.5 }),
        ];
        for (const step of steps) {
          try {
            await within(step(), STEP_MS);
          } catch (error) {
            const message = String(error?.message ?? error);
            expect([why, message.startsWith('hung for')]).toEqual([why, false]);
            // Non-AppError failures are allowed here, but they must be an Error the caller can curate.
            expect([why, error instanceof Error || error instanceof AppError]).toEqual([why, true]);
          }
        }
        const written = await fs.readdir(dir);
        expect([why, written.every(name => !name.includes('..') && !name.includes('/'))]).toEqual([
          why,
          true,
        ]);
      });
      const stray = (await fs.readdir(JOBS_ROOT).catch(() => [])).filter(name =>
        name.includes('..')
      );
      expect([why, stray]).toEqual([why, []]);
    }
  });
});
