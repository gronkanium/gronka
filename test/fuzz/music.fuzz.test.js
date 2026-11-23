import { test, describe, expect, spyOn, afterEach } from 'bun:test';
import axios from 'axios';
import { appleMusicTrack, appleAlbumTracks } from '../../src/utils/apple-music.js';
import { collectionOf } from '../../src/utils/collections.js';
import { pickMatch, pickSaavn, norm } from '../../src/utils/soundcloud.js';
import { NetworkError, ValidationError } from '../../src/utils/errors.js';
import { rng, junk, SEED, ITERATIONS, describeCase } from './rng.js';

const WORDS = [
  'Dreams',
  'Love',
  'Is',
  'a',
  'Long',
  'Road',
  'Situations',
  'Ünïcödé',
  '東京',
  'Ночь',
  'سلام',
  'तुम ही हो',
  '🦆',
  '&amp;',
  "'",
  'Op. 18 No. 1: I. Allegro',
];
const VERSIONS = [
  '(Remix)',
  '(Live)',
  '(Acoustic)',
  '(Demo Version)',
  '(feat. Chris Brown)',
  '[Remastered 2011]',
  ' - 2004 Remaster',
  ' - Jump Smokers Extended Mix',
  '(Sped Up)',
  '(In The Style Of X)',
  '(Karaoke Version)',
  '(',
  ')',
  ' - ',
  '[',
];
const ARTISTS = [
  'Tom Petty',
  'Tyler, The Creator',
  'A & B',
  'C x D',
  'Jack Johnson',
  'Beyoncé',
  'ZUTOMAYO',
  '',
];

const title = r =>
  r.chance(0.1)
    ? junk(r, 80)
    : Array.from({ length: r.int(4, 1) }, () => r.pick(WORDS)).join(' ') +
      (r.chance(0.4) ? r.pick(VERSIONS) : '');
const seconds = r =>
  r.chance(0.1)
    ? r.pick([null, undefined, 0])
    : r.int(600, 1) + (r.chance(0.3) ? r.int(1000) / 1000 : 0);

function track(r) {
  return {
    artist: r.chance(0.8) ? r.pick(ARTISTS) : junk(r, 20),
    title: title(r),
    duration: seconds(r),
  };
}

function entry(r, t) {
  const artist = r.chance(0.6) ? t.artist : r.pick(ARTISTS);
  return {
    id: junk(r, 11),
    title: r.chance(0.5)
      ? `${artist} - ${t.title}${r.chance(0.3) ? r.pick(VERSIONS) : ''}`
      : title(r),
    channel: r.pick([artist, `${artist} - Topic`, 'Some Uploader', null, junk(r, 12)]),
    channel_is_verified: r.chance(0.3),
    duration:
      typeof t.duration === 'number' && r.chance(0.6) ? t.duration + r.int(7) - 3 : seconds(r),
    description: r.chance(0.3)
      ? `Provided to YouTube by Label ${t.title} · ${artist}`
      : junk(r, 30),
  };
}

const VARIANT = /\b(remix|sped ?up|slowed|nightcore|cover|live|karaoke|acoustic|demo|style of)\b/gi;
const variantsOf = text => new Set((String(text).match(VARIANT) ?? []).map(norm));

