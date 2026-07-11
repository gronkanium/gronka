import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isBooruUrl } from '../../src/utils/booru.js';

describe('booru utilities', () => {
  test('isBooruUrl recognizes danbooru post URLs', () => {
    assert.strictEqual(isBooruUrl('https://danbooru.donmai.us/posts/5000000'), true);
    assert.strictEqual(isBooruUrl('https://danbooru.donmai.us/posts/5000000?q=cat'), true);
    assert.strictEqual(isBooruUrl('http://danbooru.donmai.us/posts/1'), true);
  });

  test('isBooruUrl recognizes e621/e926 post URLs (incl. legacy path)', () => {
    assert.strictEqual(isBooruUrl('https://e621.net/posts/1500000'), true);
    assert.strictEqual(isBooruUrl('https://www.e621.net/posts/1500000'), true);
    assert.strictEqual(isBooruUrl('https://e926.net/posts/1500000'), true);
    assert.strictEqual(isBooruUrl('https://e621.net/post/show/1500000'), true);
  });

  test('isBooruUrl rejects non-post pages on supported hosts', () => {
    assert.strictEqual(isBooruUrl('https://danbooru.donmai.us/'), false);
    assert.strictEqual(isBooruUrl('https://danbooru.donmai.us/posts'), false);
    assert.strictEqual(isBooruUrl('https://e621.net/posts?tags=cat'), false);
    assert.strictEqual(isBooruUrl('https://e621.net/wiki_pages/1'), false);
  });

  test('isBooruUrl rejects other hosts and lookalikes', () => {
    assert.strictEqual(isBooruUrl('https://example.com/posts/123'), false);
    assert.strictEqual(isBooruUrl('https://danbooru.donmai.us.evil.com/posts/1'), false);
    assert.strictEqual(isBooruUrl('https://rule34.xxx/index.php?page=post&s=view&id=1'), false);
    assert.strictEqual(isBooruUrl('not a url'), false);
    assert.strictEqual(isBooruUrl(''), false);
    assert.strictEqual(isBooruUrl(null), false);
  });
});
