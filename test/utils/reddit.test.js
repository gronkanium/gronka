import { describe, test } from 'bun:test';
import assert from 'node:assert';
import {
  isRedditPostUrl,
  extractImageCandidates,
  extractOffsiteUrl,
} from '../../src/utils/reddit.js';

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

  test('prefers the unsigned original, keeping the widest signed preview as fallback', () => {
    const slides = extractImageCandidates(slide('honest-rate-v0-tuno0m9l29ph1'));
    assert.strictEqual(slides.length, 1);
    const [original, fallback] = slides[0];
    assert.strictEqual(original, 'https://i.redd.it/tuno0m9l29ph1.jpg');
    assert.ok(fallback.includes('width=1080'), 'widest signed variant as fallback');
    assert.ok(fallback.includes('s=ccc'), "that width's own signature");
    assert.ok(!fallback.includes('&amp;'), 'entities decoded so the signature survives');
  });

  test('a gallery yields one entry per slide, in page order', () => {
    const slides = extractImageCandidates(
      slide('a-v0-one') + slide('b-v0-two') + slide('c-v0-three')
    );
    assert.strictEqual(slides.length, 3);
    assert.ok(slides[0][0].includes('one'));
    assert.ok(slides[2][0].includes('three'));
  });

  test('the same slide at many widths collapses to one image', () => {
    assert.strictEqual(extractImageCandidates(slide('dup-v0-x') + slide('dup-v0-x')).length, 1);
  });

  test('ignores avatars and other non-post imagery', () => {
    assert.deepStrictEqual(extractImageCandidates(avatar), []);
    assert.strictEqual(extractImageCandidates(avatar + slide('real-v0-post')).length, 1);
  });

  // Reddit flips to this shape without warning; it carries the same slides at a larger width.
  const noJsVariant = `
    <meta property="og:image" content="https://preview.redd.it/tuno0m9l29ph1.jpg?width=1200&amp;s=q1">
    <script type="application/json">{"url":"https://preview.redd.it/tuno0m9l29ph1.jpg?width=108&amp;s=q2",
    "more":"https://preview.redd.it/wuv07m9l29ph1.jpg?width=1200&amp;s=q3"}</script>`;

  test('reads the server-rendered variant, not just the hydrated one', () => {
    const slides = extractImageCandidates(noJsVariant);
    assert.strictEqual(slides.length, 2);
    assert.strictEqual(slides[0][0], 'https://i.redd.it/tuno0m9l29ph1.jpg');
    assert.ok(slides[0][1].includes('width=1200'), 'widest signed preview wins over the 108w');
    assert.ok(slides[0][1].includes('s=q1'));
  });

  test('both shapes name the same slide, so they do not double up', () => {
    // hydrated ids carry a title prefix the server-rendered ones omit
    const urls = extractImageCandidates(slide('honest-rate-v0-tuno0m9l29ph1') + noJsVariant);
    assert.ok(
      urls.length <= 2,
      `same two slides across both shapes, got ${urls.length}: ${urls.join(' ')}`
    );
  });

  test('a thumbnail-only page still yields the unsigned original', () => {
    const thumb =
      '<meta property="og:image" content="https://preview.redd.it/abc123.jpg?width=140&amp;crop=1:1,smart">';
    // the 140px thumb itself is unsigned and 403s, but it names the slide
    assert.deepStrictEqual(extractImageCandidates(thumb), [['https://i.redd.it/abc123.jpg']]);
  });

  test("the post's own image sorts first, ahead of neighbouring posts", () => {
    const page =
      '<meta property="og:image" content="https://preview.redd.it/mine.jpg?width=140&amp;crop=1:1">' +
      slide('other-v0-neighbour') +
      slide('title-v0-mine');
    const slides = extractImageCandidates(page);
    assert.ok(slides[0][0].includes('mine'), `og:image slide first, got ${slides[0][0]}`);
  });

  test('finds the offsite host a link-aggregator post points at', () => {
    const page =
      '<a href="https://www.reddit.com/r/x/comments/y/">permalink</a>' +
      '<div>https://redgifs.com/watch/digitalmysteriousanglerfish</div>';
    assert.strictEqual(
      extractOffsiteUrl(page),
      'https://redgifs.com/watch/digitalmysteriousanglerfish'
    );
  });

  test('ignores offsite hosts the download pipeline cannot handle', () => {
    assert.strictEqual(extractOffsiteUrl('<a href="https://example.com/thing">x</a>'), null);
    assert.strictEqual(extractOffsiteUrl('<a href="https://reddit.com/r/a/">x</a>'), null);
  });

  test('a post with no images extracts nothing rather than guessing', () => {
    assert.deepStrictEqual(extractImageCandidates('<html><body>no media here</body></html>'), []);
  });
});
