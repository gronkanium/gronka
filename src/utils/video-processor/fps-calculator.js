import { createLogger } from '../logger.js';

const logger = createLogger('fps-calculator');

/**
 * Calculate optimal FPS for GIF conversion based on video duration
 * Balances file size and smoothness by adjusting frame rate based on clip length
 *
 * @param {number} originalFps - Original video FPS
 * @param {number|null} duration - Video duration in seconds (or trimmed duration if applicable)
 * @param {number|null} userSpecifiedFps - FPS explicitly specified by user (if any)
 * @returns {number} Calculated optimal FPS
 */
export function calculateOptimalFps(originalFps, duration, userSpecifiedFps = null) {
  // If user explicitly specified FPS, respect that choice
  if (userSpecifiedFps !== null && userSpecifiedFps !== undefined) {
    logger.debug(
      `Using user-specified FPS: ${userSpecifiedFps} (original: ${originalFps}, duration: ${duration ?? 'unknown'}s)`
    );
    return userSpecifiedFps;
  }

  // If duration is not available, use a conservative default
  // This shouldn't happen in normal flow, but handle gracefully
  if (duration === null || duration === undefined || duration <= 0) {
    logger.debug(
      `Duration not available, using capped original FPS: ${Math.min(originalFps, 30)} (original: ${originalFps})`
    );
    return Math.min(originalFps, 30);
  }

  // Determine maximum FPS based on duration to balance quality and file size
  // Shorter clips can have higher FPS since total frame count stays reasonable
  let maxFpsForDuration;
  if (duration < 2) {
    // Very short clips (< 2s): Allow up to 40fps
    maxFpsForDuration = 40;
  } else if (duration < 3) {
    // Short clips (2-3s): Allow up to 30fps
    maxFpsForDuration = 30;
  } else if (duration < 5) {
    // Medium clips (3-5s): Allow up to 25fps
    maxFpsForDuration = 25;
  } else {
    // Longer clips (>= 5s): Cap at 20fps
    maxFpsForDuration = 20;
  }

  // Calculate target FPS to keep total frames reasonable (around 120 frames max)
  // This prevents extremely large files while maintaining smoothness
  const targetFramesMax = 120;
  const targetFpsFromDuration = targetFramesMax / duration;

  // Calculate optimal FPS:
  // - Don't exceed original FPS
  // - Don't exceed maxFpsForDuration for this duration
  // - Don't exceed targetFpsFromDuration (to limit total frames)
  // - Ensure minimum 15fps for smoothness (unless original is lower)
  const minFps = Math.min(15, originalFps); // Never go below 15 unless original is lower
  const calculatedFps = Math.min(originalFps, maxFpsForDuration, targetFpsFromDuration);
  const optimalFps = Math.max(minFps, calculatedFps);

  logger.debug(
    `FPS calculation: original=${originalFps}, duration=${duration.toFixed(2)}s, ` +
      `maxFpsForDuration=${maxFpsForDuration}, targetFpsFromDuration=${targetFpsFromDuration.toFixed(2)}, ` +
      `calculated=${calculatedFps.toFixed(2)}, optimal=${optimalFps.toFixed(2)}`
  );

  return optimalFps;
}
