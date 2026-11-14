import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, test } from 'bun:test';
import { collectionOf, downloadCollection } from '../../src/utils/collections.js';
import { ValidationError } from '../../src/utils/errors.js';
import { mediaFromBytes } from '../helpers/media.js';

const execFileAsync = promisify(execFile);

const listOf = (kind, entries, { total = null, title = 'Mix' } = {}) => ({
  kind,
  list: async () => ({ title, total, entries: entries.map(url => ({ url })) }),
});

const fetchEach =
  (fails = []) =>
  async entry => {
    if (fails.includes(entry)) throw new ValidationError(`no ${entry}`);
    return { fileData: await mediaFromBytes(Buffer.from(entry), { filename: `${entry}.m4a` }) };
  };

describe('collections', () => {
  test('only a list page is a list, never one item in it or a profile', () => {
    const kind = url => collectionOf(url)?.kind ?? null;
    assert.equal(kind('https://www.youtube.com/playlist?list=PL123'), 'video');
    assert.equal(kind('https://www.youtube.com/watch?v=abc&list=PL123'), null);
    assert.equal(kind('https://www.youtube.com/@someone'), null);
    assert.equal(kind('https://soundcloud.com/forss/sets/soulhack'), 'audio');
    assert.equal(kind('https://soundcloud.com/forss/city-ports'), null);
    assert.equal(kind('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy'), 'audio');
    assert.equal(kind('https://open.spotify.com/intl-de/playlist/37i9dQZF1DXcBWIGoYBM5M'), 'audio');
    assert.equal(kind('https://open.spotify.com/track/6OmhkSOpvYBokMKQxpIGx2'), null);
    assert.equal(kind('https://music.apple.com/us/album/in-between-dreams/1440857781'), 'audio');
    assert.equal(kind('https://music.apple.com/us/album/x/1440857781?i=1440857786'), null);
  });

  test('an album is one zip in track order, and a failed track is named', async () => {
    const zip = await downloadCollection(
      'https://open.spotify.com/album/x',
      listOf('audio', ['one', 'two', 'three']),
      fetchEach(['two'])
    );
    const { stdout } = await execFileAsync('unzip', ['-Z1', zip.path]);
    assert.equal(stdout, '01_one.m4a\n03_three.m4a\n');
    assert.equal(zip.filename, 'Mix.zip');
    assert.equal(zip.note, "1 couldn't be downloaded.");
  });

  test('a long video playlist sends the first ten and says how many there were', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => `v${i}`);
    const files = await downloadCollection(
      'https://www.youtube.com/playlist?list=PL1',
      listOf('video', entries, { total: 37 }),
      fetchEach()
    );
    assert.equal(files.length, 10);
    assert.equal(files.note, 'the first 10 of 37 videos.');
  });

  test("a track count above what the listing returned isn't a cut list", async () => {
    const zip = await downloadCollection(
      'https://music.apple.com/us/album/x/1',
      listOf('audio', ['one', 'two'], { total: 3 }),
      fetchEach()
    );
    assert.equal(zip.note, undefined);
  });

  test('a list where every item fails reports the first reason', async () => {
    await assert.rejects(
      downloadCollection('https://x', listOf('audio', ['a', 'b']), fetchEach(['a', 'b'])),
      { message: 'no a' }
    );
  });
});
