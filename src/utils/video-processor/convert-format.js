import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../logger.js';
import { ValidationError, withCause } from '../errors.js';
import { FFMPEG_INPUT_GUARD } from './utils.js';
import { OUTPUT_FORMATS } from '../output-formats.js';
import { fromPath, tempPath } from '../media-file.js';

export { OUTPUT_FORMATS };

const logger = createLogger('convert-format');
const execFileAsync = promisify(execFile);

// Converts a media file to `format`; returns the result as a new media file.
export async function convertToFormat(input, format, { startTime = null, duration = null } = {}) {
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
    ...(duration !== null ? ['-t', String(duration)] : []),
    ...spec.args,
    outputPath,
  ];

  try {
    await execFileAsync('ffmpeg', args, { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
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
