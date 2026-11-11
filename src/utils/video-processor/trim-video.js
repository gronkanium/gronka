import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../logger.js';
import {
  validateNumericParameter,
  checkFFmpegInstalled,
  FFMPEG_INPUT_GUARD,
  runFfmpeg,
} from './utils.js';

const logger = createLogger('trim-video');

export async function trimVideo(inputPath, outputPath, options = {}) {
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
    throw new Error('Either startTime or duration must be provided for video trimming');
  }

  logger.debug(
    `Starting video trim: ${inputPath} -> ${outputPath} (startTime: ${startTime}, duration: ${duration})`
  );

  // Validate input file exists
  try {
    await fs.access(inputPath);
  } catch {
    logger.error(`Input video file not found: ${inputPath}`);
    throw new Error(`Input video file not found: ${inputPath}`);
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

  // Re-encode, not -c copy: stream copy cuts only at keyframes and can leave an unplayable file.
  const inputOptions = [...FFMPEG_INPUT_GUARD];
  if (startTime !== null) {
    inputOptions.push('-ss', `${startTime}`);
  }

  // Build output options with re-encoding for accurate trimming
  const outputOptions = [
    '-c:v',
    'libx264', // Re-encode video with H.264 (widely compatible)
    '-preset',
    'fast', // Faster encoding, good quality balance
    '-crf',
    '26', // Optimized for file size while maintaining good quality (18-28 range)
    '-c:a',
    'aac', // Re-encode audio to AAC (widely compatible)
    '-b:a',
    '128k', // Audio bitrate - optimized for web, good quality
    '-movflags',
    '+faststart', // Enable fast start for web playback
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
    logger.error('FFmpeg video trim failed:', err.stderr);
    throw new Error(`Video trimming failed: ${err.message}`, { cause: err });
  }
  logger.debug(`Video trim completed: ${outputPath}`);
}
