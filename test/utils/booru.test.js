import { describe, test } from 'bun:test';
import assert from 'node:assert';
import axios from 'axios';
import { downloadFromBooru, isBooruUrl } from '../../src/utils/booru.js';

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

  test('isBooruUrl recognizes yande.re and konachan post URLs', () => {
    assert.strictEqual(isBooruUrl('https://yande.re/post/show/1000000'), true);
    assert.strictEqual(isBooruUrl('https://konachan.com/post/show/300000'), true);
    assert.strictEqual(isBooruUrl('https://konachan.net/post/show/300000'), true);
    assert.strictEqual(isBooruUrl('https://yande.re/post/show/1000000?tags=cat'), true);
  });

  test('isBooruUrl rejects non-post pages on supported hosts', () => {
    assert.strictEqual(isBooruUrl('https://danbooru.donmai.us/'), false);
    assert.strictEqual(isBooruUrl('https://danbooru.donmai.us/posts'), false);
    assert.strictEqual(isBooruUrl('https://e621.net/posts?tags=cat'), false);
    assert.strictEqual(isBooruUrl('https://e621.net/wiki_pages/1'), false);
    assert.strictEqual(isBooruUrl('https://yande.re/post?tags=cat'), false);
    assert.strictEqual(isBooruUrl('https://konachan.com/'), false);
  });

  test('isBooruUrl rejects other hosts and lookalikes', () => {
    assert.strictEqual(isBooruUrl('https://example.com/posts/123'), false);
    assert.strictEqual(isBooruUrl('https://danbooru.donmai.us.evil.com/posts/1'), false);
    assert.strictEqual(isBooruUrl('https://rule34.xxx/index.php?page=post&s=view&id=1'), false);
    assert.strictEqual(isBooruUrl('not a url'), false);
    assert.strictEqual(isBooruUrl(''), false);
    assert.strictEqual(isBooruUrl(null), false);
  });

  describe('downloadFromBooru on Moebooru boards', () => {
    // yande.re and konachan have no per-post endpoint: the index is queried by id tag and
    // answers with a one-element array (empty when the post is gone).
    const withStubbedAxios = async (handler, run) => {
      const originalGet = axios.get;
      const requested = [];
      axios.get = async (url, config) => {
        requested.push({ url, config });
        return handler(url);
      };
      try {
        return await run(requested);
      } finally {
        axios.get = originalGet;
      }
    };

    const mediaResponse = {
      data: Buffer.from('fake-image-bytes'),
      headers: { 'content-type': 'image/jpeg' },
    };

    test('queries the index by id and downloads the array entry file_url', async () => {
      const fileUrl = 'https://files.yande.re/image/abc123/yande.re%201000000%20tagged.jpg';

      await withStubbedAxios(
        url => (url.includes('/post.json') ? { data: [{ file_url: fileUrl }] } : mediaResponse),
        async requested => {
          const result = await downloadFromBooru('https://yande.re/post/show/1000000');

          assert.strictEqual(
            requested[0].url,
            'https://yande.re/post.json?tags=id:1000000',
            'should hit the Moebooru index endpoint, not /posts/<id>.json'
          );
          assert.strictEqual(requested[1].url, fileUrl);
          assert.strictEqual(result.contentType, 'image/jpeg');
          assert.strictEqual(result.size, mediaResponse.data.length);
        }
      );
    });

    test('uses the same index endpoint for konachan', async () => {
      const fileUrl = 'https://konachan.com/image/def456/Konachan.com%20-%20300000.png';

      await withStubbedAxios(
        url => (url.includes('/post.json') ? { data: [{ file_url: fileUrl }] } : mediaResponse),
        async requested => {
          await downloadFromBooru('https://konachan.net/post/show/300000');
          assert.strictEqual(requested[0].url, 'https://konachan.net/post.json?tags=id:300000');
        }
      );
    });

    test('treats an empty array as a missing post', async () => {
      await withStubbedAxios(
        () => ({ data: [] }),
        async () => {
          await assert.rejects(downloadFromBooru('https://yande.re/post/show/999999999'), error => {
            assert.match(error.message, /no downloadable media/);
            return true;
          });
        }
      );
    });

    test('still builds /posts/<id>.json for danbooru-style boards', async () => {
      await withStubbedAxios(
        url =>
          url.includes('.json')
            ? { data: { file_url: 'https://cdn.donmai.us/original/ab/cd/abcd.jpg' } }
            : mediaResponse,
        async requested => {
          await downloadFromBooru('https://danbooru.donmai.us/posts/5000000');
          assert.strictEqual(requested[0].url, 'https://danbooru.donmai.us/posts/5000000.json');
        }
      );
    });

    test('derives the e621 CDN path when the API nulls file.url', async () => {
      const md5 = 'e96d0bb6c6f8cd4e8097bd5c689994e2';

      await withStubbedAxios(
        url =>
          url.endsWith('.json')
            ? { data: { post: { file: { url: null, md5, ext: 'mp4' } } } }
            : mediaResponse,
        async requested => {
          await downloadFromBooru('https://e621.net/posts/6596150');
          assert.strictEqual(requested[1].url, `https://static1.e621.net/data/e9/6d/${md5}.mp4`);
        }
      );
    });

    test('still reports missing media when e621 gives no md5', async () => {
      await withStubbedAxios(
        () => ({ data: { post: { file: { url: null } } } }),
        async () => {
          await assert.rejects(downloadFromBooru('https://e621.net/posts/1'), error => {
            assert.match(error.message, /no downloadable media/);
            return true;
          });
        }
      );
    });
  });
});
