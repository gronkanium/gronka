import { botConfig } from '../../utils/config.js';
import { ValidationError } from '../../utils/errors.js';

const { maxVideoSize: MAX_VIDEO_SIZE, maxImageSize: MAX_GIF_SIZE } = botConfig;

const FTYP = Buffer.from('ftyp');
const VIDEO_SIGNATURES = [Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('RIFF')];
const GIF_SIGNATURES = [Buffer.from('GIF87a'), Buffer.from('GIF89a')];

function checkVideo({ head, size }) {
  if (!head || head.length < 12) throw new ValidationError('invalid or empty file');
  if (size > MAX_VIDEO_SIZE) {
    throw new ValidationError(
      `file too large. maximum size for video files is ${MAX_VIDEO_SIZE / 1024 / 1024}mb.`
    );
  }
  const isMp4OrMov = head.subarray(4, 8).equals(FTYP) || head.subarray(0, 4).equals(FTYP);
  const hasSignature = VIDEO_SIGNATURES.some(sig => head.subarray(0, sig.length).equals(sig));
  if (!isMp4OrMov && !hasSignature) {
    throw new ValidationError(
      'file is not a valid video format. supported formats: mp4, webm, avi, mov.'
    );
  }
}

function checkGif({ head, size }) {
  if (!head || head.length < 6) throw new ValidationError('invalid or empty file');
  if (size > MAX_GIF_SIZE) {
    throw new ValidationError(
      `file too large. maximum size for gif files is ${MAX_GIF_SIZE / 1024 / 1024}mb.`
    );
  }
  if (!GIF_SIGNATURES.some(sig => head.subarray(0, 6).equals(sig))) {
    throw new ValidationError('file is not a valid gif format. please provide a gif file.');
  }
}

// Checks a downloaded media file's magic bytes and size before a tool opens it. 'image' is
// validated upstream by extension.
export function validateMediaFile(file, kind = 'gif') {
  if (kind === 'video') checkVideo(file);
  else if (kind === 'gif') checkGif(file);
  return file;
}
