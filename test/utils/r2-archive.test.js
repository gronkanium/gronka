import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { newMediaKey } from '../../src/utils/r2-storage.js';

test('media keys are random under their type prefix and say nothing about the file', () => {
  const a = newMediaKey('archive', '.zip');
  const b = newMediaKey('archive', '.zip');
  assert.match(a, /^archives\/[0-9a-f]{32}\.zip$/);
  assert.notEqual(a, b);
  assert.match(newMediaKey('gif', '.webp'), /^gifs\/[0-9a-f]{32}\.gif$/);
  assert.match(newMediaKey('video', 'mp4'), /^videos\/[0-9a-f]{32}\.mp4$/);
  assert.throws(() => newMediaKey('nope', '.x'));
});
