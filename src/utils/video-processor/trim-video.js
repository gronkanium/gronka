import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../logger.js';
import { validateNumericParameter, checkFFmpegInstalled } from './utils.js';

const logger = createLogger('trim-video');

/**
 * Trim video file using FFmpeg (keeps original format, no conversion)
 * @param {string} inputPath - Path to input video file
 * @param {string} outputPath - Path to output video file
 * @param {Object} options - Trim options
 * @param {number|null} options.startTime - Trim start time in seconds (optional)
 * @param {number|null} options.duration - Trim duration in seconds (optional)
 * @returns {Promise<void>}
 */
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

  logger.info(
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

  return new Promise((resolve, reject) => {
    const ffmpegCommand = ffmpeg(inputPath);

    // For accurate trimming, we need to re-encode instead of using -c copy
    // Stream copy (-c copy) can only cut at keyframes, which can cause:
    // 1. Inaccurate trim points
    // 2. Corrupted files when trim points don't align with keyframes
    // 3. Empty or unplayable files
    // Re-encoding ensures frame-accurate trimming and valid output files

    // Add start time as input option (before -i) for faster seeking
    // Then decode and trim accurately
    if (startTime !== null) {
      ffmpegCommand.inputOptions([`-ss ${startTime}`]);
    }

    // Build output options with re-encoding for accurate trimming
    const outputOptions = [
      '-c:v',
      'libx264', // Re-encode video with H.264 (widely compatible)
      '-preset',
      'fast', // Faster encoding, good quality balance
      '-crf',
      '23', // Good quality (lower = better, 18-28 is typical range)
      '-c:a',
      'aac', // Re-encode audio to AAC (widely compatible)
      '-b:a',
      '192k', // Audio bitrate
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

    ffmpegCommand
      .outputOptions(outputOptions)
      .output(outputPath)
      .on('error', (err, stdout, stderr) => {
        logger.error('FFmpeg video trim failed:', stderr);
        reject(new Error(`Video trimming failed: ${err.message}`));
      })
      .on('end', () => {
        logger.debug(`Video trim completed: ${outputPath}`);
        resolve();
      })
      .run();
  });
}
