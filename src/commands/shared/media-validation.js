import { ValidationError } from '../../utils/errors.js';

const FTYP = Buffer.from('ftyp');
const VIDEO_SIGNATURES = [Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('RIFF')];
const GIF_SIGNATURES = [Buffer.from('GIF87a'), Buffer.from('GIF89a')];

function checkVideo({ head }) {
  if (!head || head.length < 12) throw new ValidationError('invalid or empty file');
  const isMp4OrMov = head.subarray(4, 8).equals(FTYP) || head.subarray(0, 4).equals(FTYP);
  const hasSignature = VIDEO_SIGNATURES.some(sig => head.subarray(0, sig.length).equals(sig));
  if (!isMp4OrMov && !hasSignature) {
    throw new ValidationError(
      'file is not a valid video format. supported formats: mp4, webm, avi, mov.'
    );
  }
}

function checkGif({ head }) {
  if (!head || head.length < 6) throw new ValidationError('invalid or empty file');
  if (!GIF_SIGNATURES.some(sig => head.subarray(0, 6).equals(sig))) {
    throw new ValidationError('file is not a valid gif format. please provide a gif file.');
  }
}

// Checks a downloaded media file's magic bytes before a tool opens it. 'image' is
// validated upstream by extension.
export function validateMediaFile(file, kind = 'gif') {
  if (kind === 'video') checkVideo(file);
  else if (kind === 'gif') checkGif(file);
  return file;
}
