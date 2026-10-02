import os from 'node:os';
import pkg from '../../../package.json' with { type: 'json' };
import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';
import { getBooleanSetting } from './settings-pg.js';

export const JOB_CHANNEL = 'media_jobs';
export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 45_000;
export const MAX_ATTEMPTS = 3;
// A bot_settings flag: while 'true' no worker claims a job; running jobs still finish.
export const PAUSE_KEY = 'queue_paused';
// A retry needs time left on the reply token to be worth starting.
const MIN_TOKEN_LEFT_MS = 60_000;

export const WORKER_ID = `${os.hostname()}-${process.pid}`;

async function db() {
  await ensurePostgresInitialized();
  return getPostgresConnection();
}

export async function enqueueJob({ kind, args, reply }) {
  const sql = await db();
  const now = Date.now();
  const [row] = await sql`
    INSERT INTO media_jobs (kind, args, reply, created_at, timestamp)
    VALUES (${kind}, ${sql.json(args)}, ${sql.json(reply)}, ${now}, ${now})
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
        AND NOT EXISTS (SELECT 1 FROM bot_settings WHERE key = ${PAUSE_KEY} AND value = 'true')
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

// A finished job leaves nothing behind: the row, its args and its reply token go together.
export async function finishJob(job, worker = WORKER_ID) {
  const sql = await db();
  const rows = await sql`
    DELETE FROM media_jobs WHERE id = ${job.id} AND worker = ${worker} AND status = 'running'
    RETURNING id
  `;
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

export async function deleteJob(id) {
  const sql = await db();
  await sql`DELETE FROM media_jobs WHERE id = ${id}`;
}

export async function listen(channel, fn) {
  const sql = await db();
  return sql.listen(channel, fn);
}

// Read-only view for the webui. Never selects `reply`: it holds the interaction token.
// Read-only view for the webui. Never selects `reply` (the interaction token) or `args`.
export async function jobsOverview({ limit = 25 } = {}) {
  const sql = await db();
  const [paused, processes, jobs] = await Promise.all([
    getBooleanSetting(PAUSE_KEY),
    presence(),
    sql`
      SELECT id, kind, status, attempts, worker, created_at, timestamp, heartbeat_at
      FROM media_jobs ORDER BY id DESC LIMIT ${limit}
    `,
  ]);
  const recent = jobs.map(row => ({
    ...row,
    id: Number(row.id),
    created_at: Number(row.created_at),
    timestamp: Number(row.timestamp),
    heartbeat_at: row.heartbeat_at == null ? null : Number(row.heartbeat_at),
  }));
  const count = status => recent.filter(job => job.status === status).length;
  return {
    paused,
    processes,
    counts: { queued: count('queued'), running: count('running') },
    recent,
  };
}

// Presence: every bot and worker process reports in, so the webui can tell live, idle and dead apart.
export const PRESENCE_MS = 10_000;
let lastCpu = null;

export async function reportPresence({ role, running = 0 }) {
  const sql = await db();
  const now = Date.now();
  const usage = process.cpuUsage();
  const cpu = lastCpu
    ? ((usage.user + usage.system - lastCpu.total) / 1000 / (now - lastCpu.at)) * 100
    : null;
  lastCpu = { total: usage.user + usage.system, at: now };
  const startedAt = Math.round(now - process.uptime() * 1000);
  await sql`
    INSERT INTO media_workers (id, role, version, started_at, seen_at, rss, cpu, running)
    VALUES (${WORKER_ID}, ${role}, ${pkg.version}, ${startedAt}, ${now}, ${process.memoryUsage().rss},
            ${cpu}, ${running})
    ON CONFLICT (id) DO UPDATE SET seen_at = EXCLUDED.seen_at, rss = EXCLUDED.rss,
      cpu = EXCLUDED.cpu, running = EXCLUDED.running, version = EXCLUDED.version
  `;
  // A process that died with the database (deploy, crash) never clears its own row.
  await sql`DELETE FROM media_workers WHERE seen_at < ${now - 30 * PRESENCE_MS}`;
}

export async function clearPresence() {
  const sql = await db();
  await sql`DELETE FROM media_workers WHERE id = ${WORKER_ID}`;
}

export async function presence() {
  const sql = await db();
  const rows = await sql`SELECT * FROM media_workers ORDER BY role, started_at`;
  return rows.map(r => ({
    ...r,
    started_at: Number(r.started_at),
    seen_at: Number(r.seen_at),
    rss: r.rss == null ? null : Number(r.rss),
  }));
}
