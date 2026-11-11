import { describe, test, afterEach, spyOn } from 'bun:test';
import assert from 'node:assert';
import axios from 'axios';
import { isAppleMusicUrl, appleMusicTrack } from '../../src/utils/apple-music.js';

const SONG = {
  '@type': 'MusicComposition',
  name: 'Love Is a Long Road',
  audio: {
    name: 'Love Is a Long Road',
    datePublished: '1989-04-24',
    duration: 'PT4M7S',
    image:
      'https://is1-ssl.mzstatic.com/image/thumb/Music112/v4/f3/06UMGIM04214.rgb.jpg/1200x630bb.jpg',
    byArtist: [{ '@type': 'MusicGroup', name: 'Tom Petty' }],
    genre: ['Rock', 'Music'],
  },
};
const PAGE = `<html><head><script id=schema:song type="application/ld+json">${JSON.stringify(SONG)}</script></head></html>`;

describe('apple music', () => {
  let spy;
  afterEach(() => spy?.mockRestore());

  test('apple music hosts only', () => {
    assert.ok(isAppleMusicUrl('https://music.apple.com/us/song/love-is-a-long-road/1440825626'));
    assert.ok(isAppleMusicUrl('https://geo.music.apple.com/us/album/a/1?i=2'));
    assert.ok(!isAppleMusicUrl('https://music.apple.com.evil.com/us/song/a/1'));
    assert.ok(!isAppleMusicUrl('https://podcasts.apple.com/us/podcast/a/id1'));
  });

  test('an album link with ?i= reads that song page for title, artist, length and cover', async () => {
    spy = spyOn(axios, 'get').mockResolvedValue({ data: PAGE });
    const track = await appleMusicTrack(
      'https://music.apple.com/us/album/love-is-a-long-road/1440825367?i=1440825626'
    );
    assert.strictEqual(spy.mock.calls[0][0], 'https://music.apple.com/us/song/1440825626');
    assert.ok(spy.mock.calls[0][1].lookup);
    assert.deepStrictEqual(track, {
      site: 'apple music',
      title: 'Love Is a Long Road',
      artist: 'Tom Petty',
      duration: 247,
      year: '1989',
      genre: 'Rock',
      cover:
        'https://is1-ssl.mzstatic.com/image/thumb/Music112/v4/f3/06UMGIM04214.rgb.jpg/600x600bb.jpg',
    });
  });

  test('a song link keeps its storefront', async () => {
    spy = spyOn(axios, 'get').mockResolvedValue({ data: PAGE });
    await appleMusicTrack('https://music.apple.com/gb/song/love-is-a-long-road/1440825626');
    assert.strictEqual(spy.mock.calls[0][0], 'https://music.apple.com/gb/song/1440825626');
  });

  test('albums, playlists and artists are refused before any request', async () => {
    spy = spyOn(axios, 'get');
    for (const url of [
      'https://music.apple.com/us/album/full-moon-fever/1440825367',
      'https://music.apple.com/us/playlist/a/pl.u-abc',
      'https://music.apple.com/us/artist/tom-petty/5072272',
      'https://music.apple.com/us/music-video/a/1',
    ]) {
      await assert.rejects(appleMusicTrack(url), {
        name: 'ValidationError',
        message: /song links/,
      });
    }
    assert.strictEqual(spy.mock.calls.length, 0);
  });

  test('a page without song data is a curated failure, not a blind search', async () => {
    spy = spyOn(axios, 'get').mockResolvedValue({ data: '<html></html>' });
    await assert.rejects(appleMusicTrack('https://music.apple.com/us/song/a/1440825626'), {
      message: /couldn't read that apple music song/,
    });
  });
});
