import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { hashUrl, hashUrlWithParams } from '../../src/utils/hashing.js';

describe('hashUrl', () => {
  test('generates a consistent hash for the same URL', () => {
    const url = 'https://example.com/video.mp4';
    const hash1 = hashUrl(url);
    const hash2 = hashUrl(url);

    assert.strictEqual(hash1, hash2, 'Same URL should produce same hash');
    assert.strictEqual(typeof hash1, 'string', 'Hash should be a string');
    assert.strictEqual(hash1.length, 64, 'Hash should be 64 hex characters');
  });

  test('generates different hashes for different URLs', () => {
    const hash1 = hashUrl('https://example.com/video1.mp4');
    const hash2 = hashUrl('https://example.com/video2.mp4');

    assert.notStrictEqual(hash1, hash2, 'Different URLs should produce different hashes');
  });

  test('treats query parameters as significant', () => {
    const hash1 = hashUrl('https://x.com/user/status/123');
    const hash2 = hashUrl('https://x.com/user/status/123?s=46');

    assert.notStrictEqual(
      hash1,
      hash2,
      'URLs with different query parameters should produce different hashes'
    );
  });

  test('generates a valid hex hash', () => {
    assert.ok(/^[a-f0-9]{64}$/.test(hashUrl('https://example.com/test')));
  });
});

describe('hashUrlWithParams', () => {
  const url = 'https://example.com/video.mp4';

  test('falls back to the URL-only hash when no options are given', () => {
    assert.strictEqual(hashUrlWithParams(url), hashUrl(url));
    assert.strictEqual(hashUrlWithParams(url, {}), hashUrl(url));
  });

  test('ignores undefined and null options', () => {
    // A caller passing "no width requested" must hit the same cache entry as one passing nothing.
    assert.strictEqual(hashUrlWithParams(url, { width: undefined, fps: null }), hashUrl(url));
  });

  test('differs from the URL-only hash once an option is set', () => {
    assert.notStrictEqual(hashUrlWithParams(url, { width: 640 }), hashUrl(url));
  });

  test('is stable regardless of option key order', () => {
    const a = hashUrlWithParams(url, { width: 640, fps: 20, lossy: 35 });
    const b = hashUrlWithParams(url, { lossy: 35, width: 640, fps: 20 });

    assert.strictEqual(a, b, 'key order must not change the cache key');
  });

  test('distinguishes different option values', () => {
    // Cache keys must not collide across conversions that produce different output.
    assert.notStrictEqual(
      hashUrlWithParams(url, { width: 640 }),
      hashUrlWithParams(url, { width: 1024 })
    );
    assert.notStrictEqual(
      hashUrlWithParams(url, { fps: 20 }),
      hashUrlWithParams(url, { width: 20 })
    );
  });

  test('distinguishes different URLs carrying the same options', () => {
    const options = { width: 640, fps: 20 };
    assert.notStrictEqual(
      hashUrlWithParams('https://example.com/a.mp4', options),
      hashUrlWithParams('https://example.com/b.mp4', options)
    );
  });
});
