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

test('a matched track goes out as it came, with its cover and tags, and only a trim re-encodes it', async () => {
  await withJobDir(async () => {
    const m4a = await tone('.m4a');
    const kept = await extractAudio(m4a);
    assert.strictEqual(kept.file, m4a);
    assert.strictEqual(kept.format, 'm4a');
    const mp3 = await tone('.mp3');
    assert.strictEqual((await extractAudio(mp3)).file, mp3);
    const cut = await extractAudio(m4a, { startTime: 0, duration: 0.5 });
    assert.match(cut.file.filename, /\.mp3$/);
    assert.strictEqual(cut.format, 'mp3');
  });
});
