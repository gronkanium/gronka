// Media worker: claims jobs from Postgres, runs them, and answers users over Discord REST.
// Any number can run; a job whose worker dies is reclaimed by another (see jobs/queue.js).
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'discord.js';
import { createLogger } from './utils/logger.js';
import { botConfig } from './utils/config.js';
import { initDatabase, markOperationAsFailed } from './utils/database.js';
import { refreshRateLimitSettings } from './utils/rate-limit.js';
import { flushAllOperationLogs, getOperation } from './utils/operations-tracker.js';
import { safeInteractionEditReply } from './utils/interaction-helpers.js';
import { JOBS_ROOT, sweepJobDirs } from './utils/media-file.js';
import { jobContext } from './jobs/context.js';
import { runMediaJob } from './jobs/run-job.js';
import { interactionFor } from './jobs/reply-target.js';
import * as queue from './jobs/queue.js';

const logger = createLogger('worker');

// Discord's reply token is dead after 15 minutes, so nothing can be delivered past this.
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
  ...(process.env.DISCORD_API_URL ? { rest: { api: process.env.DISCORD_API_URL } } : {}),
});
client.token = botConfig.discordToken;
client.rest.setToken(botConfig.discordToken);

const running = new Map();
let draining = false;
let lastPump = Date.now();

async function runJob(job) {
  logger.info(`Job ${job.id} (${job.kind}) attempt ${job.attempts} [user: ${job.user_id}]`);
  let operationId = job.operation_id;
  const beat = setInterval(
    () => queue.heartbeat(job.id).catch(error => logger.warn(`Heartbeat failed: ${error.message}`)),
    queue.HEARTBEAT_MS
  );
  let timer;
  const overtime = new Promise(resolve => (timer = setTimeout(resolve, JOB_TIME_LIMIT_MS, 'late')));
  let result;
  try {
    const interaction = await interactionFor(client, job);
    const context = {
      operationId,
      onOperation: id => {
        operationId = id;
        queue.setJobOperation(job.id, id).catch(() => {});
      },
    };
    const outcome = await Promise.race([
      jobContext.run(context, () => runMediaJob(interaction, job)).then(() => 'done'),
      overtime,
    ]);
    result =
      outcome === 'late'
        ? { ok: false, error: 'time limit' }
        : { ok: true, success: getOperation(operationId)?.status === 'success' };
  } catch (error) {
    logger.error(`Job ${job.id} crashed: ${error.message}`, error);
    result = { ok: false, error: error.message };
  } finally {
    clearInterval(beat);
    clearTimeout(timer);
  }
  await queue.finishJob(job, result).catch(error => {
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
  if (job.operation_id) {
    await markOperationAsFailed(
      job.operation_id,
      'Operation interrupted - its worker stopped and it could not be retried'
    ).catch(() => {});
  }
  await queue.forgetToken(job.id).catch(() => {});
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
}

async function shutdown(signal) {
  if (draining) return;
  draining = true;
  logger.info(`${signal}: finishing ${running.size} job(s) before exit`);
  await Promise.race([
    Promise.allSettled([...running.values()]),
    new Promise(resolve => setTimeout(resolve, DRAIN_MS)),
  ]);
  const released = await queue.releaseJobs([...running.keys()]).catch(() => 0);
  if (released) logger.info(`Handed ${released} unfinished job(s) back to the queue`);
  await flushAllOperationLogs();
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
await refreshRateLimitSettings();
await queue.listen(queue.JOB_CHANNEL, () => pump());
setInterval(() => refreshRateLimitSettings().catch(() => {}), 60_000);
setInterval(pump, POLL_MS);
setInterval(reclaim, RECLAIM_MS);
setInterval(watchdog, 10_000);
setInterval(() => sweepJobDirs().catch(() => {}), 30 * 60 * 1000);
logger.info(`Worker ${queue.WORKER_ID} ready`);
await reclaim();
await pump();
