import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../logger.js';
import {
  validateNumericParameter,
  checkFFmpegInstalled,
  FFMPEG_INPUT_GUARD,
  runFfmpeg,
} from './utils.js';

const logger = createLogger('convert-image-to-gif');

/**
 * Convert image file to GIF using FFmpeg.
 * Runs inside a bounded media-processing slot so concurrent encodes can't starve the box.
 * @param {string} inputPath - Path to input image file
 * @param {string} outputPath - Path to output GIF file
 * @param {Object} options - Conversion options
 * @param {number} options.width - Output width in pixels (default: 720)
 * @param {string} options.quality - Quality preset: 'low', 'medium', 'high' (optional, uses botConfig.gifQuality default: 'medium')
 * @returns {Promise<void>}
 */
export async function convertImageToGif(inputPath, outputPath, options = {}) {
  return convertImageToGifImpl(inputPath, outputPath, options);
}

async function convertImageToGifImpl(inputPath, outputPath, options = {}) {
  // Validate and sanitize numeric parameters
  const width = validateNumericParameter(options.width ?? 720, 'width', 1, 4096);
  const quality = options.quality;

  // Validate quality preset
  const validQualities = ['low', 'medium', 'high'];
  if (!validQualities.includes(quality)) {
    throw new Error(`quality must be one of: ${validQualities.join(', ')}`);
  }

  logger.info(
    `Starting image to GIF conversion: ${inputPath} -> ${outputPath} (width: ${width}, quality: ${quality})`
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
    logger.error(`Input image file not found: ${inputPath}`);
    throw new Error(`Input image file not found: ${inputPath}`);
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

  const tempDir = path.dirname(inputPath);
  const palettePath = path.join(tempDir, path.basename(outputPath) + '.palette.png');

  try {
    await runFfmpeg([
      ...FFMPEG_INPUT_GUARD,
      '-i',
      inputPath,
      '-vf',
      `scale=${width}:-1:flags=lanczos,${paletteGen}`,
      '-y',
      '-update',
      '1',
      '-frames:v',
      '1',
      palettePath,
    ]);
  } catch (err) {
    logger.error('FFmpeg pass 1 (palette) failed for image:', err.stderr);
    throw new Error(`Palette generation failed: ${err.message}`, { cause: err });
  }

  try {
    await runFfmpeg([
      ...FFMPEG_INPUT_GUARD,
      '-i',
      inputPath,
      '-i',
      palettePath,
      '-filter_complex',
      `[0:v]scale=${width}:-1:flags=lanczos[v];[v][1:v]paletteuse=dither=${dither}`,
      '-loop',
      '0',
      '-gifflags',
      '+transdiff',
      '-y',
      outputPath,
    ]);
  } catch (err) {
    logger.error('FFmpeg pass 2 (conversion) failed for image:', err.stderr);
    await fs.unlink(palettePath).catch(() => {});
    throw new Error(`GIF conversion failed: ${err.message}`, { cause: err });
  }

  try {
    await fs.unlink(palettePath);
  } catch (error) {
    logger.warn('Failed to delete palette file:', error.message);
  }
  logger.debug(`Image to GIF conversion completed: ${outputPath}`);
}
