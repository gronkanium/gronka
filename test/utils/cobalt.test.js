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

  test('isSocialMediaUrl rejects pinterest URLs (intentionally unsupported)', () => {
    // Pinterest downloading is dead end-to-end (Cobalt returns empty; yt-dlp's extractor has
    // been broken since ~2025-06). Removed from the supported list so users get an honest
    // "unsupported platform" message instead of a misleading "deleted/private" error.
    assert.strictEqual(isSocialMediaUrl('https://www.pinterest.com/pin/10203885745577880/'), false);
    assert.strictEqual(isSocialMediaUrl('https://pinterest.com/pin/10203885745577880/'), false);
    assert.strictEqual(isSocialMediaUrl('https://pin.it/abc123'), false);
  });

  test('isSocialMediaUrl recognizes twitch clip URLs', () => {
    assert.strictEqual(isSocialMediaUrl('https://clips.twitch.tv/SomeClipSlug'), true);
    assert.strictEqual(
      isSocialMediaUrl('https://www.twitch.tv/somechannel/clip/SomeClipSlug'),
      true
    );
  });

  test('isSocialMediaUrl recognizes additional cobalt platforms', () => {
    assert.strictEqual(isSocialMediaUrl('https://soundcloud.com/artist/track'), true);
    assert.strictEqual(isSocialMediaUrl('https://on.soundcloud.com/abc123'), true);
    assert.strictEqual(isSocialMediaUrl('https://someblog.tumblr.com/post/123/slug'), true);
    assert.strictEqual(isSocialMediaUrl('https://streamable.com/abc12'), true);
    assert.strictEqual(isSocialMediaUrl('https://www.dailymotion.com/video/x123abc'), true);
    assert.strictEqual(isSocialMediaUrl('https://dai.ly/x123abc'), true);
    assert.strictEqual(isSocialMediaUrl('https://t.snapchat.com/abc123'), true);
  });

  test('isSocialMediaUrl rejects removed/unsupported threads URLs', () => {
    assert.strictEqual(isSocialMediaUrl('https://www.threads.net/@user/post/abc'), false);
  });

  test('normalizeSocialMediaUrlForCobalt leaves unrelated URLs unchanged', () => {
    const input = 'https://reddit.com/r/test/comments/abc123/example';
    const normalized = normalizeSocialMediaUrlForCobalt(input);

    assert.strictEqual(normalized, input);
  });
});
