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

  test('resolves TikTok, bilibili and spotify share links through guarded redirects', async () => {
    const target = 'https://www.tiktok.com/@creator/video/123';
    spy = spyOn(axios, 'get').mockResolvedValue({
      data: { destroy() {} },
      request: { res: { responseUrl: target } },
    });
    for (const url of [
      'https://vm.tiktok.com/abc/',
      'https://vt.tiktok.com/abc/',
      'https://b23.tv/abc123',
      'https://www.tiktok.com/t/abc/',
      'https://tiktok.com/t/abc/',
      'https://lite.tiktok.com/t/ZSgch2MXx/',
      'https://spotify.link/AbC123',
      'https://spotify.app.link/AbC123',
    ]) {
      assert.equal(await resolveShortLink(url), target);
      const options = spy.mock.calls.at(-1)[1];
      assert.ok(options.lookup);
      assert.ok(options.beforeRedirect);
    }
  });

  test('follows SoundCloud and Niconico share links, which no extractor reads', async () => {
    for (const [short, target] of [
      [
        'https://on.soundcloud.com/ilDONmw57JvRysSXVO',
        'https://soundcloud.com/a/b?ref=clipboard&si=02e5c8d7',
      ],
      ['https://nico.ms/sm9', 'https://www.nicovideo.jp/watch/sm9'],
    ]) {
      spy?.mockRestore();
      spy = spyOn(axios, 'get').mockResolvedValue({
        data: { destroy() {} },
        request: { res: { responseUrl: target } },
      });
      assert.strictEqual(await resolveShortLink(short), target);
      assert.ok(spy.mock.calls[0][1].lookup);
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

  test('takes the page out of a google redirect link without a request', async () => {
    spy = spyOn(axios, 'get');
    const page = 'https://www.reddit.com/r/a/comments/b/c/';
    for (const url of [
      `https://www.google.com/url?q=${encodeURIComponent(page)}&sa=U`,
      `https://www.google.co.uk/url?sa=t&url=${encodeURIComponent(page)}`,
    ]) {
      assert.strictEqual(await resolveShortLink(url), page);
    }
    const local = `https://www.google.com/url?q=${encodeURIComponent('http://127.0.0.1/')}`;
    assert.strictEqual(await resolveShortLink(local), local);
    assert.strictEqual(spy.mock.calls.length, 0);
  });

  test('follows a google goto link, whose target is encoded, through the ssrf guard', async () => {
    const target = 'https://danbooru.donmai.us/posts/5826884';
    spy = spyOn(axios, 'get').mockResolvedValue({
      data: { destroy() {} },
      request: { res: { responseUrl: target } },
    });
    assert.strictEqual(
      await resolveShortLink('https://www.google.com/goto?url=CAESYAHrOzAVS7_vQztT'),
      target
    );
    assert.ok(spy.mock.calls[0][1].beforeRedirect);
  });

  test('leaves other google pages alone without a request', async () => {
    spy = spyOn(axios, 'get');
    const search = 'https://www.google.com/search?q=cats';
    assert.strictEqual(await resolveShortLink(search), search);
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