describe('music fuzz', () => {
  let spy;
  afterEach(() => spy?.mockRestore());

  test(`the youtube picker returns one of the given entries, of the same length and version, or nothing (seed ${SEED})`, () => {
    const r = rng(SEED + 10);
    for (let i = 0; i < ITERATIONS; i++) {
      const t = track(r);
      const entries = Array.from({ length: r.int(25) }, () => entry(r, t));
      const why = describeCase(SEED, i, { t, titles: entries.map(e => e.title) });
      let got;
      expect(() => (got = pickMatch(t, entries))).not.toThrow();
      if (got === null) continue;
      expect([why, entries.includes(got)]).toEqual([why, true]);
      expect([why, Math.abs(got.duration - t.duration) <= 2]).toEqual([why, true]);
      expect([why, [...variantsOf(got.title)].sort()]).toEqual([
        why,
        [...variantsOf(t.title)].sort(),
      ]);
    }
  });

  test(`jiosaavn picker returns only a 320k file of the same length, or nothing (seed ${SEED})`, () => {
    const r = rng(SEED + 11);
    for (let i = 0; i < ITERATIONS; i++) {
      const t = track(r);
      const songs = Array.from({ length: r.int(10) }, () => {
        const e = entry(r, t);
        return {
          title: r.chance(0.5) ? t.title : e.title,
          perma_url: `https://www.jiosaavn.com/song/${i}/${r.next()}`,
          more_info: r.chance(0.1)
            ? undefined
            : {
                '320kbps': r.pick(['true', 'false', true, undefined]),
                duration: String(e.duration),
                artistMap: r.chance(0.1)
                  ? null
                  : { primary_artists: [{ name: r.chance(0.6) ? t.artist : r.pick(ARTISTS) }] },
              },
        };
      });
      let url;
      expect(() => (url = pickSaavn(t, songs))).not.toThrow();
      if (url === null) continue;
      const song = songs.find(s => s.perma_url === url);
      const why = describeCase(SEED, i, { t, song });
      expect([why, song.more_info['320kbps']]).toEqual([why, 'true']);
      expect([why, Math.abs(Number(song.more_info.duration) - t.duration) <= 2]).toEqual([
        why,
        true,
      ]);
    }
  });

  test(`matchers stay fast on 4k-character titles built from brackets and dashes (seed ${SEED})`, () => {
    const r = rng(SEED + 12);
    const blocks = ['(', ')', '[', ']', ' - ', 'feat. ', 'remaster', ' ', 'a', ':', '·', '&amp;'];
    for (let i = 0; i < 30; i++) {
      const long = Array.from({ length: 1024 }, () => r.pick(blocks))
        .join('')
        .slice(0, 4096);
      const t = { artist: long.slice(0, 200), title: long, duration: 200 };
      const entries = Array.from({ length: 20 }, () => ({
        title: long,
        channel: long,
        duration: 200,
        description: long,
      }));
      const started = Date.now();
      pickMatch(t, entries);
      pickSaavn(
        t,
        entries.map(e => ({ ...e, more_info: { '320kbps': 'true', duration: '200' } }))
      );
      expect([describeCase(SEED, i, long.slice(0, 60)), Date.now() - started < 250]).toEqual([
        describeCase(SEED, i, long.slice(0, 60)),
        true,
      ]);
    }
  });

  test(`an apple music link is a song, an album list, or a curated refusal before any request (seed ${SEED})`, async () => {
    const r = rng(SEED + 13);
    const id = () =>
      r.pick([String(r.int(2e9, 1)), '0', '', 'abc', '١٢٣', '1e9', `${r.int(99)}x`, junk(r, 8)]);
    const store = () => r.pick(['us', 'gb', 'jp', 'in', 'US', 'usa', 'u', '', '12', junk(r, 3)]);
    const kind = () =>
      r.pick([
        `album/${junk(r, 10)}/${id()}`,
        `album/${id()}`,
        `song/${junk(r, 10)}/${id()}`,
        `song/${id()}`,
        `playlist/x/pl.${id()}`,
        `artist/x/${id()}`,
        `music-video/x/${id()}`,
        `station/x/ra.${id()}`,
        junk(r, 20),
      ]);
    let requests = [];
    spy = spyOn(axios, 'get').mockImplementation(async url => {
      requests.push(url);
      return { data: { resultCount: 0, results: [] } };
    });
    for (let i = 0; i < ITERATIONS; i++) {
      const params = r.chance(0.5) ? `?i=${id()}${r.chance(0.3) ? `&l=${junk(r, 4)}` : ''}` : '';
      let url;
      try {
        url = new URL(`https://music.apple.com/${store()}/${kind()}${params}`).href;
      } catch {
        continue;
      }
      const why = describeCase(SEED, i, url);
      requests = [];
      const list = collectionOf(url);
      let error = null;
      await appleMusicTrack(url).catch(caught => (error = caught));
      expect([why, error instanceof ValidationError || error instanceof NetworkError]).toEqual([
        why,
        true,
      ]);
      if (error instanceof ValidationError) {
        expect([why, requests.length]).toEqual([why, 0]);
        continue;
      }
      expect([why, list]).toEqual([why, null]);
      expect([why, requests.length]).toEqual([why, 1]);
      expect([
        why,
        /^https:\/\/itunes\.apple\.com\/lookup\?id=\d+&country=[a-z]{2}$/.test(requests[0]),
      ]).toEqual([why, true]);
    }
  });

  test(`any lookup answer in apple's schema gives a well-formed track or a curated failure (seed ${SEED})`, async () => {
    const r = rng(SEED + 14);
    const text = good => (r.chance(0.7) ? good : r.pick([null, undefined, '', junk(r, 12)]));
    for (let i = 0; i < ITERATIONS; i++) {
      const results = Array.from({ length: r.int(4) }, () => ({
        wrapperType: r.pick(['track', 'collection', 'artist', '', undefined]),
        trackName: text(title(r)),
        artistName: text(r.pick(ARTISTS)),
        trackTimeMillis: r.chance(0.8) ? r.int(1e8, 1000) : r.pick([null, undefined, 0]),
        releaseDate: text('1989-04-24T07:00:00Z'),
        primaryGenreName: text(r.pick(['Rock', 'Music'])),
        artworkUrl100: text('https://is1-ssl.mzstatic.com/a/100x100bb.jpg'),
      }));
      const data = r.chance(0.1)
        ? r.pick([null, '', '<html>', {}, { results: null }])
        : { resultCount: results.length, results };
      spy?.mockRestore();
      spy = spyOn(axios, 'get').mockResolvedValue({ data });
      const why = describeCase(SEED, i, data);
      let got;
      let error = null;
      await appleMusicTrack('https://music.apple.com/us/song/x/1440825626').then(
        t => (got = t),
        caught => (error = caught)
      );
      if (error) {
        expect([why, error instanceof NetworkError]).toEqual([why, true]);
        expect([
          why,
          [
            "couldn't read that apple music song right now.",
            "that apple music song isn't in that store anymore.",
          ].includes(error.message),
        ]).toEqual([why, true]);
        continue;
      }
      expect([why, typeof got.title, typeof got.artist]).toEqual([why, 'string', 'string']);
      expect([why, Number.isInteger(got.duration) && got.duration > 0]).toEqual([why, true]);
    }
  });

  test(`an album lookup of any shape lists tracks in disc and track order, each with its own link (seed ${SEED})`, async () => {
    const r = rng(SEED + 15);
    for (let i = 0; i < ITERATIONS / 4; i++) {
      const results = Array.from({ length: r.int(60) }, () => ({
        wrapperType: r.pick(['track', 'track', 'track', 'collection']),
        trackViewUrl: r.chance(0.9)
          ? `https://music.apple.com/us/album/x/1?i=${r.int(1e9)}`
          : undefined,
        discNumber: r.int(4, 1),
        trackNumber: r.int(40, 1),
        trackName: title(r),
        artistName: r.pick(ARTISTS),
        trackTimeMillis: r.chance(0.9) ? r.int(9e5, 1000) : undefined,
        collectionName: 'Album',
        trackCount: r.int(80),
      }));
      spy?.mockRestore();
      spy = spyOn(axios, 'get').mockResolvedValue({ data: { results } });
      const listed = await appleAlbumTracks('us', '1');
      const why = describeCase(SEED, i, results.length);
      const tracks = results.filter(x => x.wrapperType === 'track' && x.trackViewUrl);
      expect([why, listed.entries.length]).toEqual([why, tracks.length]);
      const order = listed.entries.map(e => tracks.find(t => t.trackViewUrl === e.url));
      for (let k = 1; k < order.length; k++) {
        const [a, b] = [order[k - 1], order[k]];
        expect([
          why,
          a.discNumber < b.discNumber ||
            (a.discNumber === b.discNumber && a.trackNumber <= b.trackNumber),
        ]).toEqual([why, true]);
      }
      for (const e of listed.entries) {
        expect([
          why,
          e.duration === null || (Number.isInteger(e.duration) && e.duration > 0),
        ]).toEqual([why, true]);
      }
    }
  });
});
