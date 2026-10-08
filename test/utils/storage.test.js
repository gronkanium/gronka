// No R2: nothing is stored anywhere, so stats are empty.
process.env.R2_ACCOUNT_ID = '';
process.env.R2_ACCESS_KEY_ID = '';
process.env.R2_SECRET_ACCESS_KEY = '';
process.env.R2_BUCKET_NAME = '';

import { test } from 'bun:test';
import assert from 'node:assert';
import { detectFileType, formatFileSize, getStorageStats } from '../../src/utils/storage.js';

test('detectFileType - detects GIF from extension', () => {
  assert.strictEqual(detectFileType('.gif'), 'gif');
  assert.strictEqual(detectFileType('.GIF'), 'gif');
});

test('detectFileType - detects video from extension', () => {
  assert.strictEqual(detectFileType('.mp4'), 'video');
  assert.strictEqual(detectFileType('.webm'), 'video');
  assert.strictEqual(detectFileType('.mov'), 'video');
  assert.strictEqual(detectFileType('.avi'), 'video');
  assert.strictEqual(detectFileType('.mkv'), 'video');
});

test('detectFileType - detects image from extension', () => {
  assert.strictEqual(detectFileType('.png'), 'image');
  assert.strictEqual(detectFileType('.jpg'), 'image');
  assert.strictEqual(detectFileType('.jpeg'), 'image');
  assert.strictEqual(detectFileType('.webp'), 'image');
});

test('detectFileType - keeps audio files in the audio storage lane', () => {
  for (const ext of ['.ogg', '.mp3', '.m4a', '.wav', '.flac']) {
    assert.strictEqual(detectFileType(ext), 'audio');
  }
  assert.strictEqual(detectFileType('.unknown', 'audio/ogg'), 'audio');
  const m4a = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(8)]);
  assert.strictEqual(detectFileType('.m4a', 'audio/mp4', m4a), 'audio');
  assert.strictEqual(detectFileType('.m4a', 'application/octet-stream', m4a), 'audio');
  assert.strictEqual(detectFileType('.ogg', 'video/ogg'), 'video');
  assert.strictEqual(detectFileType('.mp3', 'image/png'), 'image');
});

test('detectFileType - uses content type when extension is ambiguous', () => {
  assert.strictEqual(detectFileType('.unknown', 'image/gif'), 'gif');
  assert.strictEqual(detectFileType('.unknown', 'video/mp4'), 'video');
  assert.strictEqual(detectFileType('.unknown', 'image/png'), 'image');
});

test('detectFileType - prioritizes content-type over extension', () => {
  // Content-type takes precedence over extension (more reliable)
  // This handles cases where files have incorrect extensions (e.g., .gif extension but video/mp4 content-type)
  assert.strictEqual(detectFileType('.gif', 'video/mp4'), 'video');
  assert.strictEqual(detectFileType('.mp4', 'image/gif'), 'gif');
  assert.strictEqual(detectFileType('.gif', 'image/gif'), 'gif');
  assert.strictEqual(detectFileType('.mp4', 'video/mp4'), 'video');
});

test('detectFileType - magic bytes outrank a lying content-type', () => {
  const gif89a = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(16)]);
  const gif87a = Buffer.concat([Buffer.from('GIF87a', 'latin1'), Buffer.alloc(16)]);
  // The regression: sources that serve real gifs as video/* sent them to the videos/ prefix.
  assert.strictEqual(detectFileType('.gif', 'video/mp4', gif89a), 'gif');
  assert.strictEqual(detectFileType('.mp4', 'video/mp4', gif87a), 'gif');

  // The case the content-type check was originally added for still has to work.
  const mp4 = Buffer.concat([
    Buffer.from([0, 0, 0, 0x20]),
    Buffer.from('ftypisom', 'latin1'),
    Buffer.alloc(16),
  ]);
  assert.strictEqual(detectFileType('.gif', 'image/gif', mp4), 'video');
});

test('detectFileType - falls back cleanly when the buffer proves nothing', () => {
  // Too short to hold a signature, and a signature that matches nothing known: both must
  // defer to the content-type/extension path rather than guessing.
  assert.strictEqual(detectFileType('.gif', 'image/gif', Buffer.from('GIF')), 'gif');
  assert.strictEqual(detectFileType('.png', 'image/png', Buffer.alloc(32)), 'image');
  assert.strictEqual(detectFileType('.gif', 'video/mp4', Buffer.alloc(32)), 'video');
  assert.strictEqual(detectFileType('.gif', '', null), 'gif');
});

test('detectFileType - defaults to video for unknown types', () => {
  assert.strictEqual(detectFileType('.unknown'), 'video');
  assert.strictEqual(detectFileType('.txt'), 'video');
  assert.strictEqual(detectFileType(''), 'video');
});

test('formatFileSize - formats bytes to MB', () => {
  assert.strictEqual(formatFileSize(1024 * 1024), '1.00 MB');
  assert.strictEqual(formatFileSize(5 * 1024 * 1024), '5.00 MB');
  assert.strictEqual(formatFileSize(1536 * 1024), '1.50 MB');
});

test('formatFileSize - formats large sizes to GB', () => {
  assert.strictEqual(formatFileSize(1024 * 1024 * 1024), '1.00 GB');
  assert.strictEqual(formatFileSize(2048 * 1024 * 1024), '2.00 GB');
  assert.strictEqual(formatFileSize(1536 * 1024 * 1024), '1.50 GB');
});

test('formatFileSize - handles zero bytes', () => {
  assert.strictEqual(formatFileSize(0), '0.00 MB');
});

test('getStorageStats - without R2 there is nothing stored to count', async () => {
  const stats = await getStorageStats();
  assert.strictEqual(stats.totalGifs + stats.totalVideos + stats.totalImages, 0);
  assert.strictEqual(stats.diskUsageBytes, 0);
});
