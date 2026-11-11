import { test, beforeAll, afterEach, spyOn } from 'bun:test';
import assert from 'node:assert';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { initDatabase, getAlertSummary } from '../../src/utils/database.js';
import { deleteExpiredR2Files } from '../../src/utils/r2-cleanup.js';

let send;
beforeAll(() => initDatabase());
afterEach(() => send?.mockRestore());

test('a cleanup that cannot delete leaves a warning the Issues page lists', async () => {
  const lastModified = new Date(Date.now() - 365 * 86400e3);
  send = spyOn(S3Client.prototype, 'send').mockImplementation(async command =>
    command instanceof ListObjectsV2Command
      ? {
          Contents: [
            { Key: `${command.input.Prefix}stuck.mp4`, Size: 10, LastModified: lastModified },
          ],
        }
      : { Errors: command.input.Delete.Objects.map(({ Key }) => ({ Key, Code: 'InternalError' })) }
  );
  const result = await deleteExpiredR2Files({
    accountId: 'test-account',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    bucketName: 'test-bucket',
  });
  assert.ok(result.failed > 0);
  const { byReason } = await getAlertSummary({ component: 'r2-cleanup' });
  assert.ok(byReason.some(r => r.reason?.startsWith('R2 cleanup could not delete')));
});
