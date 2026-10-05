import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { recordFailure } from '../../src/utils/failures.js';
import { getAlerts } from '../../src/utils/database.js';
import { withLogRef } from '../../src/utils/logger.js';
import { AppError, NetworkError, describeCause } from '../../src/utils/errors.js';

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
    assert.strictEqual(
      metadata.cause,
      'error.api.content.video.age: cobalt said no for https://youtu.be/abc?si=x'
    );
  });

  test('keeps the full link, the specific cause, the trail and the options', async () => {
    const since = Date.now();
    const command = `t-full-${since}`;
    const http = Object.assign(new Error('Request failed with status code 500'), {
      config: { method: 'get', url: 'https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=1' },
      response: { status: 500 },
    });
    const error = new NetworkError('failed to reach instagram', undefined, undefined, {
      cause: http,
    });
    error.trail = [
      { step: 'cobalt', error: 'cobalt: error.api.fetch.empty' },
      { step: 'instagram session', error: describeCause(http) },
    ];
    const url = 'https://www.instagram.com/stories/someuser/123/?igsh=abc';
    await recordFailure(command, {
      error: error.message,
      errorClass: error.name,
      url,
      cause: error,
      options: { startTime: '0:05', duration: null, mp3: false, format: 'gif' },
    });
    const metadata = await latest(command, since);
    assert.strictEqual(metadata.url, url);
    assert.strictEqual(metadata.source, 'instagram.com');
    assert.strictEqual(metadata.cause, 'GET i.instagram.com/api/v1/feed/reels_media/ HTTP 500');
    assert.deepStrictEqual(metadata.trail, error.trail);
    assert.deepStrictEqual(metadata.options, { startTime: '0:05', format: 'gif' });
  });

  test('a discord failure is described by method, status and code', async () => {
    const since = Date.now();
    const command = `t-discord-${since}`;
    const discord = Object.assign(new Error('Request entity too large'), {
      method: 'PATCH',
      status: 413,
    });
    await recordFailure(command, {
      error: 'discord rejected this upload as too large.',
      cause: new AppError('x', 'DISCORD_DELIVERY_FAILED', 500, { cause: discord }),
    });
    assert.strictEqual(
      (await latest(command, since)).cause,
      'discord PATCH 413 (empty body): Request entity too large'
    );
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
