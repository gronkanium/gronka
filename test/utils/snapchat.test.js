import { describe, test } from 'bun:test';
import assert from 'node:assert';
import { isSnapchatSpotlightUrl, spotlightVideoUrl } from '../../src/utils/snapchat.js';

describe('snapchat spotlight', () => {
  test('recognizes spotlight links with and without the creator', () => {
    assert.strictEqual(
      isSnapchatSpotlightUrl('https://www.snapchat.com/@nasa/spotlight/W7_ab'),
      true
    );
    assert.strictEqual(
      isSnapchatSpotlightUrl('https://snapchat.com/spotlight/W7_ab?locale=en'),
      true
    );
    assert.strictEqual(isSnapchatSpotlightUrl('https://www.snapchat.com/add/nasa'), false);
    assert.strictEqual(
      isSnapchatSpotlightUrl('https://snapchat.com.evil.example/spotlight/x'),
      false
    );
  });

  test('reads the video from og:video and decodes its query', () => {
    const html =
      '<meta property="og:video" content="https://cf-st.sc-cdn.net/d/abc.27.IRZXSOY?mo=x&amp;uc=46"/>';
    assert.strictEqual(
      spotlightVideoUrl(html),
      'https://cf-st.sc-cdn.net/d/abc.27.IRZXSOY?mo=x&uc=46'
    );
  });

  test('ignores an og:video off Snapchat CDN or missing', () => {
    assert.strictEqual(
      spotlightVideoUrl('<meta property="og:video" content="https://evil.example/v.mp4"/>'),
      null
    );
    assert.strictEqual(spotlightVideoUrl('<html></html>'), null);
  });
});
