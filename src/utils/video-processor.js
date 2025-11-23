import ffmpeg from 'fluent-ffmpeg';
import { promisify } from 'util';
import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from './logger.js';

const execAsync = promisify(exec);
const logger = createLogger('video-processor');

/**
 * Validate numeric parameter to prevent command injection
 * @param {*} value - Value to validate
 * @param {string} name - Parameter name for error messages
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @param {boolean} allowNull - Whether null is allowed
 * @returns {number|null} Validated number or null
 * @throws {Error} If validation fails
 */
function validateNumericParameter(value, name, min = 0, max = Infinity, allowNull = false) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new Error(`${name} cannot be null or undefined`);
  }

  const num = Number(value);

  if (isNaN(num) || !isFinite(num)) {
    throw new Error(`${name} must be a valid number`);
  }

  if (num < min) {
    throw new Error(`${name} must be at least ${min}`);
  }

  if (num > max) {
    throw new Error(`${name} must be at most ${max}`);
  }

  return num;
}

/**
 * Check if FFmpeg is installed and available
 * @returns {Promise<boolean>} True if FFmpeg is available
 */
async function checkFFmpegInstalled() {
  try {
    await execAsync('ffmpeg -version');
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert video file to GIF using FFmpeg with two-pass palette generation
 * @param {string} inputPath - Path to input video file
 * @param {string} outputPath - Path to output GIF file
 * @param {Object} options - Conversion options
 * @param {number} options.width - Output width in pixels (default: 480)
 * @param {number} options.fps - Frames per second (default: 30)
 * @param {number|null} options.startTime - Trim start time in seconds (optional)
 * @param {number|null} options.duration - Trim duration in seconds (optional)
 * @param {string} options.quality - Quality preset: 'low', 'medium', 'high' (default: 'medium')
 * @returns {Promise<void>}
 */
export async function convertToGif(inputPath, outputPath, options = {}) {
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
  const quality = options.quality || 'medium';

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

  // Quality presets for dithering
  const qualityPresets = {
    low: 'bayer:bayer_scale=5',
    medium: 'bayer:bayer_scale=3',
    high: 'bayer:bayer_scale=1',
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
      .inputOptions(
        [
          startTime !== null ? `-ss ${startTime}` : null,
          duration !== null ? `-t ${duration}` : null,
        ].filter(Boolean)
      )
      .videoFilters([`fps=${fps}`, `scale=${width}:-1:flags=lanczos`, 'palettegen=max_colors=256'])
      .outputOptions(['-y']) // Overwrite output file
      .output(palettePath)
      .on('error', (err, stdout, stderr) => {
        logger.error('FFmpeg pass 1 (palette) failed:', stderr);
        reject(new Error(`Palette generation failed: ${err.message}`));
      })
      .on('end', () => {
        // Pass 2: Apply palette and create GIF
        // Use complex filter because we have two inputs (video + palette)
        ffmpeg(inputPath)
          .inputOptions(
            [
              startTime !== null ? `-ss ${startTime}` : null,
              duration !== null ? `-t ${duration}` : null,
            ].filter(Boolean)
          )
          .input(palettePath)
          .complexFilter([
            `[0:v]fps=${fps},scale=${width}:-1:flags=lanczos[v]`,
            `[v][1:v]paletteuse=dither=${dither}`,
          ])
          .outputOptions([
            '-loop',
            '0', // Infinite loop
            '-y', // Overwrite output file
          ])
          .output(outputPath)
          .on('error', async (err, stdout, stderr) => {
            logger.error('FFmpeg pass 2 (conversion) failed:', stderr);
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
            logger.debug(`Video to GIF conversion completed: ${outputPath}`);
            resolve();
          })
          .run();
      })
      .run();
  });
}

/**
 * Get video metadata
 * @param {string} inputPath - Path to input video file
 * @returns {Promise<Object>} Video metadata
 */
export async function getVideoMetadata(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        reject(new Error(`Failed to read video metadata: ${err.message}`));
        return;
      }
      resolve(metadata);
    });
  });
}

/**
 * Convert image file to GIF using FFmpeg
 * @param {string} inputPath - Path to input image file
 * @param {string} outputPath - Path to output GIF file
 * @param {Object} options - Conversion options
 * @param {number} options.width - Output width in pixels (default: 720)
 * @param {string} options.quality - Quality preset: 'low', 'medium', 'high' (default: 'medium')
 * @returns {Promise<void>}
 */
export async function convertImageToGif(inputPath, outputPath, options = {}) {
  // Validate and sanitize numeric parameters
  const width = validateNumericParameter(options.width ?? 720, 'width', 1, 4096);
  const quality = options.quality || 'medium';

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

  // Quality presets for dithering
  const qualityPresets = {
    low: 'bayer:bayer_scale=5',
    medium: 'bayer:bayer_scale=3',
    high: 'bayer:bayer_scale=1',
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
      .videoFilters([`scale=${width}:-1:flags=lanczos`, 'palettegen=max_colors=256'])
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
