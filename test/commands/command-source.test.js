import { test, beforeAll } from 'bun:test';
import assert from 'node:assert';
import { initDatabase } from '../../src/utils/database.js';
import { getPostgresConnection } from '../../src/utils/database/connection.js';
import { flushAllOperationLogs } from '../../src/utils/operations-tracker.js';
import { createMessageAdapter } from '../../src/commands/shared/message-adapter.js';
import { handleDownloadCommand } from '../../src/commands/download.js';

beforeAll(async () => {
  await initDatabase();
});

test('a prefix command is recorded as prefix, not slash', async () => {
  const userId = `prefix-${Date.now()}`;
  const message = {
    author: { id: userId },
    channel: {},
    channelId: 'c',
    guildId: 'g',
    client: { user: { id: 'bot' } },
    reply: async () => ({ edit: async () => {} }),
  };
  await handleDownloadCommand(createMessageAdapter(message, {}, { commandName: 'download' }));
  await flushAllOperationLogs();

  const rows = await getPostgresConnection()`
    SELECT metadata::jsonb ->> 'commandSource' AS source FROM operation_logs
    WHERE step = 'created' AND metadata::jsonb ->> 'userId' = ${userId}`;
  assert.deepStrictEqual(
    rows.map(r => r.source),
    ['prefix']
  );
});
