import { test, describe, beforeAll, beforeEach } from 'bun:test';
import assert from 'node:assert';
import { initDatabase } from '../../src/utils/database.js';
import { getPostgresConnection } from '../../src/utils/database/connection.js';
import * as queue from '../../src/jobs/queue.js';

let sql;
const reply = (extra = {}) => ({
  kind: 'interaction',
  appId: 'a',
  token: 't',
  expiresAt: Date.now() + 10 * 60_000,
  ...extra,
});
const enqueue = (extra = {}) =>
  queue.enqueueJob({ kind: 'download', args: { url: 'x' }, reply: reply(extra), userId: 'u1' });
const row = async id => (await sql`SELECT * FROM media_jobs WHERE id = ${id}`)[0];
const goStale = id =>
  sql`UPDATE media_jobs SET heartbeat_at = ${Date.now() - queue.STALE_MS - 1000} WHERE id = ${id}`;

beforeAll(async () => {
  await initDatabase();
  sql = getPostgresConnection();
});
beforeEach(async () => {
  await sql`DELETE FROM media_jobs`;
});

describe('media job queue', () => {
  test('a job is claimed by exactly one worker', async () => {
    await enqueue();
    const [a, b] = await Promise.all([queue.claimJob('w1'), queue.claimJob('w2')]);
    assert.strictEqual([a, b].filter(Boolean).length, 1);
    const claimed = a ?? b;
    assert.strictEqual(claimed.status, 'running');
    assert.strictEqual(claimed.attempts, 1);
  });

  test('jobs are claimed oldest first', async () => {
    const first = await enqueue();
    await enqueue();
    assert.strictEqual(String((await queue.claimJob('w1')).id), String(first));
  });

  test('finishing drops the token and only the owner can finish', async () => {
    await enqueue();
    const job = await queue.claimJob('w1');
    assert.strictEqual(await queue.finishJob(job, { ok: true }, 'w2'), false);
    assert.strictEqual(await queue.finishJob(job, { ok: true, success: true }, 'w1'), true);
    const done = await row(job.id);
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.reply.token, undefined);
  });

  test('a stale running job is requeued and a live one is left alone', async () => {
    await enqueue();
    await enqueue();
    const dead = await queue.claimJob('w1');
    const live = await queue.claimJob('w2');
    await goStale(dead.id);
    assert.deepStrictEqual(await queue.reclaimStaleJobs(), []);
    assert.strictEqual((await row(dead.id)).status, 'queued');
    assert.strictEqual((await row(live.id)).status, 'running');
    const retried = await queue.claimJob('w3');
    assert.strictEqual(String(retried.id), String(dead.id));
    assert.strictEqual(retried.attempts, 2);
  });

  test('a heartbeat from a revived worker keeps its job', async () => {
    await enqueue();
    const job = await queue.claimJob('w1');
    await goStale(job.id);
    assert.strictEqual(await queue.heartbeat(job.id, 'w1'), true);
    await queue.reclaimStaleJobs();
    assert.strictEqual((await row(job.id)).status, 'running');
  });

  test('a job out of attempts fails and is handed back to tell the user', async () => {
    await enqueue();
    const job = await queue.claimJob('w1');
    await sql`UPDATE media_jobs SET attempts = ${queue.MAX_ATTEMPTS} WHERE id = ${job.id}`;
    await goStale(job.id);
    const failed = await queue.reclaimStaleJobs();
    assert.strictEqual(failed.length, 1);
    assert.strictEqual(failed[0].reply.token, 't');
    assert.strictEqual((await row(job.id)).status, 'failed');
    await queue.forgetToken(job.id);
    assert.strictEqual((await row(job.id)).reply.token, undefined);
  });

  test('a job whose reply token is about to expire is failed, not retried', async () => {
    await enqueue({ expiresAt: Date.now() + 5000 });
    const job = await queue.claimJob('w1');
    await goStale(job.id);
    assert.strictEqual((await queue.reclaimStaleJobs()).length, 1);
  });

  test('a queued job that waited past its token expiry is failed', async () => {
    const id = await enqueue({ expiresAt: Date.now() - 1 });
    assert.strictEqual((await queue.reclaimStaleJobs()).length, 1);
    assert.strictEqual((await row(id)).status, 'failed');
  });

  test('a job is reclaimed once even when two workers sweep together', async () => {
    await enqueue();
    const job = await queue.claimJob('w1');
    await sql`UPDATE media_jobs SET attempts = ${queue.MAX_ATTEMPTS} WHERE id = ${job.id}`;
    await goStale(job.id);
    const [a, b] = await Promise.all([queue.reclaimStaleJobs(), queue.reclaimStaleJobs()]);
    assert.strictEqual(a.length + b.length, 1);
  });

  test('a draining worker hands its jobs straight back', async () => {
    await enqueue();
    const job = await queue.claimJob('w1');
    assert.strictEqual(await queue.releaseJobs([job.id], 'w1'), 1);
    assert.strictEqual((await row(job.id)).status, 'queued');
  });

  test('a process reports presence, readable with memory and role, and clears it on exit', async () => {
    await queue.reportPresence({ role: 'worker', running: 2 });
    await queue.reportPresence({ role: 'worker', running: 1 });
    const me = (await queue.presence()).find(p => p.id === queue.WORKER_ID);
    assert.strictEqual(me.role, 'worker');
    assert.strictEqual(me.running, 1);
    assert.ok(me.rss > 0);
    assert.strictEqual(typeof me.cpu, 'number', 'second report knows the cpu delta');
    await queue.clearPresence();
    assert.ok(!(await queue.presence()).some(p => p.id === queue.WORKER_ID));
  });

  test('the webui overview never exposes a reply token', async () => {
    await enqueue();
    const { recent } = await queue.jobsOverview();
    assert.ok(recent.length > 0);
    assert.ok(recent.every(j => !('reply' in j) && !JSON.stringify(j).includes('"token"')));
  });
});
