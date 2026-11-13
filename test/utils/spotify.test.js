import { describe, test, afterEach, spyOn } from 'bun:test';
import assert from 'node:assert';
import axios from 'axios';
import {
  isSpotifyUrl,
  spotifyTrack,
  spotifyEpisode,
  feedEpisode,
} from '../../src/utils/spotify.js';

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

  test('albums, playlists, shows and artists are refused before any request', async () => {
    spy = spyOn(axios, 'get');
    for (const url of [
      'https://open.spotify.com/album/2jgKK8iIX83mPrCyDhvEdf',
      'https://open.spotify.com/intl-fr/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x',
      'https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk',
      'https://open.spotify.com/artist/5v2WhpA59TJSdPh7LCx1lN',
      'https://spotify.link/unresolved',
    ]) {
      await assert.rejects(spotifyTrack(url), {
        name: 'ValidationError',
        message: /track and episode links/,
      });
    }
    assert.strictEqual(spy.mock.calls.length, 0);
  });

  test('reads the episode page for its title and show', async () => {
    spy = spyOn(axios, 'get').mockResolvedValue({
      data: `<meta property="og:title" content="#12 - Rock &amp; Roll"/>
<meta property="og:description" content="Tom &amp; Jerry&#x27;s Show · Episode"/>
<meta name="music:release_date" content="2026-11-13T18:30:00Z"/>`,
    });
    for (const url of [
      'https://open.spotify.com/intl-de/episode/7Hf1JDw7XuetyEqlrIQLaG?si=x',
      'https://open.spotify.com/embed/episode/7Hf1JDw7XuetyEqlrIQLaG/video?utm_source=generator',
    ]) {
      spy.mockClear();
      assert.deepStrictEqual(await spotifyEpisode(url), {
        title: '#12 - Rock & Roll',
        show: "Tom & Jerry's Show",
        year: '2026',
      });
      assert.strictEqual(
        spy.mock.calls[0][0],
        'https://open.spotify.com/episode/7Hf1JDw7XuetyEqlrIQLaG'
      );
    }
  });

  describe('feedEpisode', () => {
    const EPISODE = { title: '#12 - Rock & Roll', show: 'The Show', year: '2026' };
    const SHOWS = [
      { collectionId: 9, collectionName: 'The Show Recaps' },
      { collectionId: 1, collectionName: 'The Show' },
    ];
    const entry = (collectionId, trackName) => ({
      collectionId,
      trackName,
      episodeUrl: `https://cdn.example/${collectionId}/${trackName.length}.mp3`,
    });
    const directory = (shows, recent, searched = []) =>
      spyOn(axios, 'get').mockImplementation(async url => {
        const { pathname, searchParams } = new URL(url);
        if (pathname === '/lookup') return { data: { results: recent } };
        return {
          data: { results: searchParams.get('entity') === 'podcast' ? shows : searched },
        };
      });

    test("takes the show's own episode with the same title", async () => {
      spy = directory(SHOWS, [entry(9, '#12 - Rock & Roll'), entry(1, '#12 - Rock & Roll!')]);
      const found = await feedEpisode(EPISODE);
      assert.strictEqual(found.collectionId, 1);
      assert.strictEqual(new URL(spy.mock.calls[1][0]).searchParams.get('id'), '1');
    });

    test('an older episode is found by searching its title', async () => {
      spy = directory(SHOWS, [entry(1, '#40 - Newer')], [entry(1, '#12 - Rock & Roll')]);
      const found = await feedEpisode(EPISODE);
      assert.strictEqual(found.trackName, '#12 - Rock & Roll');
      assert.strictEqual(spy.mock.calls.length, 3);
    });

    test('a show outside the public directory is refused as spotify-only', async () => {
      spy = directory([SHOWS[0]], []);
      await assert.rejects(
        feedEpisode(EPISODE),
        error =>
          error.code === 'DRM_PROTECTED' &&
          /only on spotify/.test(error.message) &&
          /no show named "The Show"/.test(error.cause.message)
      );
    });

    test('a missing episode names the show it searched', async () => {
      spy = directory(SHOWS, [entry(1, '#40 - Newer')]);
      await assert.rejects(feedEpisode(EPISODE), error =>
        /shows 1 have no episode titled/.test(error.cause.message)
      );
    });
  });

  test('a page without track details is a curated failure, not a blind search', async () => {
    spy = spyOn(axios, 'get').mockResolvedValue({ data: '<html></html>' });
    await assert.rejects(spotifyTrack('https://open.spotify.com/track/7I4ibsZgwuf46g0xHuTC8s'), {
      message: /couldn't read that spotify track/,
    });
  });
});
