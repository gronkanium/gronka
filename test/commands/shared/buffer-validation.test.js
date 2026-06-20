import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  validateVideoBuffer,
  validateGifBuffer,
  writeValidatedFileBuffer,
} from '../../../src/commands/shared/buffer-validation.js';
import { ValidationError } from '../../../src/utils/errors.js';

// Helpers to build minimal valid headers
const gif89a = () => Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(4)]);
const gif87a = () => Buffer.concat([Buffer.from('GIF87a'), Buffer.alloc(4)]);
const mp4 = () =>
  Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from('mp42')]);
const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(8)]);

const tmpFiles = [];
after(async () => {
  await Promise.all(tmpFiles.map(f => fs.unlink(f).catch(() => {})));
});

describe('shared/buffer-validation', () => {
  describe('validateGifBuffer', () => {
    test('accepts GIF89a and GIF87a', () => {
      assert.strictEqual(validateGifBuffer(gif89a()), true);
      assert.strictEqual(validateGifBuffer(gif87a()), true);
    });
    test('rejects non-GIF signature', () => {
      assert.throws(() => validateGifBuffer(Buffer.from('NOTGIF')), ValidationError);
    });
    test('rejects empty/too-small buffer', () => {
      assert.throws(() => validateGifBuffer(Buffer.alloc(0)), ValidationError);
      assert.throws(() => validateGifBuffer(Buffer.from('GIF')), ValidationError);
    });
  });

  describe('validateVideoBuffer', () => {
    test('accepts MP4 (ftyp at offset 4) and WebM', () => {
      assert.strictEqual(validateVideoBuffer(mp4()), true);
      assert.strictEqual(validateVideoBuffer(webm()), true);
    });
    test('rejects unknown signature', () => {
      assert.throws(() => validateVideoBuffer(Buffer.alloc(12, 0x42)), ValidationError);
    });
    test('rejects empty/too-small buffer', () => {
      assert.throws(() => validateVideoBuffer(Buffer.alloc(0)), ValidationError);
      assert.throws(() => validateVideoBuffer(Buffer.alloc(8)), ValidationError);
    });
  });

  describe('writeValidatedFileBuffer', () => {
    test('writes a valid gif', async () => {
      const p = path.join(os.tmpdir(), `bv-test-${Date.now()}.gif`);
      tmpFiles.push(p);
      await writeValidatedFileBuffer(p, gif89a(), 'gif');
      const written = await fs.readFile(p);
      assert.ok(written.equals(gif89a()));
    });
    test('writes a valid video', async () => {
      const p = path.join(os.tmpdir(), `bv-test-${Date.now()}.mp4`);
      tmpFiles.push(p);
      await writeValidatedFileBuffer(p, mp4(), 'video');
      assert.ok((await fs.readFile(p)).equals(mp4()));
    });
    test('writes images without signature validation', async () => {
      const p = path.join(os.tmpdir(), `bv-test-${Date.now()}.jpg`);
      tmpFiles.push(p);
      await writeValidatedFileBuffer(p, Buffer.from('anything'), 'image');
      assert.ok((await fs.readFile(p)).equals(Buffer.from('anything')));
    });
    test('rejects an invalid gif before writing', async () => {
      const p = path.join(os.tmpdir(), `bv-test-invalid-${Date.now()}.gif`);
      await assert.rejects(
        () => writeValidatedFileBuffer(p, Buffer.from('NOTGIF'), 'gif'),
        ValidationError
      );
      await assert.rejects(() => fs.access(p)); // file must not exist
    });
  });
});
