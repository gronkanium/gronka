import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { getR2KeyFromHash } from '../../src/utils/r2-storage.js';

test('R2 archive keys use the archives prefix', () => {
  assert.equal(getR2KeyFromHash('abc123', 'archive', '.zip'), 'archives/abc123.zip');
});
