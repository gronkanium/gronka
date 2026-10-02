import { PermissionFlagsBits } from 'discord.js';

// Without Attach Files a reply carrying a file fails with Missing Permissions, so everything goes as a link.
export function getDiscordAttachmentLimit(interaction, fallback) {
  if (interaction?.appPermissions?.has?.(PermissionFlagsBits.AttachFiles) === false) return 0;
  const limit = interaction?.attachmentSizeLimit;
  return Number.isFinite(limit) && limit >= 0 ? limit : fallback;
}

export function fitsDiscordAttachment(size, limit) {
  return size <= limit;
}
