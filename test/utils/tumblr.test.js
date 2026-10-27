import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  parseTumblrUrl,
  isTumblrUrl,
  findTumblrPost,
  extractTumblrMedia,
} from '../../src/utils/tumblr.js';

const page = route =>
  `<html><script type="application/json" id="___INITIAL_STATE___">${JSON.stringify({ PeeprRoute: route })}</script></html>`;

const image = (...widths) => ({
  type: 'image',
  media: widths.map(w => ({ width: w, url: `https://64.media.tumblr.com/a/s${w}/x.jpg` })),
});

describe('tumblr', () => {
  test('parseTumblrUrl reads blog subdomain and www.tumblr.com post links', () => {
    const want = { blog: 'nasa', id: '828471464226406400' };
    assert.deepEqual(parseTumblrUrl('https://nasa.tumblr.com/post/828471464226406400'), want);
    assert.deepEqual(parseTumblrUrl('https://nasa.tumblr.com/post/828471464226406400/slug'), want);
    assert.deepEqual(parseTumblrUrl('https://www.tumblr.com/nasa/828471464226406400/slug'), want);
    assert.deepEqual(parseTumblrUrl('https://tumblr.com/nasa/828471464226406400'), want);
    assert.deepEqual(
      parseTumblrUrl('https://www.tumblr.com/blog/view/nasa/828471464226406400'),
      want
    );
  });

  test('isTumblrUrl rejects blogs, media hosts and lookalikes', () => {
    assert.equal(isTumblrUrl('https://nasa.tumblr.com/'), false);
    assert.equal(isTumblrUrl('https://www.tumblr.com/nasa'), false);
    assert.equal(isTumblrUrl('https://64.media.tumblr.com/a/s540/x.jpg'), false);
    assert.equal(isTumblrUrl('https://tumblr.com.evil.com/post/1'), false);
    assert.equal(isTumblrUrl('not a url'), false);
  });

  test('findTumblrPost picks the post by id from the page state', () => {
    const post = { idString: '2', content: [] };
    const html = page({ initialTimeline: { objects: [{ idString: '1' }, post] } });
    assert.deepEqual(findTumblrPost(html, '2'), post);
    assert.equal(findTumblrPost('<html>Checking your browser...</html>', '2'), null);
  });

  test('findTumblrPost reports a deleted post as gone', () => {
    const html = page({ postPermalinkIsMissing: true, initialTimeline: { objects: [] } });
    assert.throws(() => findTumblrPost(html, '2'), { code: 'CONTENT_GONE' });
  });

  test('extractTumblrMedia takes the largest image, tumblr videos, and reblogged media first', () => {
    const post = {
      trail: [{ content: [image(500, 2048)] }],
      content: [
        { type: 'text', text: 'hi' },
        image(1280, 640),
        { type: 'video', provider: 'tumblr', media: { url: 'https://64.media.tumblr.com/v.mov' } },
        { type: 'video', provider: 'youtube', url: 'https://youtube.com/watch?v=x' },
      ],
    };
    assert.deepEqual(extractTumblrMedia(post), [
      'https://64.media.tumblr.com/a/s2048/x.jpg',
      'https://64.media.tumblr.com/a/s1280/x.jpg',
      'https://64.media.tumblr.com/v.mov',
    ]);
  });
});
