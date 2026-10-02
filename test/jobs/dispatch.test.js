import { test } from 'bun:test';
import assert from 'node:assert';
import { dispatchMediaJob } from '../../src/jobs/dispatch.js';

test('an interaction Discord expired before the defer is not queued or run', async () => {
  const touched = [];
  const interaction = {
    deferred: false,
    replied: false,
    get user() {
      touched.push('user');
      return { id: '1' };
    },
    get client() {
      touched.push('client');
      return null;
    },
  };
  await dispatchMediaJob(interaction, 'download', { url: 'https://example.com/a.mp4' });
  assert.deepStrictEqual(touched, []);
});
