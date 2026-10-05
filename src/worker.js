// Media worker: claims jobs from Postgres, runs them, and answers users over Discord REST.
// Any number can run; a job whose worker dies is reclaimed by another (see utils/database/media-jobs-pg.js).
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'discord.js';
import { createLogger } from './utils/logger.js';
import { botConfig } from './utils/config.js';
import { initDatabase } from './utils/database.js';
import { recordFailure } from './utils/failures.js';
import { countOutcome, flushCounts } from './utils/operations-tracker.js';
import { AppError } from './utils/errors.js';
import { safeInteractionEditReply, DISCORD_REST_TIMEOUT_MS } from './utils/interaction-helpers.js';
import { JOBS_ROOT, sweepJobDirs } from './utils/media-file.js';
import { runMediaJob } from './jobs/run-job.js';
import { interactionFor } from './jobs/reply-target.js';
import * as queue from './utils/database/media-jobs-pg.js';

const logger = createLogger('worker');
const warn = what => error => logger.warn(`${what}: ${error.message}`);

const JOB_TIME_LIMIT_MS = 16 * 60 * 1000;
const POLL_MS = 2000;
const RECLAIM_MS = 15_000;
const STALL_MS = 2 * 60 * 1000;
const DRAIN_MS = Number(process.env.WORKER_DRAIN_MS || 90_000);
// Read by the compose healthcheck; lives in this worker's own job dir, not a shared temp dir.
const ALIVE_FILE = path.join(JOBS_ROOT, 'alive');
const INTERRUPTED = 'this was interrupted before it could finish. please try again.';

const client = new Client({
  intents: [],
  rest: {
    timeout: DISCORD_REST_TIMEOUT_MS,
    ...(process.env.DISCORD_API_URL ? { api: process.env.DISCORD_API_URL } : {}),
  },
});
client.token = botConfig.discordToken;
client.rest.setToken(botConfig.discordToken);

const running = new Map();
let draining = false;
let lastPump = Date.now();

async function runJob(job) {
  logger.debug(`Job ${job.id} (${job.kind}) attempt ${job.attempts}`);
  const beat = setInterval(
    () => queue.heartbeat(job.id).catch(error => logger.warn(`Heartbeat failed: ${error.message}`)),
    queue.HEARTBEAT_MS
  );
  const controller = new AbortController();
  const budget = Math.max(
    0,
    Math.min(JOB_TIME_LIMIT_MS, (job.reply.expiresAt ?? Infinity) - Date.now() - 30_000)
  );
  const timer = setTimeout(() => {
    logger.error(`Job ${job.id} (${job.kind}) hit the time limit`);
    controller.abort(
      new AppError(
        'processing took too long. please try a smaller file or shorter clip.',
        'JOB_TIMEOUT'
      )
    );
  }, budget);
  try {
    const interaction = await interactionFor(client, job);
    await runMediaJob(interaction, job, {
      signal: controller.signal,
      deadline: Date.now() + budget,
    });
  } catch (error) {
    logger.error(`Job ${job.id} crashed: ${error.message}`, error);
  } finally {
    clearInterval(beat);
    clearTimeout(timer);
  }
  await queue.finishJob(job).catch(error => {
    logger.error(`Could not record job ${job.id} as finished: ${error.message}`);
  });
}

let pumping = false;
let again = false;
async function pump() {
  if (draining) return;
  if (pumping) {
    again = true;
    return;
  }
  pumping = true;
  try {
    do {
      again = false;
      for (let job; !draining && (job = await queue.claimJob());) {
        const work = runJob(job).finally(() => running.delete(job.id));
        running.set(job.id, work);
      }
    } while (again && !draining);
    lastPump = Date.now();
  } catch (error) {
    logger.warn(`Could not claim jobs: ${error.message}`);
  } finally {
    pumping = false;
  }
}

async function tellInterrupted(job) {
  try {
    await safeInteractionEditReply(await interactionFor(client, job), { content: INTERRUPTED });
  } catch (error) {
    logger.warn(`Could not tell user about interrupted job ${job.id}: ${error.message}`);
  }
  countOutcome(job.kind, 'error');
  await recordFailure(job.kind, {
    error: 'interrupted: its worker stopped and it could not be retried',
    errorClass: 'interrupted',
    url: job.args?.url ?? null,
  });
  await queue.deleteJob(job.id).catch(warn(`Could not delete job ${job.id}`));
}

async function reclaim() {
  try {
    for (const job of await queue.reclaimStaleJobs()) {
      logger.warn(`Job ${job.id} could not be retried, telling the user`);
      await tellInterrupted(job);
    }
  } catch (error) {
    logger.warn(`Reclaim sweep failed: ${error.message}`);
  }
}

// A worker whose claim loop has gone quiet exits so Docker starts a fresh one; its jobs get
// reclaimed by the others.
function watchdog() {
  if (Date.now() - lastPump > STALL_MS && !pumping) {
    logger.error('Claim loop stalled, exiting for a restart');
    process.exit(1);
  }
  fs.writeFile(ALIVE_FILE, String(Date.now()), () => {});
  queue
    .reportPresence({ role: 'worker', running: running.size })
    .catch(warn('Presence report failed'));
}

async function shutdown(signal) {
  if (draining) return;
  draining = true;
  logger.info(`${signal}: finishing ${running.size} job(s) before exit`);
  await Promise.race([
    Promise.allSettled([...running.values()]),
    new Promise(resolve => setTimeout(resolve, DRAIN_MS)),
  ]);
  const released = await queue
    .releaseJobs([...running.keys()])
    .catch(warn('Could not hand jobs back to the queue'));
  if (released) logger.info(`Handed ${released} unfinished job(s) back to the queue`);
  await flushCounts();
  await queue.clearPresence().catch(warn('Could not clear presence'));
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', error => logger.error('Unhandled rejection in worker:', error));
process.on('uncaughtException', error => {
  logger.error('Uncaught exception in worker, exiting:', error);
  process.exit(1);
});

fs.mkdirSync(JOBS_ROOT, { recursive: true, mode: 0o700 });
await initDatabase();
await queue.listen(queue.JOB_CHANNEL, () => pump());
setInterval(pump, POLL_MS);
setInterval(reclaim, RECLAIM_MS);
setInterval(watchdog, 10_000);
setInterval(() => sweepJobDirs().catch(warn('Job dir sweep failed')), 30 * 60 * 1000);
watchdog();
logger.info(`Worker ${queue.WORKER_ID} ready`);
await reclaim();
await pump();
