import assert from 'node:assert/strict';
import { test, spyOn } from 'bun:test';
import { S3Client } from '@aws-sdk/client-s3';
import { newMediaKey, randomKey, deleteExpired } from '../../src/utils/r2-storage.js';

test('media keys are random under their type prefix and say nothing about the file', () => {
  const a = newMediaKey('archive', '.zip');
  const b = newMediaKey('archive', '.zip');
  assert.match(a, /^archives\/[0-9a-f]{32}\.zip$/);
  assert.notEqual(a, b);
  assert.match(newMediaKey('gif', '.webp'), /^gifs\/[0-9a-f]{32}\.gif$/);
  assert.match(newMediaKey('video', 'mp4'), /^videos\/[0-9a-f]{32}\.mp4$/);
  assert.throws(() => newMediaKey('nope', '.x'));
  assert.match(randomKey('web/', '.mp4'), /^web\/[0-9a-f]{32}\.mp4$/);
  assert.match(randomKey('web/', ''), /^web\/[0-9a-f]{32}$/);
});

test('a sweep counts the objects R2 refused to delete as still there', async () => {
  const send = spyOn(S3Client.prototype, 'send').mockResolvedValue({ Errors: [{ Key: 'b' }] });
  try {
    const objects = [
      { key: 'a', size: 1 },
      { key: 'b', size: 2 },
      { key: 'c', size: 4 },
    ];
    const config = { accountId: 'x', accessKeyId: 'x', secretAccessKey: 'x', bucketName: 'x' };
    assert.deepEqual(await deleteExpired(objects, ['a', 'b'], config), {
      deleted: 1,
      failed: 1,
      bytes: 6,
    });
    assert.equal(send.mock.calls.length, 1);
    assert.deepEqual(await deleteExpired(objects, [], config), { deleted: 0, failed: 0, bytes: 7 });
    assert.equal(send.mock.calls.length, 1);
  } finally {
    send.mockRestore();
  }
});
