import { test } from 'bun:test';
import assert from 'node:assert';
import {
  validateVideoAttachment,
  validateImageAttachment,
  batchAttachmentsForDelivery,
  DISCORD_MAX_ATTACHMENTS,
  ALLOWED_VIDEO_TYPES,
  ALLOWED_IMAGE_TYPES,
  MAX_VIDEO_SIZE,
} from '../../src/utils/attachment-helpers.js';

// Mock attachment objects
function createAttachment(contentType, size) {
  return {
    contentType,
    size,
  };
}

test('validateVideoAttachment - accepts valid video formats', () => {
  for (const contentType of ALLOWED_VIDEO_TYPES) {
    const attachment = createAttachment(contentType, 1024 * 1024); // 1MB
    const result = validateVideoAttachment(attachment);
    assert.strictEqual(result.valid, true);
  }
});

test('validateVideoAttachment - rejects unsupported content types', () => {
  const unsupportedTypes = ['image/png', 'image/jpeg', 'text/plain', 'application/json'];
  for (const contentType of unsupportedTypes) {
    const attachment = createAttachment(contentType, 1024 * 1024);
    const result = validateVideoAttachment(attachment);
    assert.strictEqual(result.valid, false);
    assert(result.error.includes('unsupported video format'));
  }
});

test('validateVideoAttachment - rejects attachments without content type', () => {
  const attachment = createAttachment(null, 1024 * 1024);
  const result = validateVideoAttachment(attachment);
  assert.strictEqual(result.valid, false);
  assert(result.error.includes('unsupported video format'));
});

test('validateVideoAttachment - rejects files exceeding size limit for non-admins', () => {
  const oversizedFile = MAX_VIDEO_SIZE + 1;
  const attachment = createAttachment('video/mp4', oversizedFile);
  const result = validateVideoAttachment(attachment, false);

  assert.strictEqual(result.valid, false);
  assert(result.error.includes('too large'));
  const expectedSizeMb = MAX_VIDEO_SIZE / (1024 * 1024);
  assert(result.error.includes(`${expectedSizeMb}mb`));
});

test('validateVideoAttachment - accepts files at size limit', () => {
  const attachment = createAttachment('video/mp4', MAX_VIDEO_SIZE);
  const result = validateVideoAttachment(attachment, false);

  assert.strictEqual(result.valid, true);
});

test('validateVideoAttachment - allows oversized files for admins', () => {
  const oversizedFile = MAX_VIDEO_SIZE + 1024 * 1024 * 100; // 100MB over limit
  const attachment = createAttachment('video/mp4', oversizedFile);
  const result = validateVideoAttachment(attachment, true);

  assert.strictEqual(result.valid, true);
});

test('validateVideoAttachment - accepts small files', () => {
  const attachment = createAttachment('video/mp4', 1024); // 1KB
  const result = validateVideoAttachment(attachment, false);

  assert.strictEqual(result.valid, true);
});

test('validateImageAttachment - accepts valid image formats', () => {
  for (const contentType of ALLOWED_IMAGE_TYPES) {
    const attachment = createAttachment(contentType, 1024 * 1024); // 1MB
    const result = validateImageAttachment(attachment);
    assert.strictEqual(result.valid, true);
  }
});

test('validateImageAttachment - rejects unsupported content types', () => {
  const unsupportedTypes = ['video/mp4', 'video/webm', 'text/plain', 'application/json'];
  for (const contentType of unsupportedTypes) {
    const attachment = createAttachment(contentType, 1024 * 1024);
    const result = validateImageAttachment(attachment);
    assert.strictEqual(result.valid, false);
    assert(result.error.includes('unsupported image format'));
  }
});

test('validateImageAttachment - rejects attachments without content type', () => {
  const attachment = createAttachment(null, 1024 * 1024);
  const result = validateImageAttachment(attachment);
  assert.strictEqual(result.valid, false);
  assert(result.error.includes('unsupported image format'));
});

test('validateImageAttachment - rejects files exceeding size limit for non-admins', () => {
  const maxSize = 50 * 1024 * 1024; // 50MB
  const oversizedFile = maxSize + 1;
  const attachment = createAttachment('image/png', oversizedFile);
  const result = validateImageAttachment(attachment, false);

  assert.strictEqual(result.valid, false);
  assert(result.error.includes('too large'));
  assert(result.error.includes('50mb'));
});

test('validateImageAttachment - accepts files at size limit', () => {
  const maxSize = 50 * 1024 * 1024; // 50MB
  const attachment = createAttachment('image/png', maxSize);
  const result = validateImageAttachment(attachment, false);

  assert.strictEqual(result.valid, true);
});

test('validateImageAttachment - allows oversized files for admins', () => {
  const maxSize = 50 * 1024 * 1024; // 50MB
  const oversizedFile = maxSize + 1024 * 1024 * 10; // 10MB over limit
  const attachment = createAttachment('image/png', oversizedFile);
  const result = validateImageAttachment(attachment, true);

  assert.strictEqual(result.valid, true);
});

test('validateImageAttachment - accepts small files', () => {
  const attachment = createAttachment('image/png', 1024); // 1KB
  const result = validateImageAttachment(attachment, false);

  assert.strictEqual(result.valid, true);
});

test('validateVideoAttachment - handles zero-size files', () => {
  const attachment = createAttachment('video/mp4', 0);
  const result = validateVideoAttachment(attachment, false);

  assert.strictEqual(result.valid, true);
});

test('validateImageAttachment - handles zero-size files', () => {
  const attachment = createAttachment('image/png', 0);
  const result = validateImageAttachment(attachment, false);

  assert.strictEqual(result.valid, true);
});

// Regression: a carousel over Discord's per-message cap was sent as one message, which Discord
// rejected outright (50035) — the user received nothing and the operation was still recorded
// as a success.
test('batchAttachmentsForDelivery - splits past the Discord cap instead of one oversized send', () => {
  const attachments = Array.from({ length: 23 }, (_, i) => `file-${i}`);
  const batches = batchAttachmentsForDelivery(attachments);

  assert.strictEqual(DISCORD_MAX_ATTACHMENTS, 10);
  assert.deepStrictEqual(
    batches.map(batch => batch.length),
    [10, 10, 3]
  );
  assert.ok(
    batches.every(batch => batch.length <= DISCORD_MAX_ATTACHMENTS),
    'no batch may exceed the Discord attachment cap'
  );
  // Order and completeness must survive the split, or attachment URLs get recorded against
  // the wrong source file.
  assert.deepStrictEqual(batches.flat(), attachments);
});

test('batchAttachmentsForDelivery - leaves an already-legal set as a single batch', () => {
  const attachments = Array.from({ length: 10 }, (_, i) => `file-${i}`);

  assert.deepStrictEqual(batchAttachmentsForDelivery(attachments), [attachments]);
  assert.deepStrictEqual(batchAttachmentsForDelivery([]), []);
});
