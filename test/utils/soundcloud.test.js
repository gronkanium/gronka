import { test } from 'node:test';
import assert from 'node:assert';
import { pickMatch, pickSaavn, isSoundCloudUrl } from '../../src/utils/soundcloud.js';

const track = { artist: 'Lil Uzi Vert', title: 'XO Tour Llif3', duration: 182.753 };
// The real ytsearch results for this track on 2026-09-29, plus the traps a matcher must refuse.
const entries = [
  {
    id: 'WrsFXgQk5UI',
    channel: 'LIL UZI VERT',
    title: 'Lil Uzi Vert - XO Tour Llif3 (Official Music Video)',
    duration: 257,
  },
  {
    id: 'VcyFfcJbyeM',
    channel: 'LIL UZI VERT',
    title: 'Lil Uzi Vert - XO Tour Llif3 (Official Lyric Video)',
    duration: 181,
  },
  {
    id: 'Yf0ORKcSsMs',
    channel: 'Trap Area Zone / T.A.Z',
    title: 'Lil Uzi Vert - XO Tour Llif3 (Official Visualiser)',
    duration: 181,
  },
  {
    id: 'oJ-6Th-FG_A',
    channel: 'Dark City Sounds',
    title: 'Lil Uzi Vert - XO Tour Llif3 | Lyrics',
    duration: 183,
  },
  { id: '1rc3yUJWosg', channel: 'LIL UZI VERT', title: 'XO Tour Llif3', duration: 183 },
];

test('picks the artist upload of the same length', () => {
  assert.strictEqual(pickMatch(track, entries)?.id, '1rc3yUJWosg');
});

test('prefers the Topic art track when both fit', () => {
  const topic = {
    id: 'topic1',
    channel: 'Lil Uzi Vert - Topic',
    title: 'XO Tour Llif3',
    duration: 183,
  };
  assert.strictEqual(pickMatch(track, [...entries, topic])?.id, 'topic1');
});

test('refuses re-uploads, variants and wrong lengths rather than guess', () => {
  const traps = [
    { id: 'a', channel: 'Some Fan', title: 'XO Tour Llif3', duration: 183 },
    { id: 'b', channel: 'LIL UZI VERT', title: 'XO Tour Llif3 (sped up)', duration: 182 },
    { id: 'c', channel: 'LIL UZI VERT', title: 'XO Tour Llif3', duration: 190 },
    { id: 'd', channel: 'LIL UZI VERT', title: 'Money Longer', duration: 183 },
  ];
  assert.strictEqual(pickMatch(track, traps), null);
});

test('a remix on soundcloud may match a remix on youtube', () => {
  const remix = { ...track, title: 'XO Tour Llif3 (Remix)' };
  const hit = { id: 'r', channel: 'LIL UZI VERT', title: 'XO Tour Llif3 Remix', duration: 182 };
  assert.strictEqual(pickMatch(remix, [hit])?.id, 'r');
});

// The real ytsearch results for these tracks on 2026-11-01.
test('takes a Topic art track of the exact title even when the artist is spelled in another script', () => {
  const song = { artist: 'Peremotka', title: 'Встречная', duration: 242 };
  const results = [
    { id: 'fan', channel: 'Speck of Dust', title: 'Перемотка - Встречная', duration: 241 },
    {
      id: 'video',
      channel: 'Перемотка / Peremotka',
      title: 'Перемотка – Встречная',
      duration: 232,
    },
    { id: 'nc', channel: 'Перемотка - Topic', title: 'Встречная (Nightcore Remix)', duration: 242 },
    { id: 'other', channel: 'Release - Topic', title: 'Встречная', duration: 103 },
    { id: 'art', channel: 'Перемотка - Topic', title: 'Встречная', duration: 242 },
  ];
  assert.strictEqual(pickMatch(song, results)?.id, 'art');
  assert.strictEqual(pickMatch(song, results.slice(0, 4)), null);
});

test("takes a verified label channel's exact upload, never an unverified one", () => {
  const song = { artist: 'BONES', title: 'HDMI', duration: 139 };
  const fan = { id: 'fan', channel: 'FusionVibes', title: 'Bones - HDMI', duration: 140 };
  const label = { ...fan, id: 'label', channel: 'TeamSESH', channel_is_verified: true };
  const lyrics = { ...label, id: 'lyrics', title: 'BONES - HDMI Lyrics!' };
  assert.strictEqual(pickMatch(song, [fan, lyrics]), null);
  assert.strictEqual(pickMatch(song, [fan, lyrics, label])?.id, 'label');
});

test('one name split off a credit counts only on a verified or Topic channel', () => {
  const song = { artist: 'Tyler, The Creator', title: 'See You Again', duration: 180 };
  const stranger = { id: 'tyler', channel: 'Tyler', title: 'See You Again', duration: 180 };
  assert.strictEqual(pickMatch(song, [stranger]), null);
  const own = { ...stranger, id: 'own', channel: 'Tyler, The Creator' };
  assert.strictEqual(pickMatch(song, [stranger, own])?.id, 'own');
  const duet = { artist: 'Drake, Future', title: 'Jumpman', duration: 205 };
  const drake = { id: 'drake', channel: 'Drake', title: 'Jumpman', duration: 205 };
  assert.strictEqual(pickMatch(duet, [drake]), null);
  assert.strictEqual(pickMatch(duet, [{ ...drake, channel_is_verified: true }])?.id, 'drake');
});

