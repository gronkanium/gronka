import os from 'node:os';
import { getPostgresConnection } from '../utils/database/connection.js';
import { ensurePostgresInitialized } from '../utils/database/init.js';

export const JOB_CHANNEL = 'media_jobs';
export const DONE_CHANNEL = 'media_jobs_done';
export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 45_000;
export const MAX_ATTEMPTS = 3;
// A retry needs time left on the reply token to be worth starting.
const MIN_TOKEN_LEFT_MS = 60_000;

export const WORKER_ID = `${os.hostname()}-${process.pid}`;

async function db() {
  await ensurePostgresInitialized();
  return getPostgresConnection();
}

export async function enqueueJob({ kind, args, reply, userId }) {
  const sql = await db();
  const now = Date.now();
  const [row] = await sql`
    INSERT INTO media_jobs (kind, args, reply, user_id, created_at, timestamp)
    VALUES (${kind}, ${sql.json(args)}, ${sql.json(reply)}, ${userId}, ${now}, ${now})
    RETURNING id
  `;
  await sql`SELECT pg_notify(${JOB_CHANNEL}, ${String(row.id)})`;
  return row.id;
}

export async function claimJob(worker = WORKER_ID) {
  const sql = await db();
  const now = Date.now();
  const [row] = await sql`
    UPDATE media_jobs
    SET status = 'running', attempts = attempts + 1, worker = ${worker},
        heartbeat_at = ${now}, timestamp = ${now}
    WHERE id = (
      SELECT id FROM media_jobs WHERE status = 'queued'
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING *
  `;
  return row ?? null;
}

// False means another worker took the job over (this one stalled past STALE_MS).
export async function heartbeat(id, worker = WORKER_ID) {
  const sql = await db();
  const rows = await sql`
    UPDATE media_jobs SET heartbeat_at = ${Date.now()}
    WHERE id = ${id} AND worker = ${worker} AND status = 'running'
    RETURNING id
  `;
  return rows.length > 0;
}

export async function setJobOperation(id, operationId) {
  const sql = await db();
  await sql`UPDATE media_jobs SET operation_id = ${operationId} WHERE id = ${id}`;
}

// ok: the job ran to the end; success: the command delivered (what starts a user's cooldown).
// The token is only needed while the job can still reply, so it never outlives the job.
export async function finishJob(job, { ok, success = false, error = null }, worker = WORKER_ID) {
  const sql = await db();
  const rows = await sql`
    UPDATE media_jobs
    SET status = ${ok ? 'done' : 'failed'}, error = ${error}, timestamp = ${Date.now()},
        reply = reply - 'token'
    WHERE id = ${job.id} AND worker = ${worker} AND status = 'running'
    RETURNING id
  `;
  if (rows.length) {
    await sql`SELECT pg_notify(${DONE_CHANNEL}, ${JSON.stringify({ userId: job.user_id, success })})`;
  }
  return rows.length > 0;
}

// Hands this worker's unfinished jobs straight back instead of waiting for them to go stale.
export async function releaseJobs(ids, worker = WORKER_ID) {
  if (ids.length === 0) return 0;
  const sql = await db();
  const rows = await sql`
    UPDATE media_jobs SET status = 'queued', worker = NULL, timestamp = ${Date.now()}
    WHERE id = ANY(${ids}) AND worker = ${worker} AND status = 'running'
    RETURNING id
  `;
  if (rows.length) await sql`SELECT pg_notify(${JOB_CHANNEL}, 'released')`;
  return rows.length;
}

const canRetry = (job, now) =>
  job.attempts < MAX_ATTEMPTS && (job.reply.expiresAt ?? Infinity) - now > MIN_TOKEN_LEFT_MS;

// Requeues jobs whose worker went silent; returns the ones that cannot be retried, now failed,
// so the caller can tell their users. Each row changes state once, whichever worker sweeps it.
export async function reclaimStaleJobs(now = Date.now()) {
  const sql = await db();
  const stale = await sql`
    SELECT * FROM media_jobs
    WHERE (status = 'running' AND heartbeat_at < ${now - STALE_MS})
       OR (status = 'queued' AND (reply->>'expiresAt')::bigint < ${now})
  `;
  const failed = [];
  for (const job of stale) {
    const retry = job.status === 'running' && canRetry(job, now);
    const [changed] = await sql`
      UPDATE media_jobs
      SET status = ${retry ? 'queued' : 'failed'}, worker = NULL, timestamp = ${now},
          error = ${retry ? null : 'interrupted'}
      WHERE id = ${job.id} AND status = ${job.status}
        AND (status <> 'running' OR heartbeat_at < ${now - STALE_MS})
      RETURNING *
    `;
    if (changed && !retry) failed.push(changed);
  }
  if (stale.length > failed.length) await sql`SELECT pg_notify(${JOB_CHANNEL}, 'reclaimed')`;
  return failed;
}

export async function forgetToken(id) {
  const sql = await db();
  await sql`UPDATE media_jobs SET reply = reply - 'token' WHERE id = ${id}`;
}

export async function listen(channel, fn) {
  const sql = await db();
  return sql.listen(channel, fn);
}
