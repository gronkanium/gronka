import { promisify } from 'util';
import { exec, spawn } from 'child_process';
import { jobSignal } from '../media-file.js';

const execAsync = promisify(exec);

// Untrusted input: without this, ffmpeg sniffs a text file as a concat/hls playlist and opens what it names.
export const FFMPEG_INPUT_GUARD = [
  '-protocol_whitelist',
  'file',
  '-format_whitelist',
  'mov,matroska,avi,flv,mpegts,gif,apng,image2,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,gif_pipe',
];

// Measured best size for quality on real clips; error diffusion only redraws each frame's changed rectangle.
export const GIF_PALETTEGEN = 'palettegen=max_colors=256:reserve_transparent=0:stats_mode=diff';
export const GIF_PALETTEUSE = 'paletteuse=dither=floyd_steinberg:diff_mode=rectangle';

// A real encode finishes in a couple of minutes; a longer run is a stalled ffmpeg.
export const FFMPEG_TIMEOUT_MS = 300000;

export function runFfmpeg(args, { signal = AbortSignal.timeout(FFMPEG_TIMEOUT_MS) } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, {
      signal: jobSignal(signal),
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', d => {
      stderr = (stderr + d).slice(-65536);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve();
      const lastLine = stderr.trim().split('\n').pop();
      reject(Object.assign(new Error(`ffmpeg exited with code ${code}: ${lastLine}`), { stderr }));
    });
  });
}

export function validateNumericParameter(value, name, min = 0, max = Infinity, allowNull = false) {
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

// Detect an animated WebP from its header bytes
export function isAnimatedWebp(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 21) return false;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return false;
  if (buffer.toString('ascii', 8, 12) !== 'WEBP') return false;
  if (buffer.toString('ascii', 12, 16) !== 'VP8X') return false;
  return (buffer[20] & 0x02) !== 0;
}

let ffmpegCheck;
export function checkFFmpegInstalled() {
  ffmpegCheck ??= execAsync('ffmpeg -version').then(
    () => true,
    () => false
  );
  return ffmpegCheck;
}

// A stream tagged matrix_coefficients=3 ("reserved", an encoder bug, but common in the wild)
// makes ffmpeg 7.x reject the frame at the filter graph's buffer source with "Invalid color
// space", killing the conversion before any filter runs. That placement is why `setparams`
// can't repair it: the only lever upstream of buffersrc is the bitstream, so we rewrite the tag
// to 2 (unspecified) on the way in. Only matrix_coefficients trips it, reserved primaries and
// transfer characteristics decode fine.
const METADATA_BSF_BY_CODEC = {
  h264: 'h264_metadata',
  hevc: 'hevc_metadata',
  av1: 'av1_metadata',
  vp9: 'vp9_metadata',
  mpeg2video: 'mpeg2_metadata',
};

export function colorspaceRepairInputOptions(metadata) {
  const video = metadata?.streams?.find(s => s.codec_type === 'video');
  if (video?.color_space !== 'reserved') return [];

  const bsf = METADATA_BSF_BY_CODEC[video.codec_name];
  // No metadata bsf for this codec: leave it alone rather than guess. It fails as it does today.
  return bsf ? ['-bsf:v', `${bsf}=matrix_coefficients=2`] : [];
}
