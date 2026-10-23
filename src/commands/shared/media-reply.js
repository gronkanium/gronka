import { PermissionFlagsBits } from 'discord.js';
import { formatFileSize } from '../../utils/storage.js';
import { r2ExpiryText } from '../../utils/r2-storage.js';
import { r2Config } from '../../utils/config.js';

export const canEmbedMedia = interaction =>
  interaction.embedLinksAllowed ??
  interaction.appPermissions?.has(PermissionFlagsBits.EmbedLinks) ??
  true;

export function formatSizeChange(before, after) {
  const sizes = `${formatFileSize(before)} → ${formatFileSize(after)}`;
  if (before === after) return `${sizes} (unchanged)`;
  const percent = before > 0 ? `${((Math.abs(after - before) / before) * 100).toFixed(1)}% ` : '';
  return `${sizes} (${percent}${after < before ? 'smaller' : 'larger'})`;
}

export function mediaReplyPayload(interaction, items) {
  const files = items.flatMap(item => (item.attachment ? [item.attachment] : []));
  if (!canEmbedMedia(interaction)) {
    const content = items
      .map(item =>
        [item.url, item.description, r2ExpiryText(item.url, r2Config, item.ttlHours)]
          .filter(Boolean)
          .join('\n')
      )
      .filter(Boolean)
      .join('\n');
    return { content, embeds: [], ...(files.length ? { files } : {}) };
  }
  const embeds = items.map(item => {
    const name = (item.name || 'media').slice(0, 200);
    const description =
      item.description ?? (Number.isFinite(item.size) ? formatFileSize(item.size) : null);
    const footer = r2ExpiryText(item.url, r2Config, item.ttlHours);
    const image = ['image', 'gif'].includes(item.type)
      ? { url: item.url || `attachment://${item.attachment.name}` }
      : null;
    return {
      title: name,
      ...(item.url ? { url: item.url } : {}),
      ...(description ? { description } : {}),
      ...(image ? { image } : {}),
      ...(footer ? { footer: { text: footer } } : {}),
    };
  });
  return { content: '', embeds, ...(files.length ? { files } : {}) };
}

export function mediaReplyBatches(interaction, items) {
  const batches = [];
  let batch = [];
  for (const item of items) {
    const next = [...batch, item];
    const payload = mediaReplyPayload(interaction, next);
    if (batch.length && (next.length > 10 || payload.content.length > 2000)) {
      batches.push(batch);
      batch = [];
    }
    batch.push(item);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
