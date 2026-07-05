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

  const X_MIRROR_HOSTS = [
    'fxtwitter.com',
    'fixupx.com',
    'twittpr.com',
    'pxtwitter.com',
    'vxtwitter.com',
    'fixvx.com',
    'cunnyx.com',
    'girlcockx.com',
    'stupidpenisx.com',
  ];

  test('isSocialMediaUrl recognizes embed-fixer mirror URLs', () => {
    for (const host of X_MIRROR_HOSTS) {
      assert.strictEqual(isSocialMediaUrl(`https://${host}/user/status/1234567890`), true);
      assert.strictEqual(isSocialMediaUrl(`https://www.${host}/user/status/1234567890`), true);
    }
    assert.strictEqual(
      isSocialMediaUrl('https://fxbsky.app/profile/user.bsky.social/post/abc'),
      true
    );
    assert.strictEqual(
      isSocialMediaUrl('https://bsky.app/profile/user.bsky.social/post/abc'),
      true
    );
  });

  test('normalizeSocialMediaUrlForCobalt rewrites X mirror status URLs to twitter.com', () => {
    for (const host of X_MIRROR_HOSTS) {
      const normalized = normalizeSocialMediaUrlForCobalt(
        `https://${host}/user/status/1234567890?s=46`
      );
      assert.strictEqual(normalized, 'https://twitter.com/user/status/1234567890');

      const normalizedWww = normalizeSocialMediaUrlForCobalt(
        `https://www.${host}/user/status/1234567890`
      );
      assert.strictEqual(normalizedWww, 'https://twitter.com/user/status/1234567890');
    }
  });

  test('normalizeSocialMediaUrlForCobalt rewrites mirror hosts even for non-status paths', () => {
    const input = 'https://cunnyx.com/user/status/1234567890/photo/1';
    const normalized = normalizeSocialMediaUrlForCobalt(input);

    assert.strictEqual(normalized, 'https://twitter.com/user/status/1234567890/photo/1');
  });

  test('normalizeSocialMediaUrlForCobalt rewrites fxbsky.app to bsky.app', () => {
    const input = 'https://fxbsky.app/profile/user.bsky.social/post/3kabc123';
    const normalized = normalizeSocialMediaUrlForCobalt(input);

    assert.strictEqual(normalized, 'https://bsky.app/profile/user.bsky.social/post/3kabc123');
  });

  test('normalizeSocialMediaUrlForCobalt leaves unrelated URLs unchanged', () => {
    const input = 'https://reddit.com/r/test/comments/abc123/example';
    const normalized = normalizeSocialMediaUrlForCobalt(input);

    assert.strictEqual(normalized, input);
  });
});
