import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../logger.js';
import {
  validateNumericParameter,
  checkFFmpegInstalled,
  FFMPEG_INPUT_GUARD,
  runFfmpeg,
} from './utils.js';

const logger = createLogger('trim-gif');

/**
 * Trim GIF file using FFmpeg (keeps GIF format, no conversion)
 * @param {string} inputPath - Path to input GIF file
 * @param {string} outputPath - Path to output GIF file
 * @param {Object} options - Trim options
 * @param {number|null} options.startTime - Trim start time in seconds (optional)
 * @param {number|null} options.duration - Trim duration in seconds (optional)
 * @returns {Promise<void>}
 */
export async function trimGif(inputPath, outputPath, options = {}) {
  // Validate and sanitize numeric parameters
  const startTime = validateNumericParameter(
    options.startTime ?? null,
    'startTime',
    0,
    Infinity,
    true
  );
  const duration = validateNumericParameter(
    options.duration ?? null,
    'duration',
    0.1,
    Infinity,
    true
  );

  // At least one time parameter must be provided
  if (startTime === null && duration === null) {
    throw new Error('Either startTime or duration must be provided for GIF trimming');
  }

  logger.info(
    `Starting GIF trim: ${inputPath} -> ${outputPath} (startTime: ${startTime}, duration: ${duration})`
  );

  // Validate input file exists
  try {
    await fs.access(inputPath);
  } catch {
    logger.error(`Input GIF file not found: ${inputPath}`);
    throw new Error(`Input GIF file not found: ${inputPath}`);
  }

  // Check if FFmpeg is installed
  const ffmpegInstalled = await checkFFmpegInstalled();
  if (!ffmpegInstalled) {
    logger.error('FFmpeg is not installed');
    throw new Error('FFmpeg is not installed. Please install FFmpeg to use this feature.');
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  await fs.mkdir(outputDir, { recursive: true });

  // For GIF trimming, we need to:
  // 1. Seek to start time (as input option for faster seeking)
  // 2. Trim duration (as output option)
  // 3. Maintain GIF format and quality

  // Add start time as input option (before -i) for faster seeking
  const inputOptions = [...FFMPEG_INPUT_GUARD];
  if (startTime !== null) {
    inputOptions.push('-ss', `${startTime}`);
  }

  // Build output options for GIF
  const outputOptions = [
    '-c:v',
    'gif', // Use GIF codec to maintain GIF format
    '-loop',
    '0', // Infinite loop
    '-gifflags',
    '+transdiff', // Better compression for GIFs
    '-avoid_negative_ts',
    'make_zero', // Handle timestamp issues
  ];

  // Add duration as output option
  if (duration !== null) {
    outputOptions.push('-t', `${duration}`);
  }

  outputOptions.push('-y'); // Overwrite output file

  try {
    await runFfmpeg([...inputOptions, '-i', inputPath, ...outputOptions, outputPath]);
  } catch (err) {
    logger.error('FFmpeg GIF trim failed:', err.stderr);
    throw new Error(`GIF trimming failed: ${err.message}`, { cause: err });
  }
  logger.debug(`GIF trim completed: ${outputPath}`);
}
