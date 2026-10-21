import { describe, test, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import {
  ENGINES,
  ROUTES,
  routeFor,
  arrangeChain,
  chainFor,
  isEnabled,
} from '../../src/core/sources.js';
import { DOWNLOAD_SERVICE_IDS, getServiceForUrl } from '../../src/utils/download-services.js';
import { setSetting } from '../../src/utils/database.js';

const ROUTED = [
  ['https://www.youtube.com/watch?v=abc', 'youtube'],
  ['https://youtu.be/abc', 'youtube'],
  ['https://medal.tv/games/x/clips/nJTQxdciaB7h8wwtq', 'medal'],
  ['https://imgur.com/gallery/abc', 'ytdlp'],
  ['https://i.imgur.com/abc.gif', 'ytdlp'],
  ['https://i.imgur.com/abc.jpg', 'direct'],
  ['https://v.redd.it/abc/HLSPlaylist.m3u8', 'ytdlp'],
  ['https://www.pornhub.com/view_video.php?viewkey=abc', 'ytdlp'],
  ['https://www.deviantart.com/someone/art/thing-123456', 'deviantart'],
  ['https://www.deviantart.com/someone/gallery', 'gallery-dl'],
  ['https://www.artstation.com/artwork/abc', 'gallery-dl'],
  ['https://danbooru.donmai.us/posts/123', 'booru'],
  ['https://www.pinterest.com/pin/123/', 'pinterest'],
  ['https://klipy.com/gifs/some-gif', 'klipy'],
  ['https://jumpshare.com/s/abc123', 'jumpshare'],
  ['https://www.threads.com/@someone/post/ABC123', 'threads'],
  ['https://mega.nz/file/AbCdEfGh#' + 'a'.repeat(43), 'mega'],
  ['https://example.com/clip.mp4', 'direct'],
  ['https://www.facebook.com/photo.php?fbid=1&set=a.2&type=3', 'facebook-photo'],
  ['https://www.facebook.com/someone/photos/a.1/2/', 'facebook-photo'],
  ['https://www.facebook.com/watch/?v=1', 'facebook'],
  ['https://x.com/a/status/1', 'x'],
  ['https://www.tiktok.com/@a/video/1', 'tiktok'],
  ['https://www.reddit.com/r/a/comments/abc/x/', 'social'],
  ['https://www.instagram.com/p/abc/', 'instagram'],
  ['https://bsky.app/profile/a/post/b', 'social'],
  ['https://open.spotify.com/track/1', null],
  ['https://example.com/page', null],
];

afterAll(() => setSetting('source_routes', '{}'));

describe('source routes', () => {
  for (const [url, id] of ROUTED) {
    test(`${url} -> ${id}`, () => {
      assert.equal(routeFor(url)?.id ?? null, id);
    });
  }

  test('every chain names real engines, once each', () => {
    for (const route of ROUTES) {
      const engines = route.chain.map(s => s.engine);
      assert.equal(new Set(engines).size, engines.length, route.id);
      for (const engine of engines) assert.ok(ENGINES[engine], `${route.id}: ${engine}`);
    }
  });

  test('saved order applies, unknown steps drop, new steps keep their default place', () => {
    const tiktok = ROUTES.find(r => r.id === 'tiktok');
    const saved = {
      tiktok: [{ engine: 'ytdlp' }, { engine: 'nope' }, { engine: 'cobalt', on: false }],
    };
    assert.deepEqual(
      arrangeChain(tiktok, saved).map(s => `${s.engine}:${s.on}`),
      ['ytdlp:true', 'cobalt:false', 'gallery-dl:true']
    );
  });

  test('a step saved twice runs once', () => {
    const tiktok = ROUTES.find(r => r.id === 'tiktok');
    const saved = { tiktok: Array.from({ length: 500 }, () => ({ engine: 'ytdlp' })) };
    assert.deepEqual(
      arrangeChain(tiktok, saved).map(s => s.engine),
      ['ytdlp', 'cobalt', 'gallery-dl']
    );
  });

  test('chainFor follows the saved order and skips steps that do not apply', async () => {
    const video = 'https://www.tiktok.com/@a/video/1';
    const live = ids => ids.filter(id => isEnabled(ENGINES[id]));
    assert.deepEqual(
      (await chainFor(video)).engines.map(e => e.id),
      live(['cobalt', 'ytdlp'])
    );
    await setSetting(
      'source_routes',
      JSON.stringify({ tiktok: [{ engine: 'ytdlp' }, { engine: 'cobalt' }] })
    );
    assert.deepEqual(
      (await chainFor(video)).engines.map(e => e.id),
      live(['ytdlp', 'cobalt'])
    );
    await setSetting('source_routes', '{}');
  });

  test('a Facebook post reaches gallery-dl after yt-dlp; a video page does not', () => {
    const steps = url =>
      routeFor(url)
        .chain.filter(s => !s.when || s.when(url))
        .map(s => s.engine);
    assert.deepEqual(steps('https://www.facebook.com/someone/posts/123/'), [
      'cobalt',
      'ytdlp',
      'gallery-dl',
    ]);
    assert.deepEqual(steps('https://www.facebook.com/watch?v=1'), ['cobalt', 'ytdlp']);
  });

  test('a link whose every step is switched off is refused as turned off', async () => {
    await setSetting(
      'source_routes',
      JSON.stringify({
        tiktok: [
          { engine: 'cobalt', on: false },
          { engine: 'ytdlp', on: false },
        ],
      })
    );
    const { engines, disabled } = await chainFor('https://www.tiktok.com/@a/video/1');
    assert.deepEqual(engines, []);
    assert.equal(disabled.disabledMessage(), 'downloads from TikTok are turned off.');
    await setSetting('source_routes', '{}');
  });

  test('every source switch has a unique id and finds its own hosts', () => {
    const ids = ROUTES.flatMap(route => (route.services ?? []).map(service => service.id));
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.ok(DOWNLOAD_SERVICE_IDS.has(id), id);
    assert.equal(getServiceForUrl('https://klipy.com/gifs/x')?.id, 'klipy');
    assert.equal(getServiceForUrl('https://medal.tv/clips/x')?.id, 'medal');
  });
});
