import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import {
  validateUrl,
  sanitizeFilename,
  validateFileExtension,
  validateFilename,
  parseTimestamp,
} from '../../src/utils/validation.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testStoragePath = path.join(__dirname, '../../temp/test-storage');

// Setup test storage directory
before(() => {
  try {
    mkdirSync(testStoragePath, { recursive: true });
  } catch {
    // Directory might already exist
  }
});

after(() => {
  try {
    rmSync(testStoragePath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('validation utilities', () => {
  describe('validateUrl', () => {
    test('valid https URLs', () => {
      assert.deepStrictEqual(validateUrl('https://example.com'), { valid: true });
      assert.deepStrictEqual(validateUrl('https://example.com/path'), { valid: true });
      assert.deepStrictEqual(validateUrl('https://example.com:443/path?query=1'), { valid: true });
    });

    test('valid http URLs', () => {
      assert.deepStrictEqual(validateUrl('http://example.com'), { valid: true });
      assert.deepStrictEqual(validateUrl('http://example.com/path'), { valid: true });
    });

    test('rejects non-http protocols', () => {
      assert.strictEqual(validateUrl('ftp://example.com').valid, false);
      assert.strictEqual(validateUrl('file:///etc/passwd').valid, false);
      assert.strictEqual(validateUrl('javascript:alert(1)').valid, false);
      assert.strictEqual(validateUrl('data:text/html,<script>').valid, false);
    });

    test('rejects localhost', () => {
      const result = validateUrl('http://localhost');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'localhost and loopback addresses are not allowed');
    });

    test('rejects 127.0.0.1', () => {
      const result = validateUrl('http://127.0.0.1');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'localhost and loopback addresses are not allowed');
    });

    test('rejects private IP ranges', () => {
      assert.strictEqual(validateUrl('http://10.0.0.1').valid, false);
      assert.strictEqual(validateUrl('http://172.16.0.1').valid, false);
      assert.strictEqual(validateUrl('http://192.168.1.1').valid, false);
      assert.strictEqual(validateUrl('http://169.254.1.1').valid, false);
    });

    test('rejects invalid URL format', () => {
      const result = validateUrl('not a url');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'invalid URL format');
    });

    test('handles IPv6 addresses', () => {
      // Valid public IPv6 (using Google's public IPv6)
      assert.deepStrictEqual(validateUrl('https://[2001:4860:4860::8888]'), { valid: true });
      assert.deepStrictEqual(validateUrl('https://[2607:f8b0:4005:805::200e]'), { valid: true });

      // Note: IPv6 addresses in brackets are currently accepted even for private ranges
      // because the hostname includes brackets, so startsWith checks don't match
      // This tests the current behavior - public IPv6 addresses work correctly
      const publicIpv6 = validateUrl('https://[2001:4860:4860::8888]/path');
      assert.strictEqual(publicIpv6.valid, true);

      // Test that IPv6 addresses without brackets are rejected as invalid URL format
      const invalidIpv6 = validateUrl('https://2001:4860:4860::8888');
      assert.strictEqual(invalidIpv6.valid, false);
      assert.strictEqual(invalidIpv6.error, 'invalid URL format');
    });

    test('handles URLs with port numbers', () => {
      // Valid URLs with ports
      assert.deepStrictEqual(validateUrl('https://example.com:443'), { valid: true });
      assert.deepStrictEqual(validateUrl('http://example.com:80'), { valid: true });
      assert.deepStrictEqual(validateUrl('https://example.com:8080/path'), { valid: true });
      assert.deepStrictEqual(validateUrl('http://example.com:3000'), { valid: true });

      // Rejects localhost with port
      const result = validateUrl('http://localhost:3000');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'localhost and loopback addresses are not allowed');

      // Rejects private IP with port
      const result2 = validateUrl('http://192.168.1.1:8080');
      assert.strictEqual(result2.valid, false);
      assert.strictEqual(result2.error, 'private and internal IP addresses are not allowed');
    });
  });

  describe('sanitizeFilename', () => {
    test('removes path separators', () => {
      assert.strictEqual(sanitizeFilename('../../etc/passwd'), 'etcpasswd');
      assert.strictEqual(sanitizeFilename('path/to/file.txt'), 'pathtofile.txt');
      assert.strictEqual(sanitizeFilename('file\\name.txt'), 'filename.txt');
    });

    test('removes dangerous characters', () => {
      assert.strictEqual(sanitizeFilename('file\x00name.txt'), 'filename.txt');
      assert.strictEqual(sanitizeFilename('file\nname.txt'), 'filename.txt');
    });

    test('removes leading dots and spaces', () => {
      assert.strictEqual(sanitizeFilename('...file.txt'), 'file.txt');
      assert.strictEqual(sanitizeFilename('   file.txt'), 'file.txt');
      assert.strictEqual(sanitizeFilename('.hidden.txt'), 'hidden.txt');
    });

    test('limits length', () => {
      const longName = 'a'.repeat(300) + '.txt';
      const result = sanitizeFilename(longName);
      assert.strictEqual(result.length, 255);
      assert(result.endsWith('.txt'));
    });

    test('handles invalid input', () => {
      assert.strictEqual(sanitizeFilename(null), 'file');
      assert.strictEqual(sanitizeFilename(undefined), 'file');
      assert.strictEqual(sanitizeFilename(''), 'file');
      assert.strictEqual(sanitizeFilename('.'), 'file');
      assert.strictEqual(sanitizeFilename('..'), 'file');
    });

    test('preserves valid filenames', () => {
      assert.strictEqual(sanitizeFilename('image.png'), 'image.png');
      assert.strictEqual(sanitizeFilename('my-file_123.jpg'), 'my-file_123.jpg');
    });
  });

  describe('validateFileExtension', () => {
    test('accepts valid extensions', () => {
      assert.strictEqual(validateFileExtension('image.png', ['.png', '.jpg']), true);
      assert.strictEqual(validateFileExtension('image.jpg', ['.png', '.jpg']), true);
      assert.strictEqual(validateFileExtension('video.mp4', ['mp4', 'mov']), true);
      assert.strictEqual(validateFileExtension('file.MP4', ['mp4']), true); // case insensitive
    });

    test('rejects invalid extensions', () => {
      assert.strictEqual(validateFileExtension('image.png', ['.jpg', '.gif']), false);
      assert.strictEqual(validateFileExtension('file.txt', ['.png', '.jpg']), false);
      assert.strictEqual(validateFileExtension('file', ['.png']), false);
    });

    test('handles missing filename', () => {
      assert.strictEqual(validateFileExtension(null, ['.png']), false);
      assert.strictEqual(validateFileExtension('', ['.png']), false);
    });
  });

  describe('validateFilename', () => {
    test('accepts valid filenames', () => {
      const result = validateFilename('image.png', testStoragePath);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.filename, 'image.png');
      assert(result.filePath.includes('image.png'));
    });

    test('sanitizes path traversal attempts', () => {
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

    test('sanitizes dangerous characters', () => {
      const result = validateFilename('file\x00name.txt', testStoragePath);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.filename, 'filename.txt');
    });

    test('limits length', () => {
      const longName = 'a'.repeat(300) + '.txt';
      const result = validateFilename(longName, testStoragePath);
      assert.strictEqual(result.valid, true);
      assert(result.filename.length <= 255);
    });

    test('rejects invalid input', () => {
      assert.strictEqual(validateFilename(null, testStoragePath).valid, false);
      assert.strictEqual(validateFilename(undefined, testStoragePath).valid, false);
      assert.strictEqual(validateFilename('', testStoragePath).valid, false);
      assert.strictEqual(validateFilename('.', testStoragePath).valid, false);
      assert.strictEqual(validateFilename('..', testStoragePath).valid, false);
    });

    test('ensures path stays within storage directory', () => {
      const result = validateFilename('image.png', testStoragePath);
      assert.strictEqual(result.valid, true);
      assert(result.filePath.startsWith(path.resolve(testStoragePath)));
    });
  });

  describe('parseTimestamp', () => {
    test('parses plain seconds', () => {
      assert.deepStrictEqual(parseTimestamp('90'), { valid: true, seconds: 90 });
      assert.deepStrictEqual(parseTimestamp('0'), { valid: true, seconds: 0 });
      assert.deepStrictEqual(parseTimestamp('12.5'), { valid: true, seconds: 12.5 });
    });

    test('parses MM:SS timestamps', () => {
      assert.deepStrictEqual(parseTimestamp('3:10'), { valid: true, seconds: 190 });
      assert.deepStrictEqual(parseTimestamp('0:05'), { valid: true, seconds: 5 });
      assert.deepStrictEqual(parseTimestamp('10:00'), { valid: true, seconds: 600 });
      assert.deepStrictEqual(parseTimestamp('1:30.5'), { valid: true, seconds: 90.5 });
    });

    test('parses HH:MM:SS timestamps', () => {
      assert.deepStrictEqual(parseTimestamp('1:02:30'), { valid: true, seconds: 3750 });
      assert.deepStrictEqual(parseTimestamp('0:00:01'), { valid: true, seconds: 1 });
      assert.deepStrictEqual(parseTimestamp('2:00:00'), { valid: true, seconds: 7200 });
    });

    test('allows minutes over 59 when no hours segment is present', () => {
      assert.deepStrictEqual(parseTimestamp('90:00'), { valid: true, seconds: 5400 });
    });

    test('trims surrounding whitespace', () => {
      assert.deepStrictEqual(parseTimestamp(' 3:10 '), { valid: true, seconds: 190 });
    });

    test('rejects seconds/minutes segments of 60 or more', () => {
      assert.strictEqual(parseTimestamp('1:60').valid, false);
      assert.strictEqual(parseTimestamp('1:99').valid, false);
      assert.strictEqual(parseTimestamp('1:60:00').valid, false);
    });

    test('rejects malformed input', () => {
      assert.strictEqual(parseTimestamp('abc').valid, false);
      assert.strictEqual(parseTimestamp('1:2:3:4').valid, false);
      assert.strictEqual(parseTimestamp('-5').valid, false);
      assert.strictEqual(parseTimestamp('1:-5').valid, false);
      assert.strictEqual(parseTimestamp('3:').valid, false);
      assert.strictEqual(parseTimestamp(':10').valid, false);
      assert.strictEqual(parseTimestamp('1.5:30').valid, false);
      assert.strictEqual(parseTimestamp('3:100').valid, false);
      assert.strictEqual(parseTimestamp('1h30m').valid, false);
    });

    test('rejects empty and non-string input', () => {
      assert.strictEqual(parseTimestamp('').valid, false);
      assert.strictEqual(parseTimestamp('   ').valid, false);
      assert.strictEqual(parseTimestamp(null).valid, false);
      assert.strictEqual(parseTimestamp(undefined).valid, false);
      assert.strictEqual(parseTimestamp(90).valid, false);
    });

    test('includes the bad value in the error message', () => {
      const result = parseTimestamp('abc');
      assert.strictEqual(result.valid, false);
      assert(result.error.includes('abc'));
    });
  });
});
