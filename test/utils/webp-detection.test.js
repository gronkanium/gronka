import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { isAnimatedWebp } from '../../src/utils/video-processor.js';

function webpHeader(formType, flags = 0x00) {
  const buf = Buffer.alloc(32);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(24, 4); // file size (arbitrary)
  buf.write('WEBP', 8, 'ascii');
  buf.write(formType, 12, 'ascii');
  buf.writeUInt32LE(10, 16); // VP8X chunk size
  buf[20] = flags;
  return buf;
}

describe('isAnimatedWebp', () => {
  test('returns true for a VP8X header with the animation flag set', () => {
    // 0x12 = alpha (0x10) | animation (0x02) — the byte observed on the real asset
    assert.strictEqual(isAnimatedWebp(webpHeader('VP8X', 0x12)), true);
  });

  test('returns true when only the animation bit is set', () => {
    assert.strictEqual(isAnimatedWebp(webpHeader('VP8X', 0x02)), true);
  });

  test('returns false for extended WebP without the animation flag', () => {
    // alpha-only, no animation
    assert.strictEqual(isAnimatedWebp(webpHeader('VP8X', 0x10)), false);
  });

  test('returns false for a static lossy WebP (VP8 )', () => {
    assert.strictEqual(isAnimatedWebp(webpHeader('VP8 ')), false);
  });

  test('returns false for a static lossless WebP (VP8L)', () => {
    assert.strictEqual(isAnimatedWebp(webpHeader('VP8L')), false);
  });

  test('returns false for a non-WebP RIFF container', () => {
    const buf = webpHeader('VP8X', 0x02);
    buf.write('AVI ', 8, 'ascii'); // wrong form type
    assert.strictEqual(isAnimatedWebp(buf), false);
  });

  test('returns false for a PNG signature', () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    assert.strictEqual(isAnimatedWebp(png), false);
  });

  test('returns false for a buffer shorter than the header', () => {
    assert.strictEqual(isAnimatedWebp(Buffer.from('RIFF')), false);
  });

  test('returns false for non-Buffer input', () => {
    assert.strictEqual(isAnimatedWebp(null), false);
    assert.strictEqual(isAnimatedWebp(undefined), false);
    assert.strictEqual(isAnimatedWebp('RIFF....WEBPVP8X'), false);
  });
});
