import { processDownload } from '../commands/download.js';
import { runConvertJob } from '../commands/convert.js';
import { runOptimizeJob } from '../commands/optimize.js';
import { withJobDir } from '../utils/media-file.js';

const RUNNERS = {
  download: (interaction, a) =>
    processDownload(
      interaction,
      a.url,
      a.commandSource ?? null,
      a.startTime ?? null,
      a.duration ?? null,
      a.galleryOptions ?? {}
    ),
  convert: (interaction, args) => runConvertJob(interaction, args),
  optimize: (interaction, args) => runOptimizeJob(interaction, args),
};

export function runMediaJob(interaction, { kind, args }) {
  const run = RUNNERS[kind];
  if (!run) throw new Error(`unknown media job kind: ${kind}`);
  // The input is fetched before runMediaCommand opens its dir, so the job owns one from the start.
  return withJobDir(() => run(interaction, args));
}
