import { test } from 'bun:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { extractAudio } from '../../src/core/acquire-media.js';
import { fromPath, tempPath, withJobDir } from '../../src/utils/media-file.js';

const tone = async ext => {
  const out = await tempPath(ext);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', out]);
  return fromPath(out, { filename: `Artist - Song${ext}`, audioReady: true });
};

test('the mp3 option turns a matched m4a into an mp3 and passes a tagged mp3 through', async () => {
  await withJobDir(async () => {
    const m4a = await tone('.m4a');
    assert.match((await extractAudio(m4a)).file.filename, /\.mp3$/);
    const mp3 = await tone('.mp3');
    assert.strictEqual((await extractAudio(mp3)).file, mp3);
  });
});
