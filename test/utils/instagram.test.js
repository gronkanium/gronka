import { describe, test, spyOn, afterEach } from 'bun:test';
import assert from 'node:assert';
import { Readable } from 'node:stream';
import axios from 'axios';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isInstagramPostUrl,
  isInstagramStoryUrl,
  parseStoryUrl,
  downloadFromInstagram,
  shortcodeToMediaId,
  selectMediaUrl,
} from '../../src/utils/instagram.js';

const image = url => ({ image_versions2: { candidates: [{ url }, { url: `${url}?small` }] } });
const video = url => ({
  ...image('https://scontent.cdninstagram.com/still.jpg'),
  video_versions: [{ url }],
});

describe('instagram utilities', () => {
  test('isInstagramPostUrl recognizes every post permalink shape', () => {
    assert.strictEqual(isInstagramPostUrl('https://www.instagram.com/p/DbzojBsOC6p/'), true);
    assert.strictEqual(isInstagramPostUrl('https://instagram.com/reel/DbfuznPzy5r/'), true);
    assert.strictEqual(isInstagramPostUrl('https://www.instagram.com/reels/DbfuznPzy5r/'), true);
    assert.strictEqual(isInstagramPostUrl('https://www.instagram.com/tv/CPESdZpl7MD/'), true);
    assert.strictEqual(
      isInstagramPostUrl('https://www.instagram.com/flores.mendoza/p/DR5Uvptjq5T/'),
      true
    );
    assert.strictEqual(
      isInstagramPostUrl('https://www.instagram.com/someuser/reel/DbfuznPzy5r/'),
      true
    );
    // the share sheet's igsh / img_index querystrings must not defeat the match
    assert.strictEqual(
      isInstagramPostUrl('https://www.instagram.com/p/DbOHz1IEw4g/?img_index=1&igsh=MWJ1'),
      true
    );
  });

  test('isInstagramPostUrl rejects profiles, stories, and lookalike hosts', () => {
    assert.strictEqual(isInstagramPostUrl('https://www.instagram.com/someuser/'), false);
    assert.strictEqual(
      isInstagramPostUrl('https://www.instagram.com/stories/someuser/123/'),
      false
    );
    assert.strictEqual(isInstagramPostUrl('https://www.instagram.com/'), false);
    assert.strictEqual(isInstagramPostUrl('https://instagram.com.evil.com/p/abc/'), false);
    assert.strictEqual(isInstagramPostUrl('not a url'), false);
  });

  test('shortcodeToMediaId decodes the base64 shortcode alphabet', () => {
    // verified against the live api: these ids are what /api/v1/media/<id>/info/ answers to
    assert.strictEqual(shortcodeToMediaId('DbzojBsOC6p'), '3959686826246549161');
    assert.strictEqual(shortcodeToMediaId('CPESdZpl7MD'), '2577266072006144771');
    assert.strictEqual(
      shortcodeToMediaId('DbzojBsOC6p' + 'd79hVEWk-biTmvi2oO7bLN80RQo0'),
      '3959686826246549161'
    );
    assert.strictEqual(shortcodeToMediaId('!!bad!!'), null);
    assert.strictEqual(shortcodeToMediaId(''), null);
  });

  test('selectMediaUrl takes the first (highest quality) candidate', () => {
    assert.strictEqual(
      selectMediaUrl(image('https://scontent.cdninstagram.com/big.jpg')),
      'https://scontent.cdninstagram.com/big.jpg'
    );
  });

  test("selectMediaUrl prefers the video over a video item's own still frame", () => {
    assert.strictEqual(
      selectMediaUrl(video('https://scontent.cdninstagram.com/clip.mp4')),
      'https://scontent.cdninstagram.com/clip.mp4'
    );
  });

  test('selectMediaUrl honours a 1-based img_index into a carousel', () => {
    const carousel = {
      carousel_media: [
        image('https://scontent.cdninstagram.com/one.jpg'),
        image('https://scontent.cdninstagram.com/two.jpg'),
      ],
    };
    assert.strictEqual(selectMediaUrl(carousel, 2), 'https://scontent.cdninstagram.com/two.jpg');
    // no index, or an index past the end, falls back to the first slide
    assert.strictEqual(selectMediaUrl(carousel, null), 'https://scontent.cdninstagram.com/one.jpg');
    assert.strictEqual(selectMediaUrl(carousel, 9), 'https://scontent.cdninstagram.com/one.jpg');
    assert.strictEqual(selectMediaUrl(carousel, 0), 'https://scontent.cdninstagram.com/one.jpg');
  });

  test('selectMediaUrl refuses media hosted off the instagram CDN', () => {
    assert.strictEqual(selectMediaUrl(image('https://evil.example.com/x.jpg')), null);
    // an off-CDN video url is dropped, leaving the (host-checked) still frame
    assert.strictEqual(
      selectMediaUrl(video('https://evil.example.com/x.mp4')),
      'https://scontent.cdninstagram.com/still.jpg'
    );
    assert.strictEqual(selectMediaUrl({}), null);
    assert.strictEqual(selectMediaUrl(null), null);
  });
});

