import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../logger.js';
import {
  validateNumericParameter,
  checkFFmpegInstalled,
  colorspaceRepairInputOptions,
  FFMPEG_INPUT_GUARD,
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
 * @param {string} options.quality - Quality preset: 'low', 'medium', 'high' (optional, uses botConfig.gifQuality default: 'medium')
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
  const quality = options.quality;

  // Validate quality preset
  const validQualities = ['low', 'medium', 'high'];
  if (!validQualities.includes(quality)) {
    throw new Error(`quality must be one of: ${validQualities.join(', ')}`);
  }

  logger.info(
    `Starting video to GIF conversion: ${inputPath} -> ${outputPath} (width: ${width}, fps: ${fps}, quality: ${quality})`
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

  // Quality presets for dithering - performance-optimized presets
  // Low and medium use faster Bayer dithering, high uses slower but best quality Floyd-Steinberg
  const qualityPresets = {
    low: 'bayer:bayer_scale=5',
    medium: 'sierra2_4a',
    high: 'floyd_steinberg:diff_mode=rectangle',
  };

  // Quality-specific palette generation for file size optimization
  // Lower color counts reduce file size with minimal quality impact
  const palettePresets = {
    low: 'palettegen=max_colors=128:reserve_transparent=0:stats_mode=diff',
    medium: 'palettegen=max_colors=192:reserve_transparent=0:stats_mode=diff',
    high: 'palettegen=max_colors=256:reserve_transparent=0:stats_mode=diff',
  };

  const dither = qualityPresets[quality] || qualityPresets.medium;
  const paletteGen = palettePresets[quality] || palettePresets.medium;

  // Both passes need this: pass 2 reads the same input through the same buffer source.
  let colorspaceRepair = [];
  try {
    colorspaceRepair = colorspaceRepairInputOptions(await getVideoMetadata(inputPath));
    if (colorspaceRepair.length > 0) {
      logger.info(`Repairing reserved colorspace tag on ${inputPath}`);
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

  // A real encode finishes in a couple of minutes; a longer run is a stalled ffmpeg.
  // One deadline covers both passes so it fails cleanly instead of hanging until the reaper.
  const encodeTimeoutMs = 300000;
  const signal = AbortSignal.timeout(encodeTimeoutMs);
  const inputOptions = [
    ...FFMPEG_INPUT_GUARD,
    ...colorspaceRepair,
    ...(startTime !== null ? ['-ss', `${startTime}`] : []),
    ...(duration !== null ? ['-t', `${duration}`] : []),
  ];
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
        '-vf',
        `fps=${fps},scale=${width}:-1:flags=lanczos,${paletteGen}`,
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
        `[0:v]fps=${fps},scale=${width}:-1:flags=lanczos[v];[v][1:v]paletteuse=dither=${dither}`,
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
