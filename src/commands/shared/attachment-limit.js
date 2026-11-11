import { PermissionFlagsBits } from 'discord.js';

// Only interactions carry attachment_size_limit; else Discord's answer to the upload decides. No Attach Files: links.
export function getDiscordAttachmentLimit(interaction, fallback = Infinity) {
  if (interaction?.appPermissions?.has?.(PermissionFlagsBits.AttachFiles) === false) return 0;
  const limit = interaction?.attachmentSizeLimit;
  return Number.isFinite(limit) && limit >= 0 ? limit : fallback;
}

// Cloudflare 413s a whole multipart request near the limit; the file plus its form framing must fit.
export const MULTIPART_HEADROOM = 64 * 1024;

export function fitsDiscordAttachment(size, limit) {
  return size + MULTIPART_HEADROOM <= limit;
}
