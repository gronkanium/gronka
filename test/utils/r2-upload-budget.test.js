import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { uploadBudgetMs } from '../../src/utils/r2-storage.js';

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
