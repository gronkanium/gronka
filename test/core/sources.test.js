import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { SOURCES, routeFor, sourceById } from '../../src/core/sources.js';
import { DOWNLOAD_SERVICE_IDS, getServiceForUrl } from '../../src/utils/download-services.js';

const ROUTES = [
  ['https://www.youtube.com/watch?v=abc', 'ytdlp'],
  ['https://youtu.be/abc', 'ytdlp'],
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
  ['https://x.com/a/status/1', 'cobalt'],
  ['https://www.tiktok.com/@a/video/1', 'cobalt'],
  ['https://www.reddit.com/r/a/comments/abc/x/', 'cobalt'],
  ['https://www.instagram.com/p/abc/', 'cobalt'],
  ['https://bsky.app/profile/a/post/b', 'cobalt'],
  ['https://open.spotify.com/track/1', null],
  ['https://example.com/page', null],
];

describe('source table', () => {
  for (const [url, id] of ROUTES) {
    test(`${url} -> ${id}`, () => {
      assert.equal(routeFor(url)?.id ?? null, id);
    });
  }

  test('every source names its label and fallback correctly', () => {
    for (const source of SOURCES) {
      assert.equal(typeof source.label('https://example.com/'), 'string', source.id);
      if (source.fallback) assert.ok(sourceById(source.fallback), source.id);
      if (source.enabled) assert.equal(typeof source.disabledMessage, 'function', source.id);
    }
  });

  test('every source switch has a unique id and finds its own hosts', () => {
    const ids = SOURCES.flatMap(source => (source.services ?? []).map(service => service.id));
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.ok(DOWNLOAD_SERVICE_IDS.has(id), id);
    assert.equal(getServiceForUrl('https://klipy.com/gifs/x')?.id, 'klipy');
    assert.equal(getServiceForUrl('https://medal.tv/clips/x')?.id, 'medal');
  });
});
