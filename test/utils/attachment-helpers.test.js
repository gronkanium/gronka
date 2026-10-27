import { test } from 'bun:test';
import assert from 'node:assert';
import {
  batchAttachmentsForDelivery,
  DISCORD_MAX_ATTACHMENTS,
  attachmentMediaKind,
} from '../../src/utils/attachment-helpers.js';

test('attachmentMediaKind - takes avif images by type or by name', () => {
  assert.strictEqual(attachmentMediaKind({ contentType: 'image/avif', name: 'a.avif' }), 'image');
  assert.strictEqual(attachmentMediaKind({ contentType: '', name: 'convert.avif' }), 'image');
});

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
