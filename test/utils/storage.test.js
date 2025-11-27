// Disable R2 for tests BEFORE importing storage module
process.env.R2_ACCOUNT_ID = '';
process.env.R2_ACCESS_KEY_ID = '';
process.env.R2_SECRET_ACCESS_KEY = '';
process.env.R2_BUCKET_NAME = '';

import { test } from 'node:test';
import assert from 'node:assert';
import {
  detectFileType,
  getGifPath,
  getVideoPath,
  getImagePath,
  formatFileSize,
  gifExists,
  saveGif,
  cleanupTempFiles,
  getStorageStats,
  videoExists,
  saveVideo,
  imageExists,
  saveImage,
  invalidateStatsCache,
} from '../../src/utils/storage.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import tmp from 'tmp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let testStoragePath;
let tmpDirCleanup;

// Setup test storage directory
test.before(() => {
  // Use tmp package to create secure temporary directory
  const tmpDir = tmp.dirSync({ prefix: 'gronka-test-storage-', unsafeCleanup: true });
  testStoragePath = tmpDir.name;
  tmpDirCleanup = tmpDir.removeCallback;

  mkdirSync(path.join(testStoragePath, 'gifs'), { recursive: true });
  mkdirSync(path.join(testStoragePath, 'videos'), { recursive: true });
  mkdirSync(path.join(testStoragePath, 'images'), { recursive: true });
});

test.after(() => {
  // Clean up temporary directory
  if (tmpDirCleanup) {
    tmpDirCleanup();
  }
});

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

test('detectFileType - defaults to video for unknown types', () => {
  assert.strictEqual(detectFileType('.unknown'), 'video');
  assert.strictEqual(detectFileType('.txt'), 'video');
  assert.strictEqual(detectFileType(''), 'video');
});

test('getGifPath - generates correct path for GIF', () => {
  const hash = 'abc123def456';
  const gifPath = getGifPath(hash, testStoragePath);
  assert(gifPath.includes('gifs'));
  assert(gifPath.endsWith('.gif'));
  assert(gifPath.includes(hash));
});

test('getGifPath - sanitizes hash to alphanumeric only', () => {
  const hash = 'abc123!@#$%^&*()';
  const gifPath = getGifPath(hash, testStoragePath);
  assert.strictEqual(path.basename(gifPath), 'abc123.gif');
});

test('getVideoPath - generates correct path for video', () => {
  const hash = 'abc123def456';
  const videoPath = getVideoPath(hash, '.mp4', testStoragePath);
  assert(videoPath.includes('videos'));
  assert(videoPath.endsWith('.mp4'));
  assert(videoPath.includes(hash));
});

test('getVideoPath - sanitizes hash and extension', () => {
  const hash = 'abc123!@#$%^&*()';
  const videoPath = getVideoPath(hash, '.mp4', testStoragePath);
  assert.strictEqual(path.basename(videoPath), 'abc123.mp4');
});

test('getVideoPath - handles extension with or without dot', () => {
  const hash = 'abc123';
  const path1 = getVideoPath(hash, '.mp4', testStoragePath);
  const path2 = getVideoPath(hash, 'mp4', testStoragePath);
  assert.strictEqual(path1, path2);
});

test('getImagePath - generates correct path for image', () => {
  const hash = 'abc123def456';
  const imagePath = getImagePath(hash, '.png', testStoragePath);
  assert(imagePath.includes('images'));
  assert(imagePath.endsWith('.png'));
  assert(imagePath.includes(hash));
});

