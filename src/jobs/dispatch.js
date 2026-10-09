import { botConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import {
  enqueueJob,
  claimJob,
  finishJob,
  heartbeat,
  deleteJob,
  getConvertPicker,
  HEARTBEAT_MS,
  WORKER_ID,
} from '../utils/database/media-jobs-pg.js';
import { AppError } from '../utils/errors.js';
import { prepareReplyTarget } from './reply-target.js';
import { runMediaJob } from './run-job.js';

const logger = createLogger('jobs');

// Hands a deferred command to a worker; runs it here when workers are off or the queue is down.
export async function dispatchMediaJob(interaction, kind, args) {
  // A failed defer means Discord already expired the token; nothing could reach the user.
  if (!interaction.deferred && !interaction.replied) return;
  if (kind === 'convert' && args.picker) {
    const reply = await prepareReplyTarget(interaction);
    const id = await enqueueJob({ kind, args, reply });
    if (botConfig.mediaWorkers) return;
    const job = await claimJob(WORKER_ID, id);
    if (!job) {
      const pending = await getConvertPicker(id, args.picker.token);
      if (pending?.status === 'queued') {
        await deleteJob(id);
        throw new AppError(
          'the conversion queue is paused. please try again shortly.',
          'QUEUE_PAUSED'
        );
      }
      return;
    }
    const beat = setInterval(
      () => heartbeat(id).catch(error => logger.warn(`Heartbeat failed: ${error.message}`)),
      HEARTBEAT_MS
    );
    try {
      await runMediaJob(interaction, job);
    } finally {
      clearInterval(beat);
      await finishJob(job);
    }
    return;
  }
  if (botConfig.mediaWorkers) {
    try {
      const reply = await prepareReplyTarget(interaction);
      await enqueueJob({ kind, args, reply });
      return;
    } catch (error) {
      logger.error(`Could not queue a ${kind} job, running it in the bot: ${error.message}`);
    }
  }
  await runMediaJob(interaction, { kind, args });
}
