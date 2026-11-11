import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import {
  MULTIPART_HEADROOM,
  fitsDiscordAttachment,
  getDiscordAttachmentLimit,
} from '../../../src/commands/shared/attachment-limit.js';

describe('Discord attachment limits', () => {
  test('uses the interaction limit when present', () => {
    assert.strictEqual(getDiscordAttachmentLimit({ attachmentSizeLimit: 20 }, 8), 20);
  });

  test('a plain message reply has no limit from Discord, so no number of ours stands in for it', () => {
    assert.strictEqual(getDiscordAttachmentLimit({ attachmentSizeLimit: null }), Infinity);
    assert.strictEqual(getDiscordAttachmentLimit({}), Infinity);
    assert.strictEqual(
      fitsDiscordAttachment(500 * 1024 * 1024, getDiscordAttachmentLimit({})),
      true
    );
    assert.strictEqual(getDiscordAttachmentLimit({}, null), null);
  });

  test('is zero without Attach Files, so every file goes out as a link', () => {
    const perms = attach => new PermissionsBitField(attach ? PermissionFlagsBits.AttachFiles : 0n);
    const noAttach = { appPermissions: perms(false), attachmentSizeLimit: 20 };
    assert.strictEqual(getDiscordAttachmentLimit(noAttach, 8), 0);
    assert.strictEqual(fitsDiscordAttachment(1, getDiscordAttachmentLimit(noAttach, 8)), false);
    assert.strictEqual(
      getDiscordAttachmentLimit({ appPermissions: perms(true), attachmentSizeLimit: 20 }, 8),
      20
    );
    assert.strictEqual(getDiscordAttachmentLimit({ attachmentSizeLimit: 0 }, 8), 0);
  });

  test('leaves headroom for the multipart framing around the file', () => {
    const limit = 10 * 1024 * 1024;
    assert.strictEqual(fitsDiscordAttachment(limit - MULTIPART_HEADROOM, limit), true);
    assert.strictEqual(fitsDiscordAttachment(limit - MULTIPART_HEADROOM + 1, limit), false);
    assert.strictEqual(fitsDiscordAttachment(limit, limit), false);
  });
});
