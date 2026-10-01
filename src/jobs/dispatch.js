import { botConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { enqueueJob } from '../utils/database/media-jobs-pg.js';
import { replyTargetOf } from './reply-target.js';
import { runMediaJob } from './run-job.js';

const logger = createLogger('jobs');

// Hands a deferred command to a worker; runs it here when workers are off or the queue is down.
export async function dispatchMediaJob(interaction, kind, args) {
  if (botConfig.mediaWorkers) {
    try {
      const reply = replyTargetOf(interaction);
      await enqueueJob({ kind, args, reply, userId: interaction.user.id });
      return;
    } catch (error) {
      logger.error(`Could not queue a ${kind} job, running it in the bot: ${error.message}`);
    }
  }
  await runMediaJob(interaction, { kind, args });
}
