import { test, describe } from 'bun:test';
import assert from 'node:assert';
import {
  fitsDiscordAttachment,
  getDiscordAttachmentLimit,
} from '../../../src/commands/shared/attachment-limit.js';

describe('Discord attachment limits', () => {
  test('uses the interaction limit when present', () => {
    assert.strictEqual(getDiscordAttachmentLimit({ attachmentSizeLimit: 20 }, 8), 20);
  });

  test('falls back when the interaction limit is invalid', () => {
    assert.strictEqual(getDiscordAttachmentLimit({ attachmentSizeLimit: 0 }, 8), 8);
    assert.strictEqual(getDiscordAttachmentLimit({}, 8), 8);
  });

  test('accepts a file exactly at the limit', () => {
    assert.strictEqual(fitsDiscordAttachment(20, 20), true);
    assert.strictEqual(fitsDiscordAttachment(20.1, 20), false);
  });
});
