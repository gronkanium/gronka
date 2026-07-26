import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../logger.js';
import { validateNumericParameter, checkFFmpegInstalled } from './utils.js';
import { mediaSlots } from '../concurrency.js';

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
  return mediaSlots.run(() => convertToGifImpl(inputPath, outputPath, options));
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

  return new Promise((resolve, reject) => {
    // Create temporary palette file in temp directory (same directory as input)
    const tempDir = path.dirname(inputPath);
    const paletteFilename = path.basename(outputPath) + '.palette.png';
    const palettePath = path.join(tempDir, paletteFilename);

    // A real encode finishes in at most a couple of minutes; a longer run means a
    // stalled ffmpeg (an input it opens but never drains). Bound the whole two-pass
    // run so it fails cleanly instead of hanging until the stuck-operation reaper.
    // Input-agnostic: the deadline applies to every conversion.
    const encodeTimeoutMs = 300000; // 5 minutes
    let activeCommand = null;
    let settled = false;

    const cleanupPalette = async () => {
      try {
        await fs.unlink(palettePath);
      } catch {
        // Ignore cleanup errors (palette may not exist yet)
      }
    };

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.error(`FFmpeg GIF conversion timed out after ${encodeTimeoutMs / 1000}s, killing`);
      if (activeCommand) {
        try {
          activeCommand.kill('SIGKILL');
        } catch {
          // Ignore kill errors
        }
      }
      cleanupPalette().finally(() =>
        reject(new Error(`GIF conversion timed out after ${encodeTimeoutMs / 1000}s`))
      );
    }, encodeTimeoutMs);

    // Two-pass conversion for better quality
    // Pass 1: Generate palette
    activeCommand = ffmpeg(inputPath)
      .inputOptions(
        [
          startTime !== null ? `-ss ${startTime}` : null,
          duration !== null ? `-t ${duration}` : null,
        ].filter(Boolean)
      )
      .videoFilters([`fps=${fps}`, `scale=${width}:-1:flags=lanczos`, paletteGen])
      .outputOptions(['-y']) // Overwrite output file
      .output(palettePath)
      .on('error', (err, stdout, stderr) => {
        if (settled) return; // already timed out
        logger.error('FFmpeg pass 1 (palette) failed:', stderr);
        settle(reject, new Error(`Palette generation failed: ${err.message}`));
      })
      .on('end', () => {
        if (settled) return; // timed out during pass 1
        // Pass 2: Apply palette and create GIF
        // Use complex filter because we have two inputs (video + palette)
        activeCommand = ffmpeg(inputPath)
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
            if (settled) return; // already timed out
            logger.error('FFmpeg pass 2 (conversion) failed:', stderr);
            await cleanupPalette();
            settle(reject, new Error(`GIF conversion failed: ${err.message}`));
          })
          .on('end', async () => {
            if (settled) return; // timed out during pass 2
            await cleanupPalette();
            logger.debug(`Video to GIF conversion completed: ${outputPath}`);
            settle(resolve);
          })
          .run();
      })
      .run();
  });
}
