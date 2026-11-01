import { describe, test, afterEach, spyOn } from 'bun:test';
import assert from 'node:assert';
import axios from 'axios';
import { isSpotifyUrl, spotifyTrack } from '../../src/utils/spotify.js';

const PAGE = `<html><head>
<meta property="og:title" content="Don&#x27;t Stop &amp; Go"/>
<meta property="og:description" content="BONES · Rotten · Song · 2014"/>
<meta property="og:image" content="https://i.scdn.co/image/ab67616d0000b273f7d6"/>
<meta name="music:duration" content="139"/>
<meta name="music:release_date" content="2014-12-02"/>
<meta name="music:musician" content="https://open.spotify.com/artist/5v2W"/>
<meta name="music:musician_description" content="BONES"/>
<meta name="music:musician_description" content="Xavier Wulf"/>
</head></html>`;

describe('spotify', () => {
  let spy;
  afterEach(() => spy?.mockRestore());

  test('spotify hosts only', () => {
    assert.ok(isSpotifyUrl('https://open.spotify.com/track/7I4ibsZgwuf46g0xHuTC8s'));
    assert.ok(isSpotifyUrl('https://spotify.link/AbC'));
    assert.ok(isSpotifyUrl('https://spotify.app.link/AbC'));
    assert.ok(!isSpotifyUrl('https://open.spotify.com.evil.com/track/1'));
    assert.ok(!isSpotifyUrl('https://soundcloud.com/a/b'));
  });

  test('reads the public track page for title, lead artist, length and cover', async () => {
    spy = spyOn(axios, 'get').mockResolvedValue({ data: PAGE });
    const track = await spotifyTrack(
      'https://open.spotify.com/intl-de/track/7I4ibsZgwuf46g0xHuTC8s?si=abc123'
    );
    assert.strictEqual(
      spy.mock.calls[0][0],
      'https://open.spotify.com/track/7I4ibsZgwuf46g0xHuTC8s'
    );
    assert.ok(spy.mock.calls[0][1].lookup);
    assert.deepStrictEqual(track, {
      site: 'spotify',
      title: "Don't Stop & Go",
      artist: 'BONES',
      duration: 139,
      year: '2014',
      genre: null,
      cover: 'https://i.scdn.co/image/ab67616d0000b273f7d6',
    });
  });

  test('albums, playlists and podcasts are refused before any request', async () => {
    spy = spyOn(axios, 'get');
    for (const url of [
      'https://open.spotify.com/album/2jgKK8iIX83mPrCyDhvEdf',
      'https://open.spotify.com/intl-fr/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x',
      'https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk',
      'https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk',
      'https://open.spotify.com/artist/5v2WhpA59TJSdPh7LCx1lN',
      'https://spotify.link/unresolved',
    ]) {
      await assert.rejects(spotifyTrack(url), { name: 'ValidationError', message: /track links/ });
    }
    assert.strictEqual(spy.mock.calls.length, 0);
  });

  test('a page without track details is a curated failure, not a blind search', async () => {
    spy = spyOn(axios, 'get').mockResolvedValue({ data: '<html></html>' });
    await assert.rejects(spotifyTrack('https://open.spotify.com/track/7I4ibsZgwuf46g0xHuTC8s'), {
      message: /couldn't read that spotify track/,
    });
  });
});
