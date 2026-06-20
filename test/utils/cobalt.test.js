import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isSocialMediaUrl, normalizeSocialMediaUrlForCobalt } from '../../src/utils/cobalt.js';

describe('cobalt utilities', () => {
  test('isSocialMediaUrl recognizes x.com URLs', () => {
    assert.strictEqual(isSocialMediaUrl('https://x.com/user/status/1234567890'), true);
  });

  test('normalizeSocialMediaUrlForCobalt strips X share params from status URLs', () => {
    const input = 'https://x.com/neetyboyfriend/status/2044473679753425120?s=46&t=test#fragment';
    const normalized = normalizeSocialMediaUrlForCobalt(input);

    assert.strictEqual(normalized, 'https://twitter.com/neetyboyfriend/status/2044473679753425120');
  });

  test('normalizeSocialMediaUrlForCobalt preserves non-tracking params', () => {
    const input = 'https://twitter.com/user/status/1234567890?lang=en&s=46';
    const normalized = normalizeSocialMediaUrlForCobalt(input);

    assert.strictEqual(normalized, 'https://twitter.com/user/status/1234567890?lang=en');
  });

  test('normalizeSocialMediaUrlForCobalt leaves unrelated URLs unchanged', () => {
    const input = 'https://reddit.com/r/test/comments/abc123/example';
    const normalized = normalizeSocialMediaUrlForCobalt(input);

    assert.strictEqual(normalized, input);
  });
});