const saavn = (title, artists, duration, url, hq = 'true') => ({
  title,
  perma_url: url,
  more_info: {
    duration: String(duration),
    '320kbps': hq,
    artistMap: { primary_artists: artists.map(name => ({ name })) },
  },
});

test('jiosaavn: the 320k original by the same artist, never a remix or a cover', () => {
  const song = { artist: 'Tom Petty', title: 'Love Is a Long Road', duration: 247 };
  // Real listings on 2026-11-10: the 1989 Geffen file appears under compilations too.
  const remix = saavn('Love Is A Long Road (Stutter Techno Sped Up)', ['Stutter'], 74, 'remix');
  const cover = saavn('Love Is A Long Road', ['Some Band'], 246, 'cover');
  const nightcore = saavn('Love Is A Long Road (Nightcore)', ['Tom Petty'], 247, 'nc');
  const low = saavn('Love Is A Long Road', ['Tom Petty'], 246, 'low', 'false');
  const original = saavn('Love Is A Long Road', ['Tom Petty'], 246, 'KR0bSD5JU3s');
  assert.strictEqual(pickSaavn(song, [remix, cover, nightcore, low]), null);
  assert.strictEqual(pickSaavn(song, [remix, cover, nightcore, low, original]), 'KR0bSD5JU3s');
});

test('jiosaavn: a re-recording by the same band is not the original', () => {
  const song = { artist: 'Starship', title: 'We Built This City', duration: 296 };
  const later = saavn('We Built This City', ['Starship'], 361, 'later');
  const rerecord = saavn('We Built This City (Re-Record)', ['Starship'], 295, 'rerecord');
  const original = saavn('We Built This City', ['Starship'], 296, 'original');
  assert.strictEqual(pickSaavn(song, [later, rerecord]), null);
  assert.strictEqual(pickSaavn(song, [later, rerecord, original]), 'original');
});

test("jiosaavn: spotify's ' - 2004 Remaster' is the same title as '(2004 Remaster)'", () => {
  const song = { artist: 'Fleetwood Mac', title: 'Dreams - 2004 Remaster', duration: 257.8 };
  const hit = saavn('Dreams (2004 Remaster) (2004 Remaster)', ['Fleetwood Mac'], 257, 'x');
  assert.strictEqual(pickSaavn(song, [hit]), 'x');
});

test('jiosaavn: accents in the artist name do not decide a match', () => {
  const song = { artist: 'ROSALÍA', title: 'DESPECHÁ', duration: 157 };
  assert.strictEqual(pickSaavn(song, [saavn('DESPECHÁ', ['Rosalia'], 157, 'x')]), 'x');
});

test('jiosaavn: any credited artist can be the primary one, the whole credit still counts', () => {
  const miles = {
    artist: 'Miles Davis, John Coltrane, Cannonball Adderley, Bill Evans',
    title: 'So What (feat. John Coltrane, Cannonball Adderley & Bill Evans)',
    duration: 548,
  };
  assert.strictEqual(pickSaavn(miles, [saavn('So What', ['Miles Davis'], 548, 'x')]), 'x');
  const ewf = { artist: 'Earth, Wind & Fire', title: 'September', duration: 215 };
  assert.strictEqual(
    pickSaavn(ewf, [saavn('September', ['Earth,Wind &amp; Fire'], 215, 'y')]),
    'y'
  );
});

test("jiosaavn: classical 'Composer: Work' titles match the work", () => {
  const song = { artist: 'Ludovico Einaudi', title: 'Nuvole Bianche', duration: 358 };
  const hit = saavn('Einaudi: Nuvole Bianche', ['Ludovico Einaudi'], 357, 'x');
  const other = saavn('Voltaire: Nuvole Bianche', ['Voltaire'], 358, 'no');
  assert.strictEqual(pickSaavn(song, [other, hit]), 'x');
});

test("youtube: a featured credit still finds the lead artist's own upload", () => {
  const track = {
    artist: 'ODESZA featuring Zyra',
    title: 'Say My Name (feat. Zyra)',
    duration: 263,
  };
  const entry = {
    id: 'v',
    channel: 'ODESZA',
    title: 'ODESZA - Say My Name (feat. Zyra)',
    duration: 263,
  };
  assert.strictEqual(pickMatch(track, [entry])?.id, 'v');
});

test('jiosaavn: html entities in titles and any primary artist still match', () => {
  const song = { artist: 'Arijit Singh', title: 'Tum Hi Ho (From "Aashiqui 2")', duration: 261.5 };
  const hit = saavn(
    'Tum Hi Ho (From &quot;Aashiqui 2&quot;)',
    ['Mithoon', 'Arijit Singh'],
    261,
    'x'
  );
  assert.strictEqual(pickSaavn(song, [hit]), 'x');
  const apostrophe = { artist: 'BONES', title: "Don't Stop", duration: 139 };
  assert.strictEqual(pickSaavn(apostrophe, [saavn('Don&#039;t Stop', ['BONES'], 140, 'y')]), 'y');
});

test('soundcloud hosts only', () => {
  assert.ok(isSoundCloudUrl('https://soundcloud.com/liluzivert/xo-tour-llif3-1'));
  assert.ok(isSoundCloudUrl('https://on.soundcloud.com/abc'));
  assert.ok(!isSoundCloudUrl('https://soundcloud.com.evil.com/x'));
});
