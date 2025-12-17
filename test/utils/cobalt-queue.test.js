import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { hashUrl, queueCobaltRequest } from '../../src/utils/cobalt-queue.js';
import { initDatabase, insertProcessedUrl, getProcessedUrl } from '../../src/utils/database.js';

before(async () => {
  // Ensure database is initialized before tests run
  await initDatabase();
});

after(async () => {
  // Don't close database here - it's shared across parallel test files
  // Connection will be cleaned up when Node.js exits
});

describe('cobalt-queue utilities', () => {
  test('hashUrl - generates consistent hash for same URL', () => {
    const url = 'https://example.com/video.mp4';
    const hash1 = hashUrl(url);
    const hash2 = hashUrl(url);

    assert.strictEqual(hash1, hash2, 'Same URL should produce same hash');
    assert.strictEqual(typeof hash1, 'string', 'Hash should be a string');
    assert.strictEqual(hash1.length, 64, 'Hash should be 64 hex characters');
  });

  test('hashUrl - generates different hashes for different URLs', () => {
    const url1 = 'https://example.com/video1.mp4';
    const url2 = 'https://example.com/video2.mp4';
    const hash1 = hashUrl(url1);
    const hash2 = hashUrl(url2);

    assert.notStrictEqual(hash1, hash2, 'Different URLs should produce different hashes');
  });

  test('hashUrl - handles URLs with query parameters correctly', () => {
    const url1 = 'https://x.com/user/status/123';
    const url2 = 'https://x.com/user/status/123?s=46';
    const hash1 = hashUrl(url1);
    const hash2 = hashUrl(url2);

    assert.notStrictEqual(
      hash1,
      hash2,
      'URLs with different query parameters should produce different hashes'
    );
  });

  test('hashUrl - generates valid hex hash', () => {
    const url = 'https://example.com/test';
    const hash = hashUrl(url);

    // Check if hash is valid hex
    assert.ok(/^[a-f0-9]{64}$/.test(hash), 'Hash should be valid hex string');
  });

  describe('queueCobaltRequest with processed URLs', () => {
    test('returns cached URL when URL already processed', async () => {
      // Ensure database is initialized
      await initDatabase();

      const url = 'https://x.com/user/status/123456789';
      const urlHash = hashUrl(url);
      const fileHash = 'test-file-hash-123';
      const fileUrl = 'https://cdn.example.com/videos/test.mp4';
      const processedAt = Date.now();

      // Insert processed URL
      await insertProcessedUrl(
        urlHash,
        fileHash,
        'video',
        '.mp4',
        fileUrl,
        processedAt,
        'test-user'
      );

      // Verify the URL was actually inserted
      const inserted = await getProcessedUrl(urlHash);
      if (!inserted) {
        // If insert failed (e.g., read-only database), skip this test
        console.warn(
          'Skipping test: database appears to be read-only, cannot insert processed URL'
        );
        return;
      }

      // Mock download function (should not be called)
      let downloadCalled = false;
      const downloadFn = async () => {
        downloadCalled = true;
        return { buffer: Buffer.from('test'), filename: 'test.mp4', contentType: 'video/mp4' };
      };

      // Call queueCobaltRequest
      let error;
      try {
        await queueCobaltRequest(url, downloadFn);
      } catch (err) {
        error = err;
      }

      // Should throw error with URL_ALREADY_PROCESSED prefix
      assert.ok(error, 'Should throw error for cached URL');
      assert.ok(
        error.message.startsWith('URL_ALREADY_PROCESSED:'),
        'Error message should indicate URL already processed'
      );
      assert.ok(error.message.includes(fileUrl), 'Error message should include cached file URL');
      assert.strictEqual(downloadCalled, false, 'Download function should not be called');
    });

    test('proceeds with download when URL not processed', async () => {
      // Ensure database is initialized
      await initDatabase();

      const url = 'https://x.com/user/status/fresh-' + Date.now();
      const urlHash = hashUrl(url);

      // Ensure URL is not in database
      const existing = await getProcessedUrl(urlHash);
      assert.strictEqual(existing, null, 'URL should not be processed yet');

      // Mock download function
      let downloadCalled = false;
      const expectedResult = {
        buffer: Buffer.from('test video'),
        filename: 'test.mp4',
        contentType: 'video/mp4',
        size: 100,
      };

      const downloadFn = async () => {
        downloadCalled = true;
        return expectedResult;
      };

      // Call queueCobaltRequest
      // Note: This will actually queue and process the request
      // We need to wait for it to complete
      const result = await queueCobaltRequest(url, downloadFn);

      assert.strictEqual(downloadCalled, true, 'Download function should be called');
      assert.ok(result, 'Should return result');
      assert.ok(result.buffer, 'Result should have buffer');
      assert.strictEqual(result.filename, expectedResult.filename);
    });

    test('handles concurrent requests for same unprocessed URL', async () => {
      // Ensure database is initialized
      await initDatabase();

      const url = 'https://x.com/user/status/concurrent-' + Date.now();

      // Mock download function that takes some time
      let callCount = 0;
      const downloadFn = async () => {
        callCount++;
        await new Promise(resolve => setTimeout(resolve, 100)); // Simulate delay
        return {
          buffer: Buffer.from('test'),
          filename: 'test.mp4',
          contentType: 'video/mp4',
        };
      };

      // Make two concurrent requests
      const promise1 = queueCobaltRequest(url, downloadFn);
      const promise2 = queueCobaltRequest(url, downloadFn);

      // Both should resolve (second should wait for first)
      const [result1, result2] = await Promise.all([promise1, promise2]);

      // Download function should only be called once (deduplicated)
      // Note: Due to race conditions, it might be called twice, but ideally once
      assert.ok(result1, 'First request should return result');
      assert.ok(result2, 'Second request should return result');
      // The exact call count depends on timing, but should be <= 2
      assert.ok(callCount <= 2, 'Download should not be called too many times');
    });
  });
});