const highlightShare = id =>
  `https://www.instagram.com/s/${Buffer.from(`highlight:${id}`).toString('base64url')}`;

describe('instagram story urls', () => {
  test('parseStoryUrl reads a story, a highlight, and the share-sheet highlight link', () => {
    assert.deepStrictEqual(parseStoryUrl('https://www.instagram.com/someuser/'), null);
    assert.deepStrictEqual(
      parseStoryUrl(
        'https://www.instagram.com/stories/some.user/3884905143972195700/?utm_source=ig'
      ),
      { highlightId: null, username: 'some.user', mediaId: '3884905143972195700' }
    );
    assert.deepStrictEqual(parseStoryUrl('https://www.instagram.com/stories/highlights/1796/'), {
      highlightId: '1796',
      username: null,
      mediaId: null,
    });
    assert.deepStrictEqual(
      parseStoryUrl(
        `${highlightShare('17966681567900583')}?story_media_id=3884905143972195700&stkn=x`
      ),
      {
        highlightId: '17966681567900583',
        username: null,
        mediaId: '3884905143972195700',
      }
    );
    assert.deepStrictEqual(parseStoryUrl(highlightShare('17966681567900583')), {
      highlightId: '17966681567900583',
      username: null,
      mediaId: null,
    });
    assert.deepStrictEqual(parseStoryUrl('https://www.instagram.com/stories/someuser/'), {
      highlightId: null,
      username: 'someuser',
      mediaId: null,
    });
    assert.strictEqual(parseStoryUrl('https://www.instagram.com/stories/highlights/'), null);
  });

  test('parseStoryUrl rejects other /s/ links, profiles, posts and lookalike hosts', () => {
    assert.strictEqual(
      isInstagramStoryUrl('https://www.instagram.com/s/bm90IGEgaGlnaGxpZ2h0'),
      false
    );
    assert.strictEqual(isInstagramStoryUrl('https://www.instagram.com/p/DbzojBsOC6p/'), false);
    assert.strictEqual(isInstagramStoryUrl('https://instagram.com.evil.com/stories/u/123/'), false);
    assert.strictEqual(isInstagramStoryUrl('not a url'), false);
  });
});

