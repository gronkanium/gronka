import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { validateMediaFile } from '../../../src/commands/shared/media-validation.js';
import { ValidationError } from '../../../src/utils/errors.js';

const file = (head, size = head.length) => ({ head, size });
const gif89a = () => Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(4)]);
const gif87a = () => Buffer.concat([Buffer.from('GIF87a'), Buffer.alloc(4)]);
const mp4 = () =>
  Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from('mp42')]);
const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(8)]);

describe('shared/media-validation', () => {
  test('accepts GIF89a and GIF87a', () => {
    assert.ok(validateMediaFile(file(gif89a()), 'gif'));
    assert.ok(validateMediaFile(file(gif87a()), 'gif'));
  });
  test('rejects a non-GIF signature', () => {
    assert.throws(() => validateMediaFile(file(Buffer.from('NOTGIF')), 'gif'), ValidationError);
  });
  test('rejects an empty or too-small gif', () => {
    assert.throws(() => validateMediaFile(file(Buffer.alloc(0)), 'gif'), ValidationError);
    assert.throws(() => validateMediaFile(file(Buffer.from('GIF')), 'gif'), ValidationError);
  });
  test('rejects a gif over the size limit', () => {
    assert.throws(() => validateMediaFile(file(gif89a(), 1e12), 'gif'), ValidationError);
  });
  test('accepts MP4 (ftyp at offset 4) and WebM', () => {
    assert.ok(validateMediaFile(file(mp4()), 'video'));
    assert.ok(validateMediaFile(file(webm()), 'video'));
  });
  test('rejects an unknown video signature', () => {
    assert.throws(() => validateMediaFile(file(Buffer.alloc(12, 0x42)), 'video'), ValidationError);
  });
  test('rejects an empty or too-small video', () => {
    assert.throws(() => validateMediaFile(file(Buffer.alloc(0)), 'video'), ValidationError);
    assert.throws(() => validateMediaFile(file(Buffer.alloc(8)), 'video'), ValidationError);
  });
  test('passes images through (validated by extension upstream)', () => {
    assert.ok(validateMediaFile(file(Buffer.alloc(0)), 'image'));
  });
});
