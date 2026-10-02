import { test, beforeAll } from 'bun:test';
import assert from 'node:assert';
import { initDatabase } from '../../src/utils/database.js';
import { getRecentOperations, flushAllOperationLogs } from '../../src/utils/operations-tracker.js';
import { createMessageAdapter } from '../../src/commands/shared/message-adapter.js';
import { handleDownloadCommand } from '../../src/commands/download.js';

beforeAll(async () => {
  await initDatabase();
});

test('a prefix command is recorded as prefix, not slash', async () => {
  const message = {
    author: { id: 'someone' },
    channel: {},
    channelId: 'c',
    guildId: 'g',
    client: { user: { id: 'bot' } },
    reply: async () => ({ edit: async () => {} }),
  };
  await handleDownloadCommand(createMessageAdapter(message, {}, { commandName: 'download' }));
  await flushAllOperationLogs();

  const [op] = getRecentOperations(1);
  assert.strictEqual(op.type, 'download');
  assert.strictEqual(op.status, 'error');
  assert.strictEqual(op.source, 'prefix');
});
