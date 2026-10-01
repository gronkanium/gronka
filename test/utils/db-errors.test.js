import { test, beforeAll } from 'bun:test';
import assert from 'node:assert';
import { initDatabase } from '../../src/utils/database.js';
import { markTemporaryUploadDeleted } from '../../src/utils/database/temporary-uploads-pg.js';

beforeAll(async () => {
  await initDatabase();
});

test('a failed write rejects instead of looking like nothing matched', async () => {
  await assert.rejects(markTemporaryUploadDeleted('not-a-number', Date.now()));
});
