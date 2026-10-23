import { test, describe, afterEach, spyOn } from 'bun:test';
import assert from 'node:assert';
import axios from 'axios';
import { resolveShortLink } from '../../src/utils/short-links.js';

describe('resolveShortLink', () => {
  let spy;
  afterEach(() => spy?.mockRestore());

  test('follows a share.google link to the page it points at, through the ssrf guard', async () => {
    spy = spyOn(axios, 'get').mockResolvedValue({
      data: { destroy() {} },
      request: { res: { responseUrl: 'https://www.instagram.com/reel/abc/' } },
    });
    assert.strictEqual(
      await resolveShortLink('https://share.google/AbC'),
      'https://www.instagram.com/reel/abc/'
    );
    assert.ok(spy.mock.calls[0][1].lookup);
    assert.ok(spy.mock.calls[0][1].beforeRedirect);
  });

  test('follows a facebook share link to its post', async () => {
    spy = spyOn(axios, 'get').mockResolvedValue({
      data: { destroy() {} },
      request: { res: { responseUrl: 'https://www.facebook.com/1/posts/2/' } },
    });
    assert.strictEqual(
      await resolveShortLink('https://www.facebook.com/share/AbC/'),
      'https://www.facebook.com/1/posts/2/'
    );
  });

  test('resolves all TikTok share formats through guarded redirects', async () => {
    const target = 'https://www.tiktok.com/@creator/video/123';
    spy = spyOn(axios, 'get').mockResolvedValue({
      data: { destroy() {} },
      request: { res: { responseUrl: target } },
    });
    for (const url of [
      'https://vm.tiktok.com/abc/',
      'https://vt.tiktok.com/abc/',
      'https://www.tiktok.com/t/abc/',
      'https://tiktok.com/t/abc/',
    ]) {
      assert.equal(await resolveShortLink(url), target);
      const options = spy.mock.calls.at(-1)[1];
      assert.ok(options.lookup);
      assert.ok(options.beforeRedirect);
    }
  });

  test('takes the image out of a google image result, never a private one', async () => {
    spy = spyOn(axios, 'get');
    const wrapped = image => `https://www.google.com/imgres?imgurl=${encodeURIComponent(image)}`;
    assert.strictEqual(
      await resolveShortLink(wrapped('https://pbs.twimg.com/media/X?format=webp')),
      'https://pbs.twimg.com/media/X?format=webp'
    );
    const local = wrapped('http://127.0.0.1/a.png');
    assert.strictEqual(await resolveShortLink(local), local);
    assert.strictEqual(spy.mock.calls.length, 0);
  });

  test('leaves other hosts alone without a request', async () => {
    spy = spyOn(axios, 'get');
    assert.strictEqual(await resolveShortLink('https://example.com/a'), 'https://example.com/a');
    assert.strictEqual(spy.mock.calls.length, 0);
  });

  test('returns the original link when the request fails', async () => {
    spy = spyOn(axios, 'get').mockRejectedValue(new Error('timeout'));
    assert.strictEqual(
      await resolveShortLink('https://share.google/AbC'),
      'https://share.google/AbC'
    );
  });
});