describe('downloadFromInstagram stories', () => {
  const cookieFile = path.join(os.tmpdir(), `ig-cookies-${process.pid}.json`);
  const previousPath = process.env.INSTAGRAM_COOKIES_PATH;
  let spy;

  const stubApi = (routes, bytes = Buffer.from('media')) => {
    const calls = [];
    fs.writeFileSync(cookieFile, JSON.stringify({ instagram: ['sessionid=abc; ds_user_id=1'] }));
    process.env.INSTAGRAM_COOKIES_PATH = cookieFile;
    spy = spyOn(axios, 'get').mockImplementation(async requestUrl => {
      calls.push(requestUrl);
      const route = Object.keys(routes).find(key => requestUrl.includes(key));
      if (route) {
        const result = routes[route];
        if (result instanceof Error) throw result;
        return { data: result, headers: {} };
      }
      return {
        data: Readable.from([bytes]),
        headers: { 'content-type': requestUrl.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg' },
      };
    });
    return calls;
  };

  afterEach(() => {
    spy?.mockRestore();
    fs.rmSync(cookieFile, { force: true });
    if (previousPath === undefined) delete process.env.INSTAGRAM_COOKIES_PATH;
    else process.env.INSTAGRAM_COOKIES_PATH = previousPath;
  });

  const item = (pk, url) => ({ pk, ...video(url) });
  const httpError = status => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

  test('a story link downloads the story video via the media-info route', async () => {
    const calls = stubApi({
      '/api/v1/media/3884905143972195700/info/': {
        items: [item('3884905143972195700', 'https://scontent.cdninstagram.com/story.mp4')],
      },
    });
    const result = await downloadFromInstagram(
      'https://www.instagram.com/stories/someuser/3884905143972195700/'
    );
    assert.strictEqual(result.contentType, 'video/mp4');
    assert.ok(calls[0].includes('/media/3884905143972195700/info/'));
  });

  test('a share link with story_media_id fetches that one item', async () => {
    const calls = stubApi({
      '/api/v1/media/3884905143972195700/info/': {
        items: [item('3884905143972195700', 'https://scontent.cdninstagram.com/one.mp4')],
      },
    });
    const result = await downloadFromInstagram(
      `${highlightShare('17966681567900583')}?story_media_id=3884905143972195700`
    );
    assert.ok(!Array.isArray(result));
    assert.strictEqual(calls.filter(c => c.includes('reels_media')).length, 0);
  });

  test('a highlight link without a story id downloads every item as a gallery', async () => {
    stubApi({
      reels_media: {
        reels_media: [
          {
            items: [
              item('1', 'https://scontent.cdninstagram.com/a.mp4'),
              { pk: '2', ...image('https://scontent.cdninstagram.com/b.jpg') },
            ],
          },
        ],
      },
    });
    const result = await downloadFromInstagram(
      'https://www.instagram.com/stories/highlights/1796/'
    );
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[1].contentType, 'image/jpeg');
  });

  test('media-info failure falls back to the highlight feed and picks the item by pk', async () => {
    const calls = stubApi({
      '/api/v1/media/22/info/': httpError(404),
      reels_media: {
        reels_media: [
          {
            items: [
              item('11', 'https://scontent.cdninstagram.com/x.mp4'),
              item('22', 'https://scontent.cdninstagram.com/y.mp4'),
            ],
          },
        ],
      },
    });
    const result = await downloadFromInstagram(`${highlightShare('5')}?story_media_id=22`);
    assert.ok(!Array.isArray(result));
    assert.ok(calls.some(c => c.includes('reels_media')));
  });

  test('an expired story surfaces a story-specific message', async () => {
    stubApi({ '/api/v1/media/9/info/': httpError(404) });
    await assert.rejects(
      downloadFromInstagram('https://www.instagram.com/stories/someuser/9/'),
      /this story is unavailable, it may have expired/
    );
  });

  test('a highlight the feed no longer returns is reported unavailable', async () => {
    stubApi({ reels_media: { reels_media: [] } });
    await assert.rejects(
      downloadFromInstagram('https://www.instagram.com/stories/highlights/1796/'),
      /this story is unavailable/
    );
  });

  const search = { users: [{ user: { pk: '77', username: 'SomeUser' } }] };

  test('a bare user stories link resolves the user id and downloads the whole reel', async () => {
    const calls = stubApi({
      topsearch: search,
      'reels_media/?reel_ids=77': {
        reels: {
          77: {
            items: [
              item('1', 'https://scontent.cdninstagram.com/a.mp4'),
              item('2', 'https://scontent.cdninstagram.com/b.mp4'),
            ],
          },
        },
      },
    });
    const result = await downloadFromInstagram('https://www.instagram.com/stories/someuser/');
    assert.strictEqual(result.length, 2);
    assert.ok(calls.some(c => c.startsWith('https://i.instagram.com/api/v1/feed/reels_media')));
  });

  test('a story id that media-info rejects falls back to that item in the user reel', async () => {
    stubApi({
      '/media/9/info/': httpError(400),
      topsearch: search,
      reels_media: {
        reels_media: [
          {
            items: [
              item('8', 'https://scontent.cdninstagram.com/x.mp4'),
              item('9', 'https://scontent.cdninstagram.com/y.mp4'),
            ],
          },
        ],
      },
    });
    const result = await downloadFromInstagram('https://www.instagram.com/stories/someuser/9/');
    assert.ok(!Array.isArray(result));
  });

  test('a user with no live story is CONTENT_GONE', async () => {
    stubApi({ topsearch: search, reels_media: { reels: {}, status: 'ok' } });
    await assert.rejects(
      downloadFromInstagram('https://www.instagram.com/stories/someuser/'),
      error => error.code === 'CONTENT_GONE' && /this story is unavailable/.test(error.message)
    );
  });

  test('an unknown username is CONTENT_GONE', async () => {
    stubApi({ topsearch: { users: [{ user: { pk: '5', username: 'other' } }] } });
    await assert.rejects(
      downloadFromInstagram('https://www.instagram.com/stories/someuser/'),
      error => error.code === 'CONTENT_GONE'
    );
  });

  test('an Instagram 500 logs the endpoint and status and stays a network error', async () => {
    stubApi({ topsearch: httpError(500) });
    await assert.rejects(
      downloadFromInstagram('https://www.instagram.com/stories/someuser/'),
      /failed to reach instagram/
    );
  });

  test('an Instagram 500 keeps the endpoint and status as the cause', async () => {
    stubApi({ topsearch: httpError(500) });
    const error = await downloadFromInstagram('https://www.instagram.com/stories/someuser/').catch(
      caught => caught
    );
    assert.match(
      error.cause.message,
      /^instagram www\.instagram\.com\/api\/v1\/web\/search\/topsearch\/ HTTP 500$/
    );
  });
});