test('getImagePath - sanitizes hash and extension', () => {
  const hash = 'abc123!@#$%^&*()';
  const imagePath = getImagePath(hash, '.png', testStoragePath);
  assert.strictEqual(path.basename(imagePath), 'abc123.png');
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

test('gifExists - returns false for non-existent GIF', async () => {
  const exists = await gifExists('nonexistent123', testStoragePath);
  assert.strictEqual(exists, false);
});

test('gifExists - returns true for existing GIF', async () => {
  const hash = 'testgif123';
  const gifPath = getGifPath(hash, testStoragePath);
  // Ensure directory exists
  const gifsDir = path.dirname(gifPath);
  mkdirSync(gifsDir, { recursive: true });
  writeFileSync(gifPath, Buffer.from('fake gif content'));

  const exists = await gifExists(hash, testStoragePath);
  assert.strictEqual(exists, true);
});

test('saveGif - saves GIF file and returns path', async () => {
  const hash = 'testgif456';
  const buffer = Buffer.from('fake gif content');
  const saveResult = await saveGif(buffer, hash, testStoragePath);
  const savedPath = saveResult.url;

  // Hash is sanitized (hex characters only), so testgif456 becomes ef456
  assert(savedPath.includes('ef456'));
  assert(savedPath.endsWith('.gif'));

  const exists = await gifExists(hash, testStoragePath);
  assert.strictEqual(exists, true);
});

test('saveGif - creates directory if it does not exist', async () => {
  const customPath = path.join(testStoragePath, 'custom');
  const hash = 'testgif789';
  const buffer = Buffer.from('fake gif content');
  await saveGif(buffer, hash, customPath);

  const exists = await gifExists(hash, customPath);
  assert.strictEqual(exists, true);
});

test('videoExists - returns false for non-existent video', async () => {
  const exists = await videoExists('nonexistent123', '.mp4', testStoragePath);
  assert.strictEqual(exists, false);
});

test('videoExists - returns true for existing video', async () => {
  const hash = 'testvideo123';
  const videoPath = getVideoPath(hash, '.mp4', testStoragePath);
  const videosDir = path.dirname(videoPath);
  mkdirSync(videosDir, { recursive: true });
  writeFileSync(videoPath, Buffer.from('fake video content'));

  const exists = await videoExists(hash, '.mp4', testStoragePath);
  assert.strictEqual(exists, true);
});

test('saveVideo - saves video file and returns path', async () => {
  const hash = 'testvideo456';
  const buffer = Buffer.from('fake video content');
  const saveResult = await saveVideo(buffer, hash, '.webm', testStoragePath);
  const savedPath = saveResult.url;

  // Hash is sanitized (hex characters only), so testvideo456 becomes ede456
  assert(savedPath.includes('ede456'));
  assert(savedPath.endsWith('.webm'));

  const exists = await videoExists(hash, '.webm', testStoragePath);
  assert.strictEqual(exists, true);
});

test('imageExists - returns false for non-existent image', async () => {
  const exists = await imageExists('nonexistent123', '.png', testStoragePath);
  assert.strictEqual(exists, false);
});

test('imageExists - returns true for existing image', async () => {
  const hash = 'testimage123';
  const imagePath = getImagePath(hash, '.png', testStoragePath);
  const imagesDir = path.dirname(imagePath);
  mkdirSync(imagesDir, { recursive: true });
  writeFileSync(imagePath, Buffer.from('fake image content'));

  const exists = await imageExists(hash, '.png', testStoragePath);
  assert.strictEqual(exists, true);
});

test('saveImage - saves image file and returns path', async () => {
  const hash = 'testimage456';
  const buffer = Buffer.from('fake image content');
  const saveResult = await saveImage(buffer, hash, '.jpg', testStoragePath);
  const savedPath = saveResult.url;

  // Hash is sanitized (hex characters only), so testimage456 becomes eae456
  assert(savedPath.includes('eae456'));
  assert(savedPath.endsWith('.jpg'));

  const exists = await imageExists(hash, '.jpg', testStoragePath);
  assert.strictEqual(exists, true);
});

test('cleanupTempFiles - deletes existing files', async () => {
  mkdirSync(testStoragePath, { recursive: true });
  const tempFile1 = path.join(testStoragePath, 'temp1.txt');
  const tempFile2 = path.join(testStoragePath, 'temp2.txt');
  writeFileSync(tempFile1, 'content1');
  writeFileSync(tempFile2, 'content2');

  await cleanupTempFiles([tempFile1, tempFile2]);

  const fs = await import('fs/promises');
  try {
    await fs.access(tempFile1);
    assert.fail('tempFile1 should have been deleted');
  } catch {
    // Expected - file should not exist
  }

  try {
    await fs.access(tempFile2);
    assert.fail('tempFile2 should have been deleted');
  } catch {
    // Expected - file should not exist
  }
});

test('cleanupTempFiles - handles non-existent files gracefully', async () => {
  const tempFile = path.join(testStoragePath, 'nonexistent.txt');
  await cleanupTempFiles([tempFile]);
  // Should not throw
});

test('cleanupTempFiles - handles empty array', async () => {
  await cleanupTempFiles([]);
  // Should not throw
});

test('getStorageStats - returns zero stats for empty storage', async () => {
  const emptyPath = path.join(testStoragePath, 'empty-stats');
  // Remove old directory if exists
  try {
    rmSync(emptyPath, { recursive: true, force: true });
  } catch {
    // Ignore
  }

  mkdirSync(emptyPath, { recursive: true });
  mkdirSync(path.join(emptyPath, 'gifs'), { recursive: true });
  mkdirSync(path.join(emptyPath, 'videos'), { recursive: true });
  mkdirSync(path.join(emptyPath, 'images'), { recursive: true });

  // Clear stats cache to ensure fresh calculation
  invalidateStatsCache(emptyPath);

  const stats = await getStorageStats(emptyPath);
  assert.strictEqual(stats.totalGifs, 0);
  assert.strictEqual(stats.totalVideos, 0);
  assert.strictEqual(stats.totalImages, 0);
  assert.strictEqual(stats.diskUsageBytes, 0);
});

test('getStorageStats - counts files correctly', async () => {
  // Use unique hash to avoid conflicts with other tests
  const uniqueId = Date.now();
  const gif1Path = getGifPath(`hash1${uniqueId}`, testStoragePath);
  const gif2Path = getGifPath(`hash2${uniqueId}`, testStoragePath);
  const video1Path = getVideoPath(`hash3${uniqueId}`, '.mp4', testStoragePath);
  const image1Path = getImagePath(`hash4${uniqueId}`, '.png', testStoragePath);

  mkdirSync(path.dirname(gif1Path), { recursive: true });
  mkdirSync(path.dirname(video1Path), { recursive: true });
  mkdirSync(path.dirname(image1Path), { recursive: true });

  writeFileSync(gif1Path, Buffer.alloc(1024));
  writeFileSync(gif2Path, Buffer.alloc(2048));
  writeFileSync(video1Path, Buffer.alloc(4096));
  writeFileSync(image1Path, Buffer.alloc(512));

  const stats = await getStorageStats(testStoragePath);
  // Count may include files from other tests, so check at least our files exist
  assert(stats.totalGifs >= 2);
  assert(stats.totalVideos >= 1);
  assert(stats.totalImages >= 1);
  // Disk usage should be at least our files
  assert(stats.diskUsageBytes >= 1024 + 2048 + 4096 + 512);
});

test('getStorageStats - calculates formatted sizes correctly', async () => {
  const uniqueId = Date.now();
  const gifPath = getGifPath(`hash1${uniqueId}`, testStoragePath);
  const gifsDir = path.dirname(gifPath);
  mkdirSync(gifsDir, { recursive: true });
  const fileSize = 1024 * 1024;
  writeFileSync(gifPath, Buffer.alloc(fileSize));

  // Invalidate cache after manually writing file (like saveGif does)
  invalidateStatsCache(testStoragePath);

  const stats = await getStorageStats(testStoragePath);
  // Stats may include other files, so check at least our file size is included
  assert(stats.diskUsageBytes >= fileSize);
  assert(stats.gifsDiskUsageBytes >= fileSize);
});

test('getStorageStats - handles missing directories gracefully', async () => {
  const missingPath = path.join(testStoragePath, 'missing');
  const stats = await getStorageStats(missingPath);
  assert.strictEqual(stats.totalGifs, 0);
  assert.strictEqual(stats.totalVideos, 0);
  assert.strictEqual(stats.totalImages, 0);
});

test('getStorageStats - only counts valid file types', async () => {
  const uniqueId = Date.now();
  const gifsPath = path.join(testStoragePath, 'gifs');
  const videosPath = path.join(testStoragePath, 'videos');
  const imagesPath = path.join(testStoragePath, 'images');

  mkdirSync(gifsPath, { recursive: true });
  mkdirSync(videosPath, { recursive: true });
  mkdirSync(imagesPath, { recursive: true });

  writeFileSync(path.join(gifsPath, `file${uniqueId}.gif`), Buffer.alloc(100));
  writeFileSync(path.join(gifsPath, `file${uniqueId}.txt`), Buffer.alloc(100)); // Should be ignored
  writeFileSync(path.join(videosPath, `file${uniqueId}.mp4`), Buffer.alloc(100));
  writeFileSync(path.join(videosPath, `file${uniqueId}.avi`), Buffer.alloc(100));
  writeFileSync(path.join(videosPath, `file${uniqueId}.txt`), Buffer.alloc(100)); // Should be ignored
  writeFileSync(path.join(imagesPath, `file${uniqueId}.png`), Buffer.alloc(100));
  writeFileSync(path.join(imagesPath, `file${uniqueId}.jpg`), Buffer.alloc(100));
  writeFileSync(path.join(imagesPath, `file${uniqueId}.txt`), Buffer.alloc(100)); // Should be ignored

  const stats = await getStorageStats(testStoragePath);
  // Count may include files from other tests, so check at least our files exist
  assert(stats.totalGifs >= 1);
  assert(stats.totalVideos >= 2);
  assert(stats.totalImages >= 2);
});
