import { test, beforeAll } from 'bun:test';
import assert from 'node:assert';
import { initDatabase, insertAlert } from '../../src/utils/database.js';

beforeAll(async () => {
  await initDatabase();
});

test('a failed write rejects instead of looking like nothing happened', async () => {
  await assert.rejects(
    insertAlert({ severity: null, component: 'test', title: 't', message: 'm' })
  );
});
