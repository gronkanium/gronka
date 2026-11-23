import { describe, test, afterEach, spyOn } from 'bun:test';
import assert from 'node:assert';
import axios from 'axios';
import { isAppleMusicUrl, appleMusicTrack } from '../../src/utils/apple-music.js';

const LOOKUP = {
  resultCount: 1,
  results: [
    {
      wrapperType: 'track',
      trackName: 'Love Is a Long Road',
      artistName: 'Tom Petty',
      trackTimeMillis: 247_093,
      releaseDate: '1989-04-24T07:00:00Z',
      primaryGenreName: 'Rock',
      artworkUrl100:
        'https://is1-ssl.mzstatic.com/image/thumb/Music112/v4/f3/06UMGIM04214.rgb.jpg/100x100bb.jpg',
    },
  ],
};

describe('apple music', () => {
  let spy;
  afterEach(() => spy?.mockRestore());

  test('apple music hosts only', () => {
    assert.ok(isAppleMusicUrl('https://music.apple.com/us/song/love-is-a-long-road/1440825626'));
    assert.ok(isAppleMusicUrl('https://geo.music.apple.com/us/album/a/1?i=2'));
    assert.ok(!isAppleMusicUrl('https://music.apple.com.evil.com/us/song/a/1'));
    assert.ok(!isAppleMusicUrl('https://podcasts.apple.com/us/podcast/a/id1'));
  });

  test('an album link with ?i= looks that song up for title, artist, length and cover', async () => {
    spy = spyOn(axios, 'get').mockResolvedValue({ data: LOOKUP });
    const track = await appleMusicTrack(
      'https://music.apple.com/us/album/love-is-a-long-road/1440825367?i=1440825626'
    );
    assert.strictEqual(
      spy.mock.calls[0][0],
      'https://itunes.apple.com/lookup?id=1440825626&country=us'
    );
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

  test('a length is whole seconds rounded down, as the song page shows it', async () => {
    const song = { ...LOOKUP.results[0], trackTimeMillis: 221_600 };
    spy = spyOn(axios, 'get').mockResolvedValue({ data: { results: [song] } });
    const track = await appleMusicTrack('https://music.apple.com/gr/song/o-manolis/723886726');
    assert.strictEqual(track.duration, 221);
  });

  test('a song link keeps its storefront', async () => {
    spy = spyOn(axios, 'get').mockResolvedValue({ data: LOOKUP });
    await appleMusicTrack('https://music.apple.com/gb/song/love-is-a-long-road/1440825626');
    assert.strictEqual(
      spy.mock.calls[0][0],
      'https://itunes.apple.com/lookup?id=1440825626&country=gb'
    );
  });

  test('playlists and artists are refused before any request', async () => {
    spy = spyOn(axios, 'get');
    for (const url of [
      'https://music.apple.com/us/playlist/a/pl.u-abc',
      'https://music.apple.com/us/artist/tom-petty/5072272',
      'https://music.apple.com/us/music-video/a/1',
    ]) {
      await assert.rejects(appleMusicTrack(url), {
        name: 'ValidationError',
        message: /playlists and artists are not supported/,
      });
    }
    assert.strictEqual(spy.mock.calls.length, 0);
  });

  test('a song the store no longer lists reads as gone, not as a hiccup to retry', async () => {
    spy = spyOn(axios, 'get').mockResolvedValue({ data: { resultCount: 0, results: [] } });
    await assert.rejects(appleMusicTrack('https://music.apple.com/us/song/a/1440825626'), {
      code: 'CONTENT_GONE',
      message: "that apple music song isn't in that store anymore.",
    });
  });

  test('a lookup answer without the song is a curated failure, not a blind search', async () => {
    spy = spyOn(axios, 'get').mockResolvedValue({ data: { results: [{ wrapperType: 'artist' }] } });
    await assert.rejects(appleMusicTrack('https://music.apple.com/us/song/a/1440825626'), {
      message: /couldn't read that apple music song/,
    });
  });
});
