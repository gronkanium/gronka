import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { isGifFile } from '../../src/utils/gif-optimizer.js';

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
});
