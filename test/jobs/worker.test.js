import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import { initDatabase } from '../../src/utils/database.js';
import { getPostgresConnection } from '../../src/utils/database/connection.js';
import { STALE_MS, MAX_ATTEMPTS } from '../../src/utils/database/media-jobs-pg.js';
import { startFakeDiscordApi } from '../helpers/fake-discord-api.js';

let sql;
let api;
let worker;

const pngAttachment = {
  url: 'https://cdn.discordapp.com/attachments/1/2/a.png',
  name: 'a.png',
  size: 10,
  contentType: 'image/png',
};

async function insertJob({ status, attempts = 0, heartbeatAge = 0, token }) {
  const now = Date.now();
  const [row] = await sql`
    INSERT INTO media_jobs (kind, args, reply, status, attempts, worker, created_at,
                            timestamp, heartbeat_at)
    VALUES ('optimize', ${sql.json({ attachment: pngAttachment, commandSource: 'slash' })},
            ${sql.json({ kind: 'interaction', appId: 'app', token, expiresAt: now + 600_000 })},
            ${status}, ${attempts}, ${status === 'running' ? 'dead-worker' : null},
            ${now}, ${now}, ${status === 'running' ? now - heartbeatAge : null})
    RETURNING id
  `;
  return row.id;
}

async function until(check, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await Bun.sleep(200);
  }
  return false;
}

const statusOf = async id => (await sql`SELECT * FROM media_jobs WHERE id = ${id}`)[0];
const editsFor = token =>
  api.calls.filter(c => c.method === 'PATCH' && c.path.startsWith(`/webhooks/app/${token}/`));

beforeAll(async () => {
  await initDatabase();
  sql = getPostgresConnection();
  await sql`DELETE FROM media_jobs`;
  api = startFakeDiscordApi();
});
afterAll(() => {
  worker?.kill('SIGKILL');
  api.stop();
});

describe('media worker process', () => {
  test('retries an orphaned job, fails one out of attempts, runs a new one, drains', async () => {
    const orphan = await insertJob({
      status: 'running',
      attempts: 1,
      heartbeatAge: STALE_MS + 5000,
      token: 'orphan',
    });
    const spent = await insertJob({
      status: 'running',
      attempts: MAX_ATTEMPTS,
      heartbeatAge: STALE_MS + 5000,
      token: 'spent',
    });
    const fresh = await insertJob({ status: 'queued', token: 'fresh' });

    worker = Bun.spawn(['bun', 'src/worker.js'], {
      env: {
        ...process.env,
        DISCORD_API_URL: api.url,
        WORKER_DRAIN_MS: '2000',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    // A finished job, done or failed, leaves no row behind.
    const settled = await until(async () => {
      const rows = await Promise.all([orphan, spent, fresh].map(statusOf));
      return rows.every(row => row === undefined);
    });
    assert.ok(settled, 'all three jobs should finish and be deleted');

    assert.match(editsFor('orphan').at(-1).body.content, /only works on gif/);
    assert.match(editsFor('spent').at(-1).body.content, /interrupted/);
    assert.match(editsFor('fresh').at(-1).body.content, /only works on gif/);

    worker.kill('SIGTERM');
    assert.strictEqual(await worker.exited, 0, 'worker exits cleanly on SIGTERM');
  }, 60_000);
});
