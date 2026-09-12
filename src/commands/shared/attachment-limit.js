export function getDiscordAttachmentLimit(interaction, fallback) {
  const limit = Number(interaction?.attachmentSizeLimit);
  return Number.isFinite(limit) && limit > 0 ? limit : fallback;
}

export function fitsDiscordAttachment(size, limit) {
  return size <= limit;
}
