import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../logger.js';
import { validateNumericParameter, checkFFmpegInstalled } from './utils.js';

const logger = createLogger('convert-image-to-gif');

/**
 * Convert image file to GIF using FFmpeg
 * @param {string} inputPath - Path to input image file
 * @param {string} outputPath - Path to output GIF file
 * @param {Object} options - Conversion options
 * @param {number} options.width - Output width in pixels (default: 720)
 * @param {string} options.quality - Quality preset: 'low', 'medium', 'high' (optional, uses botConfig.gifQuality default: 'medium')
 * @returns {Promise<void>}
 */
export async function convertImageToGif(inputPath, outputPath, options = {}) {
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

  const dither = qualityPresets[quality] || qualityPresets.medium;

  return new Promise((resolve, reject) => {
    // Create temporary palette file in temp directory (same directory as input)
    const tempDir = path.dirname(inputPath);
    const paletteFilename = path.basename(outputPath) + '.palette.png';
    const palettePath = path.join(tempDir, paletteFilename);

    // Two-pass conversion for better quality
    // Pass 1: Generate palette
    ffmpeg(inputPath)
      .videoFilters([
        `scale=${width}:-1:flags=lanczos`,
        'palettegen=max_colors=256:reserve_transparent=0',
      ])
      .outputOptions([
        '-y', // Overwrite output file
        '-update',
        '1', // Update existing file (for single image output)
        '-frames:v',
        '1', // Write only 1 frame
      ])
      .output(palettePath)
      .on('error', (err, stdout, stderr) => {
        logger.error('FFmpeg pass 1 (palette) failed for image:', stderr);
        reject(new Error(`Palette generation failed: ${err.message}`));
      })
      .on('end', () => {
        // Pass 2: Apply palette and create GIF
        // Use complex filter because we have two inputs (image + palette)
        ffmpeg(inputPath)
          .input(palettePath)
          .complexFilter([
            `[0:v]scale=${width}:-1:flags=lanczos[v]`,
            `[v][1:v]paletteuse=dither=${dither}`,
          ])
          .outputOptions([
            '-loop',
            '0', // Infinite loop (for static GIF, this just means it can loop)
            '-gifflags',
            '+transdiff', // Better compression for GIFs
            '-y', // Overwrite output file
          ])
          .output(outputPath)
          .on('error', async (err, stdout, stderr) => {
            logger.error('FFmpeg pass 2 (conversion) failed for image:', stderr);
            // Clean up palette file on error
            try {
              await fs.unlink(palettePath);
            } catch {
              // Ignore cleanup errors
            }
            reject(new Error(`GIF conversion failed: ${err.message}`));
          })
          .on('end', async () => {
            // Clean up palette file
            try {
              await fs.unlink(palettePath);
            } catch (error) {
              logger.warn('Failed to delete palette file:', error.message);
            }
            logger.debug(`Image to GIF conversion completed: ${outputPath}`);
            resolve();
          })
          .run();
      })
      .run();
  });
}
