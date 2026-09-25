import { describe, test, beforeAll } from 'bun:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { convertToFormat, OUTPUT_FORMATS } from '../../src/utils/video-processor.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gronka-fmt-test-'));
let clip;
let silent;

beforeAll(() => {
  const make = (name, inputs) => {
    const out = path.join(dir, name);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...inputs, '-c:v', 'libx264', out]);
    return fs.readFileSync(out);
  };
  clip = make('clip.mp4', [
    '-f',
    'lavfi',
    '-i',
    'testsrc=d=2:s=160x120',
    '-f',
    'lavfi',
    '-i',
    'sine=d=2',
    '-shortest',
  ]);
  silent = make('silent.mp4', ['-f', 'lavfi', '-i', 'testsrc=d=1:s=160x120']);
});

const MAGIC = {
  mp4: b => b.subarray(4, 8).toString() === 'ftyp',
  m4a: b => b.subarray(4, 8).toString() === 'ftyp',
  webm: b => b.readUInt32BE(0) === 0x1a45dfa3,
  mp3: b => b.subarray(0, 3).toString() === 'ID3' || b[0] === 0xff,
  ogg: b => b.subarray(0, 4).toString() === 'OggS',
  wav: b => b.subarray(0, 4).toString() === 'RIFF',
  flac: b => b.subarray(0, 4).toString() === 'fLaC',
  png: b => b.subarray(1, 4).toString() === 'PNG',
  jpg: b => b[0] === 0xff && b[1] === 0xd8,
  webp: b => b.subarray(8, 12).toString() === 'WEBP',
};

describe('convertToFormat', () => {
  test('every listed format has a magic-byte check here', () => {
    assert.deepStrictEqual(Object.keys(OUTPUT_FORMATS).sort(), Object.keys(MAGIC).sort());
  });

  for (const format of Object.keys(MAGIC)) {
    test(`turns an mp4 into ${format}`, async () => {
      const out = await convertToFormat(clip, '.mp4', format);
      assert.ok(MAGIC[format](out), `${format} output has the wrong signature`);
    }, 60000);
  }

  test('trims before converting', async () => {
    const full = await convertToFormat(clip, '.mp4', 'wav');
    const half = await convertToFormat(clip, '.mp4', 'wav', { startTime: 1, duration: 0.5 });
    assert.ok(half.length < full.length / 2);
  });

  test('says so when asked for audio from a silent video', async () => {
    await assert.rejects(convertToFormat(silent, '.mp4', 'mp3'), /no audio to extract/);
  });

  test('rejects formats outside the list', async () => {
    await assert.rejects(convertToFormat(clip, '.mp4', 'exe'), /not supported/);
  });
});
