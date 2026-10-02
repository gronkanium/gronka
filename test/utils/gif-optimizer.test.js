import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { isGifFile, calculateSizeReduction } from '../../src/utils/gif-optimizer.js';

describe('gif optimizer utilities', () => {
  describe('isGifFile', () => {
    test('detects GIF from extension', () => {
      assert.strictEqual(isGifFile('file.gif', ''), true);
      assert.strictEqual(isGifFile('file.GIF', ''), true);
      assert.strictEqual(isGifFile('path/to/file.gif', ''), true);
    });

    test('detects GIF from content type', () => {
      assert.strictEqual(isGifFile('file.txt', 'image/gif'), true);
      assert.strictEqual(isGifFile('file.unknown', 'image/gif'), true);
      assert.strictEqual(isGifFile('', 'image/gif'), true);
    });

    test('returns false for non-GIF files', () => {
      assert.strictEqual(isGifFile('file.png', ''), false);
      assert.strictEqual(isGifFile('file.jpg', ''), false);
      assert.strictEqual(isGifFile('file.mp4', ''), false);
      // Extension wins - if extension is .gif, it returns true even with wrong content type
      assert.strictEqual(isGifFile('file.gif', 'image/png'), true);
    });

    test('returns true if either extension or content type matches', () => {
      assert.strictEqual(isGifFile('file.gif', 'image/png'), true); // Extension wins
      assert.strictEqual(isGifFile('file.png', 'image/gif'), true); // Content type wins
    });
  });

  describe('calculateSizeReduction', () => {
    test('calculates correct reduction percentage', () => {
      assert.strictEqual(calculateSizeReduction(1000, 500), 50);
      assert.strictEqual(calculateSizeReduction(1000, 750), 25);
      assert.strictEqual(calculateSizeReduction(1000, 900), 10);
      assert.strictEqual(calculateSizeReduction(1000, 1000), 0);
    });

    test('returns negative for file growth', () => {
      assert.strictEqual(calculateSizeReduction(1000, 1100), -10);
      assert.strictEqual(calculateSizeReduction(1000, 1500), -50);
    });

    test('handles zero original size', () => {
      assert.strictEqual(calculateSizeReduction(0, 100), 0);
      assert.strictEqual(calculateSizeReduction(0, 0), 0);
    });

    test('rounds to nearest integer', () => {
      assert.strictEqual(calculateSizeReduction(1000, 666), 33); // 33.4% rounds to 33
      assert.strictEqual(calculateSizeReduction(1000, 667), 33); // 33.3% rounds to 33
      assert.strictEqual(calculateSizeReduction(1000, 665), 34); // 33.5% rounds to 34
    });
  });
});
