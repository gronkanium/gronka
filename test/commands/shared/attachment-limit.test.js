import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import {
  fitsDiscordAttachment,
  getDiscordAttachmentLimit,
} from '../../../src/commands/shared/attachment-limit.js';

describe('Discord attachment limits', () => {
  test('uses the interaction limit when present', () => {
    assert.strictEqual(getDiscordAttachmentLimit({ attachmentSizeLimit: 20 }, 8), 20);
  });

  test('falls back when the interaction has no limit', () => {
    assert.strictEqual(getDiscordAttachmentLimit({ attachmentSizeLimit: null }, 8), 8);
    assert.strictEqual(getDiscordAttachmentLimit({}, 8), 8);
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

  test('accepts a file exactly at the limit', () => {
    assert.strictEqual(fitsDiscordAttachment(20, 20), true);
    assert.strictEqual(fitsDiscordAttachment(20.1, 20), false);
  });
});
