import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../logger.js';
import {
  validateNumericParameter,
  checkFFmpegInstalled,
  FFMPEG_INPUT_GUARD,
  GIF_PALETTEGEN,
  GIF_PALETTEUSE,
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
 * @returns {Promise<void>}
 */
export async function convertImageToGif(inputPath, outputPath, options = {}) {
  return convertImageToGifImpl(inputPath, outputPath, options);
}

async function convertImageToGifImpl(inputPath, outputPath, options = {}) {
  // Validate and sanitize numeric parameters
  const width = validateNumericParameter(options.width ?? 720, 'width', 1, 4096);

  logger.debug(`Starting image to GIF conversion: ${inputPath} -> ${outputPath} (width: ${width})`);

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

  const tempDir = path.dirname(inputPath);
  const palettePath = path.join(tempDir, path.basename(outputPath) + '.palette.png');

  try {
    await runFfmpeg([
      ...FFMPEG_INPUT_GUARD,
      '-i',
      inputPath,
      '-vf',
      `scale=${width}:-1:flags=lanczos,${GIF_PALETTEGEN}`,
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
      `[0:v]scale=${width}:-1:flags=lanczos[v];[v][1:v]${GIF_PALETTEUSE}`,
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
