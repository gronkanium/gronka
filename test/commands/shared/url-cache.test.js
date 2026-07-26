import { test, describe } from 'bun:test';
import assert from 'node:assert';
import {
  recordProcessedUrl,
  trackR2UploadIfApplicable,
} from '../../../src/commands/shared/url-cache.js';
import { getProcessedUrl } from '../../../src/utils/database.js';

describe('shared/url-cache', () => {
  describe('trackR2UploadIfApplicable', () => {
    test('is a no-op for null/non-https URLs (does not throw)', async () => {
      await assert.doesNotReject(() => trackR2UploadIfApplicable('hash', null, false));
      await assert.doesNotReject(() => trackR2UploadIfApplicable('hash', '', false));
      await assert.doesNotReject(() =>
        trackR2UploadIfApplicable('hash', 'http://example.com/x.gif', false)
      );
    });
  });

  describe('recordProcessedUrl', () => {
    test('round-trips a record retrievable via getProcessedUrl', async () => {
      const urlHash = `urlcache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await recordProcessedUrl({
        urlHash,
        contentHash: 'abc123',
        fileType: 'gif',
        fileExtension: '.gif',
        fileUrl: 'https://cdn.example.com/gifs/abc123.gif',
        userId: 'user-test',
        fileSize: 4242,
      });

      const row = await getProcessedUrl(urlHash);
      assert.ok(row, 'record should exist');
      assert.strictEqual(row.file_type, 'gif');
      assert.strictEqual(row.file_url, 'https://cdn.example.com/gifs/abc123.gif');
    });
  });
});
