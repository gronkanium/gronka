import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { uploadBudgetMs, uploadToR2 } from '../../src/utils/r2-storage.js';
import { withJobDir, jobRemainingMs } from '../../src/utils/media-file.js';

describe('uploadBudgetMs', () => {
  test('gives small uploads the floor rather than a few milliseconds', () => {
    assert.strictEqual(uploadBudgetMs(0), 60_000);
    assert.strictEqual(uploadBudgetMs(3.5 * 1024 * 1024), 60_000);
  });

  test('scales with size once past the floor, well under the 15-minute token', () => {
    const budget = uploadBudgetMs(60 * 1024 * 1024);
    assert.ok(budget > 60_000, `expected above the floor, got ${budget}`);
    assert.ok(budget < 15 * 60_000, `expected under the token lifetime, got ${budget}`);
  });

  test('the observed 60MB stall would have been aborted', () => {
    // 60MB took 16m57s at ~60KB/s on the degraded route.
    assert.ok(uploadBudgetMs(60 * 1024 * 1024) < 17 * 60_000);
  });
});

describe('R2 upload against the job deadline', () => {
  const config = {
    accountId: 'a',
    accessKeyId: 'k',
    secretAccessKey: 's',
    bucketName: 'b',
    publicDomain: 'cdn.test',
  };

  test('refuses up front when the job has under a minute left', async () => {
    const started = Date.now();
    await withJobDir(
      async () => {
        assert.ok(jobRemainingMs() < 60_000);
        await assert.rejects(
          uploadToR2({ path: '/nonexistent', size: 1024 }, 'k', 'video/mp4', config),
          error => error.name === 'NetworkError' && /not enough time left/.test(error.message)
        );
      },
      { deadline: Date.now() + 5_000 }
    );
    assert.ok(Date.now() - started < 2_000);
  });

  test('does not refuse a large file the job still has minutes for', async () => {
    await withJobDir(
      async () => {
        await assert.rejects(
          uploadToR2({ path: '/nonexistent', size: 641.8 * 1048576 }, 'k', 'video/mp4', config),
          error => !/not enough time left/.test(error.message)
        );
      },
      { deadline: Date.now() + 851_000 }
    );
  });

  test('a job without a deadline has unlimited time', async () => {
    assert.strictEqual(jobRemainingMs(), Infinity);
    await withJobDir(async () => assert.strictEqual(jobRemainingMs(), Infinity));
  });
});
