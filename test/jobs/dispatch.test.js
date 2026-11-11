import { test } from 'bun:test';
import assert from 'node:assert';
import { DiscordAPIError } from 'discord.js';
import { dispatchMediaJob } from '../../src/jobs/dispatch.js';
import { safeInteractionDeferReply } from '../../src/utils/interaction-helpers.js';
import { getAlerts } from '../../src/utils/database.js';

test('an interaction Discord expired before the defer is recorded, not queued or run', async () => {
  const since = Date.now();
  const url = `https://example.com/expired-${since}.mp4`;
  const touched = [];
  const interaction = {
    deferred: false,
    replied: false,
    createdTimestamp: since - 4000,
    deferReply: async () => {
      throw new DiscordAPIError(
        { message: 'Unknown interaction', code: 10062 },
        10062,
        404,
        'POST',
        'https://discord.com/api/v10/interactions/1/secret-token/callback',
        {}
      );
    },
    get user() {
      touched.push('user');
      return { id: '1' };
    },
    get client() {
      touched.push('client');
      return null;
    },
  };
  assert.strictEqual(await safeInteractionDeferReply(interaction), false);
  await dispatchMediaJob(interaction, 'download', { url });
  assert.deepStrictEqual(touched, []);

  const [alert] = await getAlerts({ command: 'download', startTime: since, search: url });
  assert.ok(alert, 'the missed acknowledgement left a failure record');
  const metadata = JSON.parse(alert.metadata);
  assert.strictEqual(metadata.errorClass, 'not_acknowledged');
  assert.strictEqual(metadata.code, 10062);
  assert.strictEqual(metadata.cause, 'discord POST 404 code 10062: Unknown interaction');
  assert.strictEqual(metadata.url, url);
  assert.ok(!alert.metadata.includes('secret-token'));
});
