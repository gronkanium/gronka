// Barrel export file - re-exports all functions from submodules for backward compatibility
// This file maintains the same API as before the refactoring

// Video to GIF conversion
export { convertToGif } from './video-processor/convert-to-gif.js';

// Image to GIF conversion
export { convertImageToGif } from './video-processor/convert-image-to-gif.js';

// Animated WebP to GIF conversion (ImageMagick; ffmpeg can't demux animated webp)
export { convertAnimatedWebpToGif } from './video-processor/convert-animated-webp-to-gif.js';

// Animated-WebP header sniff (routing)
export { isAnimatedWebp } from './video-processor/utils.js';

// Video trimming
export { trimVideo } from './video-processor/trim-video.js';

// GIF trimming
export { trimGif } from './video-processor/trim-gif.js';

// Video metadata
export { getVideoMetadata } from './video-processor/metadata.js';
