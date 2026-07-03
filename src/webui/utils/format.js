/**
 * Shared display formatters for webui pages
 */

export function formatTimestamp(timestamp) {
  if (!timestamp) return 'N/A';
  return new Date(timestamp).toLocaleString();
}

export function formatRelativeTime(timestamp) {
  if (!timestamp) return 'N/A';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatTimestamp(timestamp);
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function formatDuration(ms) {
  if (!ms || ms === 0) return 'N/A';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

/**
 * Convert a time-range key ('1h', '6h', '24h', '7d', '30d') to a start timestamp,
 * or null for unknown/empty keys.
 */
export function timeRangeToStartTime(timeRange, now = Date.now()) {
  const hour = 60 * 60 * 1000;
  const ranges = {
    '1h': hour,
    '6h': 6 * hour,
    '24h': 24 * hour,
    '7d': 7 * 24 * hour,
    '30d': 30 * 24 * hour,
  };
  return ranges[timeRange] ? now - ranges[timeRange] : null;
}
