import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isHentaiGifzUrl, extractMediaUrl } from '../../src/utils/hentaigifz.js';

describe('hentaigifz utilities', () => {
  test('isHentaiGifzUrl recognizes post URLs', () => {
    assert.strictEqual(isHentaiGifzUrl('https://hentaigifz.com/nezuko-exclusive-animation/'), true);
    assert.strictEqual(isHentaiGifzUrl('https://www.hentaigifz.com/some-slug/'), true);
    assert.strictEqual(isHentaiGifzUrl('http://hentaigifz.com/some-slug'), true);
  });

  test('isHentaiGifzUrl rejects other hosts and the bare cdn subdomain', () => {
    assert.strictEqual(isHentaiGifzUrl('https://example.com/nezuko/'), false);
    assert.strictEqual(isHentaiGifzUrl('https://hentaigifz.com.evil.com/x/'), false);
    // cdn URLs are direct assets, not post pages the extractor should be handed
    assert.strictEqual(isHentaiGifzUrl('https://cdn.hentaigifz.com/116592/x.gif'), false);
    assert.strictEqual(isHentaiGifzUrl('not a url'), false);
  });

  test('extractMediaUrl prefers the JSON-LD ImageObject contentUrl', () => {
    const html = `
      <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"ImageObject",
       "contentUrl":"https://cdn.hentaigifz.com/116592/nezuko-exclusive-animation.gif",
       "name":"Nezuko"}
      </script>
      <div class="single-post-media"><picture>
        <source srcset="https://cdn.hentaigifz.com/116592/nezuko-exclusive-animation-scaled.webp" type="image/webp">
        <img src="https://cdn.hentaigifz.com/116592/nezuko-exclusive-animation.gif" alt="Nezuko">
      </picture></div>`;
    assert.strictEqual(
      extractMediaUrl(html),
      'https://cdn.hentaigifz.com/116592/nezuko-exclusive-animation.gif'
    );
  });

  test('extractMediaUrl falls back to the single-post-media img when no JSON-LD', () => {
    const html = `
      <div class="single-post-media" role="presentation"><picture>
        <source srcset="https://cdn.hentaigifz.com/1/x-scaled.webp" type="image/webp">
        <img src="https://cdn.hentaigifz.com/1/x.gif" alt="x" width="800" height="566">
      </picture></div>`;
    assert.strictEqual(extractMediaUrl(html), 'https://cdn.hentaigifz.com/1/x.gif');
  });

  test('extractMediaUrl falls back to og:image when no post media element', () => {
    const html = `<meta property="og:image" content="https://cdn.hentaigifz.com/2/y-scaled.webp" />`;
    assert.strictEqual(extractMediaUrl(html), 'https://cdn.hentaigifz.com/2/y-scaled.webp');
  });

  test('extractMediaUrl ignores media on foreign hosts', () => {
    const html = `
      <script type="application/ld+json">
      {"@type":"ImageObject","contentUrl":"https://evil.example.com/x.gif"}
      </script>
      <meta property="og:image" content="https://cdn.hentaigifz.com/3/safe.webp" />`;
    // JSON-LD points off-host, so it must be skipped in favor of the on-host og:image
    assert.strictEqual(extractMediaUrl(html), 'https://cdn.hentaigifz.com/3/safe.webp');
  });

  test('extractMediaUrl decodes HTML entities in scraped URLs', () => {
    const html = `<meta property="og:image" content="https://cdn.hentaigifz.com/4/z.gif?a=1&amp;b=2" />`;
    assert.strictEqual(extractMediaUrl(html), 'https://cdn.hentaigifz.com/4/z.gif?a=1&b=2');
  });

  test('extractMediaUrl returns null when there is no media', () => {
    assert.strictEqual(extractMediaUrl('<html><body>nothing here</body></html>'), null);
    assert.strictEqual(extractMediaUrl(''), null);
    assert.strictEqual(extractMediaUrl(null), null);
  });
});
