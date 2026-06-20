import fs from 'fs/promises';
import { botConfig } from '../../utils/config.js';
import { ValidationError } from '../../utils/errors.js';

// Shared media buffer validation used by the download / convert / optimize commands.
// Previously duplicated as validateVideoBuffer (convert.js), validateGifBuffer (optimize.js),
// and two copies of writeValidatedFileBuffer.

const { maxVideoSize: MAX_VIDEO_SIZE } = botConfig;
const MAX_GIF_SIZE = 50 * 1024 * 1024; // 50MB limit (matches legacy optimize.js)

// ftyp box type signature (used by MP4 and MOV)
const FTYP_BOX_TYPE = Buffer.from([0x66, 0x74, 0x79, 0x70]); // "ftyp" in ASCII

// Fixed signatures for formats that don't use ftyp boxes
const FIXED_VIDEO_SIGNATURES = {
  webm: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), // WebM
  avi: Buffer.from('RIFF'),
};

// GIF file signature constants
const ALLOWED_GIF_SIGNATURES = [
  Buffer.from('GIF87a'), // GIF87a signature
  Buffer.from('GIF89a'), // GIF89a signature
];

/**
 * Validate a video buffer (magic bytes, size limit, basic structure).
 * @param {Buffer} buffer - File buffer to validate
 * @throws {ValidationError} If buffer is invalid
 * @returns {boolean} true when valid
 */
export function validateVideoBuffer(buffer) {
  if (!buffer || buffer.length < 12) {
    throw new ValidationError('invalid or empty file buffer');
  }

  if (buffer.length > MAX_VIDEO_SIZE) {
    throw new ValidationError(
      `file too large. maximum size for video files is ${MAX_VIDEO_SIZE / 1024 / 1024}mb.`
    );
  }

  // MP4/MOV files carry an "ftyp" box (sometimes at offset 0, usually at offset 4).
  const isMp4OrMov =
    (buffer.length >= 8 && buffer.slice(4, 8).equals(FTYP_BOX_TYPE)) ||
    (buffer.length >= 4 && buffer.slice(0, 4).equals(FTYP_BOX_TYPE));

  const header = buffer.slice(0, 12);
  const hasFixedSignature = Object.entries(FIXED_VIDEO_SIGNATURES).some(([_format, signature]) => {
    return header.slice(0, signature.length).equals(signature);
  });

  if (!isMp4OrMov && !hasFixedSignature) {
    throw new ValidationError(
      'file is not a valid video format. supported formats: mp4, webm, avi, mov.'
    );
  }

  return true;
}

/**
 * Validate a GIF buffer (magic bytes, size limit).
 * @param {Buffer} buffer - File buffer to validate
 * @throws {ValidationError} If buffer is invalid
 * @returns {boolean} true when valid
 */
export function validateGifBuffer(buffer) {
  if (!buffer || buffer.length < 6) {
    throw new ValidationError('invalid or empty file buffer');
  }

  if (buffer.length > MAX_GIF_SIZE) {
    throw new ValidationError(
      `file too large. maximum size for gif files is ${MAX_GIF_SIZE / 1024 / 1024}mb.`
    );
  }

  const signature = buffer.slice(0, 6);
  const isValidGif = ALLOWED_GIF_SIGNATURES.some(validSig => signature.equals(validSig));

  if (!isValidGif) {
    throw new ValidationError('file is not a valid gif format. please provide a gif file.');
  }

  return true;
}

/**
 * Write a validated file buffer to the filesystem. Validation is co-located with the write so
 * static analysis (CodeQL) can track that network data is validated before it reaches disk.
 * @param {string} filePath - Destination path
 * @param {Buffer} buffer - File buffer to write
 * @param {'video'|'gif'|'image'} kind - What the buffer is expected to be. 'image' is validated
 *   upstream via extension checks, so only the write happens here.
 * @throws {ValidationError} If buffer validation fails
 * @returns {Promise<void>}
 */
export async function writeValidatedFileBuffer(filePath, buffer, kind = 'gif') {
  if (kind === 'video' || kind === 'gif') {
    try {
      if (kind === 'video') {
        validateVideoBuffer(buffer);
      } else {
        validateGifBuffer(buffer);
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ValidationError('file validation failed: ' + error.message);
    }
  }
  // Only validated network data is written to the filesystem. If validation fails above, an error
  // is thrown and execution never reaches this write.
  await fs.writeFile(filePath, buffer);
}
