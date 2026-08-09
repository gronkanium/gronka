import { describe, test } from 'bun:test';
import assert from 'node:assert';
import { isPinterestUrl, extractMediaUrl } from '../../src/utils/pinterest.js';

const videoLd = url =>
  `<script type="application/ld+json">{"@type":"VideoObject","@context":"http://schema.org/","name":"zamnn","contentUrl":"${url}","duration":"PT15S"}</script>`;

const postingLd = image =>
  `<script type="application/ld+json">{"@type":"SocialMediaPosting","@context":"http://schema.org/","headline":"x","image":"${image}"}</script>`;

describe('pinterest utilities', () => {
  test('isPinterestUrl recognizes pin pages, regional hosts, and pin.it links', () => {
    assert.strictEqual(isPinterestUrl('https://www.pinterest.com/pin/663225482638937262/'), true);
    assert.strictEqual(isPinterestUrl('https://it.pinterest.com/pin/1101411652644676940/'), true);
    assert.strictEqual(isPinterestUrl('https://pinterest.co.uk/pin/123/'), true);
    // share links carry the invite querystring and a /sent/ suffix
    assert.strictEqual(
      isPinterestUrl('https://www.pinterest.com/pin/123/sent/?invite_code=a'),
      true
    );
    assert.strictEqual(isPinterestUrl('https://pin.it/3v9aYm5zT'), true);
  });

  test('isPinterestUrl rejects non-pin pages and lookalike hosts', () => {
    assert.strictEqual(isPinterestUrl('https://www.pinterest.com/somebody/some-board/'), false);
    assert.strictEqual(isPinterestUrl('https://www.pinterest.com/'), false);
    assert.strictEqual(isPinterestUrl('https://pinterest.com.evil.com/pin/123/'), false);
    assert.strictEqual(isPinterestUrl('https://pin.it'), false);
    assert.strictEqual(isPinterestUrl('https://example.com/pin/123/'), false);
    assert.strictEqual(isPinterestUrl('not a url'), false);
  });

  test('extractMediaUrl reads the progressive MP4 from the VideoObject', () => {
    const url = 'https://v1.pinimg.com/videos/mc/720p/6e/b0/8c/6eb08ca060.mp4';
    assert.strictEqual(extractMediaUrl(videoLd(url)), url);
  });

  test('extractMediaUrl prefers video over the posting image on a video pin', () => {
    // A video pin publishes its still frame as the SocialMediaPosting image, so both blocks
    // are present and the video has to win.
    const video = 'https://v1.pinimg.com/videos/iht/expMp4/50/cc/48/50cc48.mp4';
    const html = postingLd('https://i.pinimg.com/originals/a0/a4/fd/a0a4fd.jpg') + videoLd(video);
    assert.strictEqual(extractMediaUrl(html), video);
  });

  test('extractMediaUrl falls back to the originals image on an image pin', () => {
    const image = 'https://i.pinimg.com/originals/95/2e/4b/952e4b.webp';
    assert.strictEqual(extractMediaUrl(postingLd(image)), image);
  });

  test('extractMediaUrl ignores media pointing off the Pinterest CDN', () => {
    const safe = 'https://i.pinimg.com/originals/3/safe.jpg';
    const html = videoLd('https://evil.example.com/x.mp4') + postingLd(safe);
    assert.strictEqual(extractMediaUrl(html), safe);
  });

  test('extractMediaUrl skips malformed JSON-LD blocks and keeps scanning', () => {
    const image = 'https://i.pinimg.com/originals/4/z.jpg';
    const html = `<script type="application/ld+json">{not json</script>` + postingLd(image);
    assert.strictEqual(extractMediaUrl(html), image);
  });

  test('extractMediaUrl returns null when the pin has no media', () => {
    // Deleted pins render a full page with no JSON-LD at all.
    assert.strictEqual(extractMediaUrl('<html><body>nothing here</body></html>'), null);
    assert.strictEqual(extractMediaUrl(''), null);
    assert.strictEqual(extractMediaUrl(null), null);
  });
});
