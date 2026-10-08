import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../logger.js';
import {
  validateNumericParameter,
  checkFFmpegInstalled,
  FFMPEG_TIMEOUT_MS,
  colorspaceRepairInputOptions,
  FFMPEG_INPUT_GUARD,
  GIF_PALETTEGEN,
  GIF_PALETTEUSE,
  runFfmpeg,
} from './utils.js';
import { getVideoMetadata } from './metadata.js';

const logger = createLogger('convert-to-gif');

/**
 * Convert video file to GIF using FFmpeg with two-pass palette generation.
 * Runs inside a bounded media-processing slot so concurrent encodes can't starve the box.
 * @param {string} inputPath - Path to input video file
 * @param {string} outputPath - Path to output GIF file
 * @param {Object} options - Conversion options
 * @param {number} options.width - Output width in pixels (default: 480)
 * @param {number} options.fps - Frames per second (default: 30)
 * @param {number|null} options.startTime - Trim start time in seconds (optional)
 * @param {number|null} options.duration - Trim duration in seconds (optional)
 * @returns {Promise<void>}
 */
export async function convertToGif(inputPath, outputPath, options = {}) {
  return convertToGifImpl(inputPath, outputPath, options);
}

async function convertToGifImpl(inputPath, outputPath, options = {}) {
  // Validate and sanitize numeric parameters
  const width = validateNumericParameter(options.width ?? 480, 'width', 1, 4096);
  const fps = validateNumericParameter(options.fps ?? 30, 'fps', 0.1, 120);
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

  logger.debug(
    `Starting video to GIF conversion: ${inputPath} -> ${outputPath} (width: ${width}, fps: ${fps})`
  );

  // Check if FFmpeg is installed
  const ffmpegInstalled = await checkFFmpegInstalled();
  if (!ffmpegInstalled) {
    logger.error('FFmpeg is not installed');
    throw new Error('FFmpeg is not installed. Please install FFmpeg to use this feature.');
  }

  // Validate input file exists
  try {
    await fs.access(inputPath);
  } catch {
    logger.error(`Input video file not found: ${inputPath}`);
    throw new Error(`Input video file not found: ${inputPath}`);
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  await fs.mkdir(outputDir, { recursive: true });

  // Both passes need this: pass 2 reads the same input through the same buffer source.
  let colorspaceRepair = [];
  try {
    colorspaceRepair = colorspaceRepairInputOptions(await getVideoMetadata(inputPath));
    if (colorspaceRepair.length > 0) {
      logger.debug(`Repairing reserved colorspace tag on ${inputPath}`);
    }
  } catch (error) {
    // A probe failure is not fatal, the conversion is what matters, and it reports its own error.
    logger.warn(`Could not probe colorspace, continuing unrepaired: ${error.message}`);
  }

  const palettePath = path.join(
    path.dirname(inputPath),
    path.basename(outputPath) + '.palette.png'
  );
  const cleanupPalette = () => fs.unlink(palettePath).catch(() => {});

  // One deadline covers both passes so it fails cleanly instead of hanging until the reaper.
  const encodeTimeoutMs = FFMPEG_TIMEOUT_MS;
  const signal = AbortSignal.timeout(encodeTimeoutMs);
  const inputOptions = [
    ...FFMPEG_INPUT_GUARD,
    ...colorspaceRepair,
    ...(startTime !== null ? ['-ss', `${startTime}`] : []),
    ...(duration !== null ? ['-t', `${duration}`] : []),
  ];
  const videoStream = options.videoIndex == null ? '0:v' : `0:${options.videoIndex}`;
  const timedOut = async () => {
    logger.error(`FFmpeg GIF conversion timed out after ${encodeTimeoutMs / 1000}s, killing`);
    await cleanupPalette();
    return new Error(`GIF conversion timed out after ${encodeTimeoutMs / 1000}s`);
  };

  try {
    await runFfmpeg(
      [
        ...inputOptions,
        '-i',
        inputPath,
        '-map',
        videoStream,
        '-vf',
        `fps=${fps},scale=${width}:-1:flags=lanczos,${GIF_PALETTEGEN}`,
        '-y',
        palettePath,
      ],
      { signal }
    );
  } catch (err) {
    if (signal.aborted) throw await timedOut();
    logger.error('FFmpeg pass 1 (palette) failed:', err.stderr);
    throw new Error(`Palette generation failed: ${err.message}`, { cause: err });
  }

  try {
    await runFfmpeg(
      [
        ...inputOptions,
        '-i',
        inputPath,
        '-i',
        palettePath,
        '-filter_complex',
        `[${videoStream}]fps=${fps},scale=${width}:-1:flags=lanczos[v];[v][1:v]${GIF_PALETTEUSE}`,
        '-loop',
        '0',
        '-y',
        outputPath,
      ],
      { signal }
    );
  } catch (err) {
    if (signal.aborted) throw await timedOut();
    logger.error('FFmpeg pass 2 (conversion) failed:', err.stderr);
    await cleanupPalette();
    throw new Error(`GIF conversion failed: ${err.message}`, { cause: err });
  }

  await cleanupPalette();
  logger.debug(`Video to GIF conversion completed: ${outputPath}`);
}
