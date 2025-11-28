import ffmpeg from 'fluent-ffmpeg';

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
