import { createLogger } from '../logger.js';
import { ValidationError, withCause } from '../errors.js';
import { FFMPEG_INPUT_GUARD, runFfmpeg } from './utils.js';
import { OUTPUT_FORMATS } from '../output-formats.js';
import { fromPath, tempPath } from '../media-file.js';

export { OUTPUT_FORMATS };

const logger = createLogger('convert-format');

// Converts a media file to `format`; returns the result as a new media file.
export async function convertToFormat(
  input,
  format,
  { startTime = null, duration = null, videoIndex = null, audioIndex = null } = {}
) {
  const spec = OUTPUT_FORMATS[format];
  if (!spec) throw new ValidationError('that output format is not supported.');

  const inputPath = input.path;
  const outputPath = await tempPath(`.${format}`);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...FFMPEG_INPUT_GUARD,
    ...(startTime !== null ? ['-ss', String(startTime)] : []),
    '-i',
    inputPath,
    '-map',
    spec.kind === 'audio'
      ? audioIndex !== null
        ? `0:${audioIndex}`
        : '0:a:0'
      : videoIndex !== null
        ? `0:${videoIndex}`
        : '0:v:0',
    ...(spec.kind === 'video' ? ['-map', audioIndex !== null ? `0:${audioIndex}` : '0:a:0?'] : []),
    ...(duration !== null ? ['-t', String(duration)] : []),
    ...spec.args,
    outputPath,
  ];

  try {
    await runFfmpeg(args);
    return await fromPath(outputPath, { contentType: spec.mime, filename: `out.${format}` });
  } catch (error) {
    const stderr = String(error.stderr || error.message);
    logger.warn(`ffmpeg ${format} conversion failed: ${stderr.trim().slice(0, 500)}`);
    if (spec.kind === 'audio' && /does not contain any stream|matches no streams/i.test(stderr)) {
      throw withCause(
        new ValidationError('that file has no audio to extract.'),
        `ffmpeg: ${stderr.trim().slice(-300)}`
      );
    }
    throw withCause(
      new ValidationError(`could not convert that file to ${format}.`),
      `ffmpeg: ${stderr.trim().slice(-300)}`
    );
  }
}
