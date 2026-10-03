import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { isThreadsUrl, threadsPostCode, extractThreadsMedia } from '../../src/utils/threads.js';

const page = posts =>
  posts
    .map(
      post =>
        `<script type="application/json" data-sjs>${JSON.stringify({ x: [{ post }] })}</script>`
    )
    .join('');
const image = url => ({ image_versions2: { candidates: [{ url }] } });
const CDN = 'https://scontent-iad3-1.cdninstagram.com/v/t51/';

describe('threads', () => {
  test('recognises post links on both domains, nothing else', () => {
    assert.strictEqual(
      threadsPostCode('https://www.threads.com/@nasa/post/Dd9aFLHgnnj'),
      'Dd9aFLHgnnj'
    );
    assert.strictEqual(
      threadsPostCode('https://threads.net/@a.b_c/post/Dd6o8f5EV1z?x=1'),
      'Dd6o8f5EV1z'
    );
    assert.ok(!isThreadsUrl('https://www.threads.com/@nasa'));
    assert.ok(!isThreadsUrl('https://www.instagram.com/p/Dd9aFLHgnnj/'));
  });

  test('takes the linked post, not the other posts on the page', () => {
    const html = page([
      { code: 'Other', media_type: 1, ...image(`${CDN}other.jpg`) },
      {
        code: 'Mine',
        media_type: 2,
        video_versions: [{ url: `${CDN}mine.mp4` }],
        ...image(`${CDN}still.jpg`),
      },
    ]);
    assert.deepStrictEqual(extractThreadsMedia(html, 'Mine'), [`${CDN}mine.mp4`]);
  });

  test('a carousel gives every slide in order', () => {
    const html = page([
      { code: 'C', media_type: 8, carousel_media: [image(`${CDN}1.jpg`), image(`${CDN}2.jpg`)] },
    ]);
    assert.deepStrictEqual(extractThreadsMedia(html, 'C'), [`${CDN}1.jpg`, `${CDN}2.jpg`]);
  });

  test('a text post has no media, an absent post is null, other hosts are dropped', () => {
    assert.deepStrictEqual(extractThreadsMedia(page([{ code: 'T', media_type: 19 }]), 'T'), []);
    assert.strictEqual(extractThreadsMedia(page([]), 'T'), null);
    const html = page([{ code: 'E', media_type: 1, ...image('https://evil.example/x.jpg') }]);
    assert.deepStrictEqual(extractThreadsMedia(html, 'E'), []);
  });
});
