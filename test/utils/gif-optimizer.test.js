import { test } from 'node:test';
import assert from 'node:assert';
import {
  isGifFile,
  extractHashFromCdnUrl,
  calculateSizeReduction,
  formatSizeMb,
} from '../../src/utils/gif-optimizer.js';

test('isGifFile - detects GIF from extension', () => {
  assert.strictEqual(isGifFile('file.gif', ''), true);
  assert.strictEqual(isGifFile('file.GIF', ''), true);
  assert.strictEqual(isGifFile('path/to/file.gif', ''), true);
});

test('isGifFile - detects GIF from content type', () => {
  assert.strictEqual(isGifFile('file.txt', 'image/gif'), true);
  assert.strictEqual(isGifFile('file.unknown', 'image/gif'), true);
  assert.strictEqual(isGifFile('', 'image/gif'), true);
});

test('isGifFile - returns false for non-GIF files', () => {
  assert.strictEqual(isGifFile('file.png', ''), false);
  assert.strictEqual(isGifFile('file.jpg', ''), false);
  assert.strictEqual(isGifFile('file.mp4', ''), false);
  // Extension wins - if extension is .gif, it returns true even with wrong content type
  assert.strictEqual(isGifFile('file.gif', 'image/png'), true);
});

test('isGifFile - returns true if either extension or content type matches', () => {
  assert.strictEqual(isGifFile('file.gif', 'image/png'), true); // Extension wins
  assert.strictEqual(isGifFile('file.png', 'image/gif'), true); // Content type wins
});

test('extractHashFromCdnUrl - extracts hash from cdn.p1x.dev URL', () => {
  const url = 'https://cdn.p1x.dev/gifs/abc123def456.gif';
  const hash = extractHashFromCdnUrl(url);
  assert.strictEqual(hash, 'abc123def456');
});

test('extractHashFromCdnUrl - extracts hash from subdomain URL', () => {
  const url = 'https://subdomain.p1x.dev/gifs/def789abc123.gif';
  const hash = extractHashFromCdnUrl(url);
  assert.strictEqual(hash, 'def789abc123');
});

test('extractHashFromCdnUrl - handles URLs with query parameters', () => {
  const url = 'https://cdn.p1x.dev/gifs/abc123.gif?version=1&cache=true';
  const hash = extractHashFromCdnUrl(url);
  assert.strictEqual(hash, 'abc123');
});

test('extractHashFromCdnUrl - handles URLs with fragments', () => {
  const url = 'https://cdn.p1x.dev/gifs/abc123.gif#section';
  const hash = extractHashFromCdnUrl(url);
  assert.strictEqual(hash, 'abc123');
});

test('extractHashFromCdnUrl - returns null for non-p1x.dev domains', () => {
  assert.strictEqual(extractHashFromCdnUrl('https://example.com/gifs/abc123.gif'), null);
  assert.strictEqual(extractHashFromCdnUrl('https://cdn.example.com/gifs/abc123.gif'), null);
});

test('extractHashFromCdnUrl - returns null for invalid path pattern', () => {
  assert.strictEqual(extractHashFromCdnUrl('https://cdn.p1x.dev/images/abc123.gif'), null);
  assert.strictEqual(extractHashFromCdnUrl('https://cdn.p1x.dev/gifs/'), null);
  assert.strictEqual(extractHashFromCdnUrl('https://cdn.p1x.dev/gifs/abc123'), null);
  assert.strictEqual(extractHashFromCdnUrl('https://cdn.p1x.dev/gifs/abc123.png'), null);
});

test('extractHashFromCdnUrl - returns null for invalid URL format', () => {
  assert.strictEqual(extractHashFromCdnUrl('not a url'), null);
  assert.strictEqual(extractHashFromCdnUrl(''), null);
});

test('extractHashFromCdnUrl - handles case-insensitive hash', () => {
  const url = 'https://cdn.p1x.dev/gifs/ABC123DEF456.gif';
  const hash = extractHashFromCdnUrl(url);
  assert.strictEqual(hash, 'ABC123DEF456');
});

test('calculateSizeReduction - calculates correct reduction percentage', () => {
  assert.strictEqual(calculateSizeReduction(1000, 500), 50);
  assert.strictEqual(calculateSizeReduction(1000, 750), 25);
  assert.strictEqual(calculateSizeReduction(1000, 900), 10);
  assert.strictEqual(calculateSizeReduction(1000, 1000), 0);
});

test('calculateSizeReduction - returns negative for file growth', () => {
  assert.strictEqual(calculateSizeReduction(1000, 1100), -10);
  assert.strictEqual(calculateSizeReduction(1000, 1500), -50);
});

test('calculateSizeReduction - handles zero original size', () => {
  assert.strictEqual(calculateSizeReduction(0, 100), 0);
  assert.strictEqual(calculateSizeReduction(0, 0), 0);
});

test('calculateSizeReduction - rounds to nearest integer', () => {
  assert.strictEqual(calculateSizeReduction(1000, 666), 33); // 33.4% rounds to 33
  assert.strictEqual(calculateSizeReduction(1000, 667), 33); // 33.3% rounds to 33
  assert.strictEqual(calculateSizeReduction(1000, 665), 34); // 33.5% rounds to 34
});

test('formatSizeMb - formats bytes to MB', () => {
  assert.strictEqual(formatSizeMb(1024 * 1024), '1.0mb');
  assert.strictEqual(formatSizeMb(5 * 1024 * 1024), '5.0mb');
  assert.strictEqual(formatSizeMb(1536 * 1024), '1.5mb');
});

test('formatSizeMb - handles zero bytes', () => {
  assert.strictEqual(formatSizeMb(0), '0.0mb');
});

test('formatSizeMb - handles small sizes', () => {
  assert.strictEqual(formatSizeMb(512 * 1024), '0.5mb');
  assert.strictEqual(formatSizeMb(256 * 1024), '0.3mb'); // 0.25MB rounds to 0.3MB
});

test('formatSizeMb - handles large sizes', () => {
  assert.strictEqual(formatSizeMb(10 * 1024 * 1024), '10.0mb');
  assert.strictEqual(formatSizeMb(100 * 1024 * 1024), '100.0mb');
});

test('formatSizeMb - rounds to one decimal place', () => {
  assert.strictEqual(formatSizeMb(1536 * 1024), '1.5mb');
  assert.strictEqual(formatSizeMb(1537 * 1024), '1.5mb'); // Rounds down
  assert.strictEqual(formatSizeMb(1538 * 1024), '1.5mb'); // Rounds down
  assert.strictEqual(formatSizeMb(1543 * 1024), '1.5mb'); // Rounds up
});
