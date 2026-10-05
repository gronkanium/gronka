import { PermissionFlagsBits } from 'discord.js';

// Without Attach Files a reply carrying a file fails with Missing Permissions, so everything goes as a link.
export function getDiscordAttachmentLimit(interaction, fallback) {
  if (interaction?.appPermissions?.has?.(PermissionFlagsBits.AttachFiles) === false) return 0;
  const limit = interaction?.attachmentSizeLimit;
  return Number.isFinite(limit) && limit >= 0 ? limit : fallback;
}

// Cloudflare 413s a whole multipart request near the limit; the file plus its form framing must fit.
export const MULTIPART_HEADROOM = 64 * 1024;

export function fitsDiscordAttachment(size, limit) {
  return size + MULTIPART_HEADROOM <= limit;
}
