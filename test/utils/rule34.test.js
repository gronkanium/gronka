import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { isRule34Url, rule34PostId, extractRule34Media } from '../../src/utils/rule34.js';

const post = 'https://rule34.xxx/index.php?page=post&s=view&id=123';
const original = 'https://wimg.rule34.xxx//images/42/original.png?123';
const anchor = url => `<a href="${url}" onclick="Post.highres();">\n Original image\n</a>`;

describe('Rule34 post links', () => {
  test('accepts post IDs regardless of query order and extra tags', () => {
    for (const url of [
      post,
      `${post}&tags=example+`,
      'http://www.rule34.xxx/index.php?id=123&s=view&page=post#comments',
    ]) {
      assert.equal(isRule34Url(url), true);
      assert.equal(rule34PostId(url), '123');
    }
  });

  test('rejects galleries, malformed posts, credentials and lookalike hosts', () => {
    for (const url of [
      'https://rule34.xxx/',
      'https://rule34.xxx/index.php?page=post&s=list&tags=example',
      `${post}&id=456`,
      post.replace('id=123', 'id=-1'),
      post.replace('id=123', 'id=abc'),
      post.replace('id=123', 'id=0'),
      post.replace('rule34.xxx', 'rule34.xxx.evil.example'),
      post.replace('rule34.xxx', 'cdn.rule34.xxx'),
      post.replace('https:', 'ftp:'),
      post.replace('rule34.xxx', 'rule34.xxx:8443'),
      post.replace('rule34.xxx', 'user:password@rule34.xxx'),
      'invalid',
      null,
    ]) {
      assert.equal(isRule34Url(url), false, String(url));
    }
  });
});

describe('Rule34 original media', () => {
  test('prefers the full image over its resized sample, thumbnail and advertisements', () => {
    const html = `<meta property="og:image" content="https://wimg.rule34.xxx/thumbnails/42/thumb.jpg">
      <img src="https://wimg.rule34.xxx/samples/42/sample.jpg" id="image">
      <video src="https://ads.example/ad.mp4"></video>${anchor(original)}`;
    assert.equal(extractRule34Media(html), original);
  });

  test('reads original images and animations without choosing samples', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
      const url = original.replace('.png', `.${ext}`);
      assert.equal(extractRule34Media(anchor(url)), url);
      assert.equal(extractRule34Media(`<img id='image' src='${url}'>`), url);
    }
    assert.equal(
      extractRule34Media('<img id="image" src="https://wimg.rule34.xxx/samples/42/sample.jpg">'),
      null
    );
  });

  test('reads video originals and the post player without taking its poster', () => {
    for (const ext of ['mp4', 'webm']) {
      const url = `https://aws-mp4.rule34.xxx/images/42/video.${ext}?key=1&token=2`;
      assert.equal(extractRule34Media(anchor(url.replace('&', '&amp;'))), url);
      assert.equal(
        extractRule34Media(`<video id="gelcomVideoPlayer" poster="${original}">
          <source type="video/${ext}" src="${url.replace('&', '&amp;')}" /></video>`),
        url
      );
    }
  });

  test('accepts protocol-relative CDN links and refuses unsafe or unrelated originals', () => {
    assert.equal(extractRule34Media(anchor(original.replace('https:', ''))), original);
    for (const url of [
      original.replace('https:', 'http:'),
      original.replace('wimg.rule34.xxx', 'rule34.xxx.evil.example'),
      original.replace('wimg.rule34.xxx', '127.0.0.1'),
      original.replace('wimg.rule34.xxx', 'wimg.rule34.xxx:8443'),
      original.replace('wimg.rule34.xxx', 'user:password@wimg.rule34.xxx'),
      original.replace('/images/', '/samples/'),
      'javascript:alert(1)',
    ]) {
      assert.equal(extractRule34Media(anchor(url)), null, url);
    }
    assert.equal(extractRule34Media('<html>CAPTCHA</html>'), null);
    assert.equal(extractRule34Media(null), null);
  });
});
