import { describe, test } from 'bun:test';
import assert from 'node:assert';
import { isKlipyUrl, extractMediaUrl } from '../../src/utils/klipy.js';

describe('klipy utilities', () => {
  test('recognizes Klipy pages and rejects lookalike hosts', () => {
    assert.strictEqual(isKlipyUrl('https://klipy.com/gifs/funny-cat-123'), true);
    assert.strictEqual(isKlipyUrl('https://www.klipy.com/stickers/wave'), true);
    assert.strictEqual(isKlipyUrl('https://klipy.com/gif/cat'), true);
    assert.strictEqual(isKlipyUrl('https://cdn.klipy.com/file.gif'), false);
    assert.strictEqual(isKlipyUrl('https://klipy.com/'), false);
    assert.strictEqual(isKlipyUrl('https://klipy.com.evil.example/gifs/cat'), false);
    assert.strictEqual(isKlipyUrl('not a url'), false);
  });

  test('prefers an Open Graph video over a non-animated poster image', () => {
    const video = 'https://media.klipy.com/gifs/cat.mp4';
    const image = 'https://media.klipy.com/gifs/cat.jpg';
    const html = `<meta property="og:image" content="${image}"><meta property="og:video:secure_url" content="${video}">`;
    assert.strictEqual(extractMediaUrl(html), video);
  });

  test('preserves an animated GIF when Klipy publishes both GIF and MP4', () => {
    const gif = 'https://static2.klipy.com/gifs/cat.gif';
    const video = 'https://static2.klipy.com/gifs/cat.mp4';
    const html = `<meta property="og:image" content="https://static2.klipy.com/gifs/cat.webp"><meta property="og:image" content="${gif}"><meta property="og:video:url" content="${video}">`;
    assert.strictEqual(extractMediaUrl(html), gif);
  });

  test('falls back to the Open Graph image for GIF pages without video metadata', () => {
    const image = 'https://cdn.klipy.com/gifs/cat.gif';
    assert.strictEqual(extractMediaUrl(`<meta property="og:image" content="${image}">`), image);
  });

  test('accepts JSON-LD video and rejects off-site media', () => {
    const video = 'https://media.klipy.com/gifs/cat.webm';
    const html = `<script type="application/ld+json">{"@type":"VideoObject","contentUrl":"${video}"}</script>`;
    assert.strictEqual(extractMediaUrl(html), video);
    assert.strictEqual(
      extractMediaUrl('<meta property="og:video" content="https://evil.example/cat.mp4">'),
      null
    );
  });
});
