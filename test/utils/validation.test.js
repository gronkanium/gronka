import { test } from 'node:test';
import assert from 'node:assert';
import {
  validateUrl,
  sanitizeFilename,
  validateFileExtension,
  validateFilename,
} from '../../src/utils/validation.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testStoragePath = path.join(__dirname, '../../temp/test-storage');

// Setup test storage directory
test.before(() => {
  try {
    mkdirSync(testStoragePath, { recursive: true });
  } catch {
    // Directory might already exist
  }
});

test.after(() => {
  try {
    rmSync(testStoragePath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

test('validateUrl - valid https URLs', () => {
  assert.deepStrictEqual(validateUrl('https://example.com'), { valid: true });
  assert.deepStrictEqual(validateUrl('https://example.com/path'), { valid: true });
  assert.deepStrictEqual(validateUrl('https://example.com:443/path?query=1'), { valid: true });
});

test('validateUrl - valid http URLs', () => {
  assert.deepStrictEqual(validateUrl('http://example.com'), { valid: true });
  assert.deepStrictEqual(validateUrl('http://example.com/path'), { valid: true });
});

test('validateUrl - rejects non-http protocols', () => {
  assert.strictEqual(validateUrl('ftp://example.com').valid, false);
  assert.strictEqual(validateUrl('file:///etc/passwd').valid, false);
  assert.strictEqual(validateUrl('javascript:alert(1)').valid, false);
  assert.strictEqual(validateUrl('data:text/html,<script>').valid, false);
});

test('validateUrl - rejects localhost', () => {
  const result = validateUrl('http://localhost');
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'localhost and loopback addresses are not allowed');
});

test('validateUrl - rejects 127.0.0.1', () => {
  const result = validateUrl('http://127.0.0.1');
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'localhost and loopback addresses are not allowed');
});

test('validateUrl - rejects private IP ranges', () => {
  assert.strictEqual(validateUrl('http://10.0.0.1').valid, false);
  assert.strictEqual(validateUrl('http://172.16.0.1').valid, false);
  assert.strictEqual(validateUrl('http://192.168.1.1').valid, false);
  assert.strictEqual(validateUrl('http://169.254.1.1').valid, false);
});

test('validateUrl - rejects invalid URL format', () => {
  const result = validateUrl('not a url');
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'invalid URL format');
});

test('sanitizeFilename - removes path separators', () => {
  assert.strictEqual(sanitizeFilename('../../etc/passwd'), 'etcpasswd');
  assert.strictEqual(sanitizeFilename('path/to/file.txt'), 'pathtofile.txt');
  assert.strictEqual(sanitizeFilename('file\\name.txt'), 'filename.txt');
});

test('sanitizeFilename - removes dangerous characters', () => {
  assert.strictEqual(sanitizeFilename('file\x00name.txt'), 'filename.txt');
  assert.strictEqual(sanitizeFilename('file\nname.txt'), 'filename.txt');
});

test('sanitizeFilename - removes leading dots and spaces', () => {
  assert.strictEqual(sanitizeFilename('...file.txt'), 'file.txt');
  assert.strictEqual(sanitizeFilename('   file.txt'), 'file.txt');
  assert.strictEqual(sanitizeFilename('.hidden.txt'), 'hidden.txt');
});

test('sanitizeFilename - limits length', () => {
  const longName = 'a'.repeat(300) + '.txt';
  const result = sanitizeFilename(longName);
  assert.strictEqual(result.length, 255);
  assert(result.endsWith('.txt'));
});

test('sanitizeFilename - handles invalid input', () => {
  assert.strictEqual(sanitizeFilename(null), 'file');
  assert.strictEqual(sanitizeFilename(undefined), 'file');
  assert.strictEqual(sanitizeFilename(''), 'file');
  assert.strictEqual(sanitizeFilename('.'), 'file');
  assert.strictEqual(sanitizeFilename('..'), 'file');
});

test('sanitizeFilename - preserves valid filenames', () => {
  assert.strictEqual(sanitizeFilename('image.png'), 'image.png');
  assert.strictEqual(sanitizeFilename('my-file_123.jpg'), 'my-file_123.jpg');
});

test('validateFileExtension - accepts valid extensions', () => {
  assert.strictEqual(validateFileExtension('image.png', ['.png', '.jpg']), true);
  assert.strictEqual(validateFileExtension('image.jpg', ['.png', '.jpg']), true);
  assert.strictEqual(validateFileExtension('video.mp4', ['mp4', 'mov']), true);
  assert.strictEqual(validateFileExtension('file.MP4', ['mp4']), true); // case insensitive
});

test('validateFileExtension - rejects invalid extensions', () => {
  assert.strictEqual(validateFileExtension('image.png', ['.jpg', '.gif']), false);
  assert.strictEqual(validateFileExtension('file.txt', ['.png', '.jpg']), false);
  assert.strictEqual(validateFileExtension('file', ['.png']), false);
});

test('validateFileExtension - handles missing filename', () => {
  assert.strictEqual(validateFileExtension(null, ['.png']), false);
  assert.strictEqual(validateFileExtension('', ['.png']), false);
});

test('validateFilename - accepts valid filenames', () => {
  const result = validateFilename('image.png', testStoragePath);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.filename, 'image.png');
  assert(result.filePath.includes('image.png'));
});

test('validateFilename - sanitizes path traversal attempts', () => {
  // The function sanitizes path traversal by removing separators and leading dots
  // So these become valid filenames after sanitization
  const result1 = validateFilename('../../etc/passwd', testStoragePath);
  assert.strictEqual(result1.valid, true);
  assert.strictEqual(result1.filename, 'etcpasswd');
  
  const result2 = validateFilename('../file.txt', testStoragePath);
  assert.strictEqual(result2.valid, true);
  assert.strictEqual(result2.filename, 'file.txt');
  
  const result3 = validateFilename('./../file.txt', testStoragePath);
  assert.strictEqual(result3.valid, true);
  assert.strictEqual(result3.filename, 'file.txt');
  
  const result4 = validateFilename('..\\file.txt', testStoragePath);
  assert.strictEqual(result4.valid, true);
  assert.strictEqual(result4.filename, 'file.txt');
  
  // However, if .. remains after sanitization (no separators), it should be rejected
  const result5 = validateFilename('..', testStoragePath);
  assert.strictEqual(result5.valid, false);
});

test('validateFilename - sanitizes dangerous characters', () => {
  const result = validateFilename('file\x00name.txt', testStoragePath);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.filename, 'filename.txt');
});

test('validateFilename - limits length', () => {
  const longName = 'a'.repeat(300) + '.txt';
  const result = validateFilename(longName, testStoragePath);
  assert.strictEqual(result.valid, true);
  assert(result.filename.length <= 255);
});

test('validateFilename - rejects invalid input', () => {
  assert.strictEqual(validateFilename(null, testStoragePath).valid, false);
  assert.strictEqual(validateFilename(undefined, testStoragePath).valid, false);
  assert.strictEqual(validateFilename('', testStoragePath).valid, false);
  assert.strictEqual(validateFilename('.', testStoragePath).valid, false);
  assert.strictEqual(validateFilename('..', testStoragePath).valid, false);
});

test('validateFilename - ensures path stays within storage directory', () => {
  const result = validateFilename('image.png', testStoragePath);
  assert.strictEqual(result.valid, true);
  assert(result.filePath.startsWith(path.resolve(testStoragePath)));
});

