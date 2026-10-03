import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { recordFailure } from '../../src/utils/failures.js';
import { getAlerts } from '../../src/utils/database.js';
import { withLogRef } from '../../src/utils/logger.js';

const latest = async (command, since) =>
  JSON.parse((await getAlerts({ command, startTime: since, limit: 1 }))[0].metadata);

describe('recordFailure', () => {
  test('keeps the cause and its code, with any link cut to the site', async () => {
    const since = Date.now();
    const command = `t-cause-${since}`;
    const cause = Object.assign(new Error('cobalt said no for https://youtu.be/abc?si=x'), {
      code: 'error.api.content.video.age',
    });
    await recordFailure(command, { error: 'could not download this video', cause });
    const metadata = await latest(command, since);
    assert.strictEqual(metadata.code, 'error.api.content.video.age');
    assert.strictEqual(metadata.cause, 'cobalt said no for youtu.be');
  });

  test('a cause that only repeats the error is not stored twice', async () => {
    const since = Date.now();
    const command = `t-same-${since}`;
    await recordFailure(command, { error: 'boom', cause: new Error('boom') });
    const metadata = await latest(command, since);
    assert.strictEqual(metadata.cause, null);
  });

  test('the record carries the reference of the job that failed', async () => {
    const since = Date.now();
    const command = `t-ref-${since}`;
    await withLogRef('ref123', () => recordFailure(command, { error: 'x' }));
    assert.strictEqual((await latest(command, since)).ref, 'ref123');
  });
});
