import { describe, test } from 'bun:test';
import assert from 'node:assert';
import { isRedditPostUrl, extractImageUrls } from '../../src/utils/reddit.js';

// Trimmed from a real post page: src is the 640w variant, srcset carries the wider ones, and
// every width has its own `s=` signature, so the widest has to be taken as-is.
const slide = id => `
  <figure class="h-full w-full m-0 z-10 flex items-center"><img
    class="media-lightbox-img h-full w-full object-contain mb-0 relative"
    src="https://preview.redd.it/${id}.jpg?width=640&amp;crop=smart&amp;auto=webp&amp;s=aaa"
    width="1200" height="900"
    srcset="https://preview.redd.it/${id}.jpg?width=320&amp;crop=smart&amp;auto=webp&amp;s=bbb 320w,
            https://preview.redd.it/${id}.jpg?width=640&amp;crop=smart&amp;auto=webp&amp;s=aaa 640w,
            https://preview.redd.it/${id}.jpg?width=1080&amp;crop=smart&amp;auto=webp&amp;s=ccc 1080w"></figure>`;

const avatar = `<img class="shreddit-subreddit-icon"
  src="https://preview.redd.it/snoovatar/avatars/6524c569-headshot.png?width=64&amp;s=zzz">`;

describe('reddit utilities', () => {
  test('isRedditPostUrl accepts canonical and share permalinks', () => {
    assert.strictEqual(
      isRedditPostUrl('https://www.reddit.com/r/Cutemaxxing/comments/1wf293y/honest_rate/'),
      true
    );
    // the share sheet emits /s/<id>, which is what most users actually paste
    assert.strictEqual(isRedditPostUrl('https://reddit.com/r/AltFashion/s/9EjV8nKm1j'), true);
    assert.strictEqual(isRedditPostUrl('https://old.reddit.com/r/aww/comments/abc123/x/'), true);
  });

  test('isRedditPostUrl rejects subreddits, users, and lookalike hosts', () => {
    assert.strictEqual(isRedditPostUrl('https://www.reddit.com/r/aww/'), false);
    assert.strictEqual(isRedditPostUrl('https://www.reddit.com/user/someone'), false);
    assert.strictEqual(isRedditPostUrl('https://reddit.com.evil.com/r/a/comments/b/c/'), false);
    assert.strictEqual(isRedditPostUrl('not a url'), false);
  });

  test('takes the widest signed variant from srcset, not the smaller src', () => {
    const urls = extractImageUrls(slide('honest-rate-v0-tuno0m9l29ph1'));
    assert.strictEqual(urls.length, 1);
    assert.ok(urls[0].includes('width=1080'), 'widest variant');
    assert.ok(urls[0].includes('s=ccc'), "that width's own signature");
    assert.ok(!urls[0].includes('&amp;'), 'entities decoded so the signature survives');
  });

  test('a gallery yields one entry per slide, in page order', () => {
    const urls = extractImageUrls(slide('a-v0-one') + slide('b-v0-two') + slide('c-v0-three'));
    assert.strictEqual(urls.length, 3);
    assert.ok(urls[0].includes('a-v0-one'));
    assert.ok(urls[2].includes('c-v0-three'));
  });

  test('the same slide at many widths collapses to one image', () => {
    assert.strictEqual(extractImageUrls(slide('dup-v0-x') + slide('dup-v0-x')).length, 1);
  });

  test('ignores avatars and other non-post imagery', () => {
    assert.deepStrictEqual(extractImageUrls(avatar), []);
    assert.strictEqual(extractImageUrls(avatar + slide('real-v0-post')).length, 1);
  });

  test('a post with no images extracts nothing rather than guessing', () => {
    assert.deepStrictEqual(extractImageUrls('<html><body>no media here</body></html>'), []);
  });
});
