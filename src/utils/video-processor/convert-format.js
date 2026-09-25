import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { createLogger } from '../logger.js';
import { ValidationError } from '../errors.js';
import { FFMPEG_INPUT_GUARD } from './utils.js';
import { OUTPUT_FORMATS } from '../output-formats.js';

export { OUTPUT_FORMATS };

const logger = createLogger('convert-format');
const execFileAsync = promisify(execFile);

export async function convertToFormat(
  buffer,
  inputExt,
  format,
  { startTime = null, duration = null } = {}
) {
  const spec = OUTPUT_FORMATS[format];
  if (!spec) throw new ValidationError('that output format is not supported.');

  const base = path.join(os.tmpdir(), `gronka-fmt-${randomBytes(8).toString('hex')}`);
  const safeExt = /^\.[a-z0-9]{1,5}$/i.test(inputExt) ? inputExt : '.bin';
  const inputPath = `${base}-in${safeExt}`;
  const outputPath = `${base}-out.${format}`;
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

  await fs.writeFile(inputPath, buffer);
  try {
    await execFileAsync('ffmpeg', args, { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
    return await fs.readFile(outputPath);
  } catch (error) {
    const stderr = String(error.stderr || error.message);
    logger.warn(`ffmpeg ${format} conversion failed: ${stderr.trim().slice(0, 500)}`);
    if (spec.kind === 'audio' && /does not contain any stream|matches no streams/i.test(stderr)) {
      throw new ValidationError('that file has no audio to extract.');
    }
    throw new ValidationError(`could not convert that file to ${format}.`);
  } finally {
    await fs.rm(inputPath, { force: true });
    await fs.rm(outputPath, { force: true });
  }
}
