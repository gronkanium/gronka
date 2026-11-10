import { describe, test } from 'bun:test';
import assert from 'node:assert';
import {
  isSnapchatMediaUrl,
  spotlightVideoUrl,
  sharedSnapMedia,
} from '../../src/utils/snapchat.js';

describe('snapchat spotlight', () => {
  test('recognizes spotlight links with and without the creator', () => {
    assert.strictEqual(isSnapchatMediaUrl('https://www.snapchat.com/@nasa/spotlight/W7_ab'), true);
    assert.strictEqual(isSnapchatMediaUrl('https://snapchat.com/spotlight/W7_ab?locale=en'), true);
    assert.strictEqual(isSnapchatMediaUrl('https://www.snapchat.com/add/nasa'), false);
    assert.strictEqual(isSnapchatMediaUrl('https://snapchat.com.evil.example/spotlight/x'), false);
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

  test('recognizes shared memory links', () => {
    assert.strictEqual(
      isSnapchatMediaUrl('https://share.snapchat.com/m/JNAF5_Y5?src=memories'),
      true
    );
    assert.strictEqual(isSnapchatMediaUrl('https://share.snapchat.com/other'), false);
  });

  test('reads shared memory files from the Next.js data, Snapchat CDN only', () => {
    const data = {
      props: {
        pageProps: {
          mediaData: {
            batchMediaShare: {
              media: [
                { __typename: 'Video', url: 'https://cf-st.sc-cdn.net/d/a.1034?mo=x' },
                { __typename: 'Image', url: 'https://cf-st.sc-cdn.net/d/b.1034' },
                { __typename: 'Video', url: 'https://evil.example/c.mp4' },
              ],
            },
          },
        },
      },
    };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
    assert.deepStrictEqual(sharedSnapMedia(html), [
      { url: 'https://cf-st.sc-cdn.net/d/a.1034?mo=x', ext: 'mp4' },
      { url: 'https://cf-st.sc-cdn.net/d/b.1034', ext: 'jpg' },
    ]);
    assert.deepStrictEqual(sharedSnapMedia('<html></html>'), []);
  });
});
