import { describe, test } from 'bun:test';
import assert from 'node:assert';
import {
  isInstagramPostUrl,
  shortcodeToMediaId,
  selectMediaUrl,
} from '../../src/utils/instagram.js';

const image = url => ({ image_versions2: { candidates: [{ url }, { url: `${url}?small` }] } });
const video = url => ({
  ...image('https://scontent.cdninstagram.com/still.jpg'),
  video_versions: [{ url }],
});

describe('instagram utilities', () => {
  test('isInstagramPostUrl recognizes every post permalink shape', () => {
    assert.strictEqual(isInstagramPostUrl('https://www.instagram.com/p/DbzojBsOC6p/'), true);
    assert.strictEqual(isInstagramPostUrl('https://instagram.com/reel/DbfuznPzy5r/'), true);
    assert.strictEqual(isInstagramPostUrl('https://www.instagram.com/reels/DbfuznPzy5r/'), true);
    assert.strictEqual(isInstagramPostUrl('https://www.instagram.com/tv/CPESdZpl7MD/'), true);
    // the share sheet's igsh / img_index querystrings must not defeat the match
    assert.strictEqual(
      isInstagramPostUrl('https://www.instagram.com/p/DbOHz1IEw4g/?img_index=1&igsh=MWJ1'),
      true
    );
  });

  test('isInstagramPostUrl rejects profiles, stories, and lookalike hosts', () => {
    assert.strictEqual(isInstagramPostUrl('https://www.instagram.com/someuser/'), false);
    assert.strictEqual(
      isInstagramPostUrl('https://www.instagram.com/stories/someuser/123/'),
      false
    );
    assert.strictEqual(isInstagramPostUrl('https://www.instagram.com/'), false);
    assert.strictEqual(isInstagramPostUrl('https://instagram.com.evil.com/p/abc/'), false);
    assert.strictEqual(isInstagramPostUrl('not a url'), false);
  });

  test('shortcodeToMediaId decodes the base64 shortcode alphabet', () => {
    // verified against the live api: these ids are what /api/v1/media/<id>/info/ answers to
    assert.strictEqual(shortcodeToMediaId('DbzojBsOC6p'), '3959686826246549161');
    assert.strictEqual(shortcodeToMediaId('CPESdZpl7MD'), '2577266072006144771');
    assert.strictEqual(shortcodeToMediaId('!!bad!!'), null);
    assert.strictEqual(shortcodeToMediaId(''), null);
  });

  test('selectMediaUrl takes the first (highest quality) candidate', () => {
    assert.strictEqual(
      selectMediaUrl(image('https://scontent.cdninstagram.com/big.jpg')),
      'https://scontent.cdninstagram.com/big.jpg'
    );
  });

  test("selectMediaUrl prefers the video over a video item's own still frame", () => {
    assert.strictEqual(
      selectMediaUrl(video('https://scontent.cdninstagram.com/clip.mp4')),
      'https://scontent.cdninstagram.com/clip.mp4'
    );
  });

  test('selectMediaUrl honours a 1-based img_index into a carousel', () => {
    const carousel = {
      carousel_media: [
        image('https://scontent.cdninstagram.com/one.jpg'),
        image('https://scontent.cdninstagram.com/two.jpg'),
      ],
    };
    assert.strictEqual(selectMediaUrl(carousel, 2), 'https://scontent.cdninstagram.com/two.jpg');
    // no index, or an index past the end, falls back to the first slide
    assert.strictEqual(selectMediaUrl(carousel, null), 'https://scontent.cdninstagram.com/one.jpg');
    assert.strictEqual(selectMediaUrl(carousel, 9), 'https://scontent.cdninstagram.com/one.jpg');
    assert.strictEqual(selectMediaUrl(carousel, 0), 'https://scontent.cdninstagram.com/one.jpg');
  });

  test('selectMediaUrl refuses media hosted off the instagram CDN', () => {
    assert.strictEqual(selectMediaUrl(image('https://evil.example.com/x.jpg')), null);
    // an off-CDN video url is dropped, leaving the (host-checked) still frame
    assert.strictEqual(
      selectMediaUrl(video('https://evil.example.com/x.mp4')),
      'https://scontent.cdninstagram.com/still.jpg'
    );
    assert.strictEqual(selectMediaUrl({}), null);
    assert.strictEqual(selectMediaUrl(null), null);
  });
});
