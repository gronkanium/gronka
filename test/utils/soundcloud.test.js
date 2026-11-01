import { test } from 'node:test';
import assert from 'node:assert';
import { pickMatch, isSoundCloudUrl } from '../../src/utils/soundcloud.js';

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

test('soundcloud hosts only', () => {
  assert.ok(isSoundCloudUrl('https://soundcloud.com/liluzivert/xo-tour-llif3-1'));
  assert.ok(isSoundCloudUrl('https://on.soundcloud.com/abc'));
  assert.ok(!isSoundCloudUrl('https://soundcloud.com.evil.com/x'));
});
