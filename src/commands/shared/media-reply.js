import { formatFileSize } from '../../utils/storage.js';
import { r2ExpiryText } from '../../utils/r2-storage.js';
import { r2Config } from '../../utils/config.js';

export function formatSizeChange(before, after) {
  const sizes = `${formatFileSize(before)} → ${formatFileSize(after)}`;
  if (before === after) return `${sizes} (unchanged)`;
  const percent = before > 0 ? `${((Math.abs(after - before) / before) * 100).toFixed(1)}% ` : '';
  return `${sizes} (${percent}${after < before ? 'smaller' : 'larger'})`;
}

// Bare files and plain links: Discord renders its own player or preview for both.
export function mediaReplyPayload(items) {
  const files = items.flatMap(item => (item.attachment ? [item.attachment] : []));
  const expiring = items.filter(item => r2ExpiryText(item.url, r2Config, item.ttlHours));
  const expiry = expiring.length
    ? r2ExpiryText(expiring[0].url, r2Config, Math.max(...expiring.map(item => item.ttlHours)))
    : null;
  const content = [
    ...items.map(item => item.url),
    ...items.map(item => item.description && `-# ${item.description}`),
    expiry,
  ]
    .filter(Boolean)
    .join('\n');
  return { content, ...(files.length ? { files } : {}) };
}

export function mediaReplyBatches(items) {
  const batches = [];
  let batch = [];
  for (const item of items) {
    const next = [...batch, item];
    if (batch.length && (next.length > 10 || mediaReplyPayload(next).content.length > 2000)) {
      batches.push(batch);
      batch = [];
    }
    batch.push(item);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
