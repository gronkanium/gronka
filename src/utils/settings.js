import { botConfig } from './config.js';
import { getSetting } from './database/settings-pg.js';
import { DEFAULT_TTL_TIERS } from './upload-tiers.js';

const MB = 1024 * 1024;

// Every webui setting, defined once; read it through readSetting, never a raw key + default.
export const SETTINGS = {
  url_only_mode: {
    type: 'boolean',
    default: 'false',
    label: 'Reply with links only',
    section: 'delivery',
    description: 'Reply with the direct media URL from cobalt instead of downloading/uploading',
  },
  twitter_delivery: {
    type: 'select',
    default: 'hybrid',
    options: ['hybrid', 'always_url', 'always_download'],
    label: 'X / Twitter delivery',
    section: 'delivery',
    description:
      'How /download serves X/Twitter videos: hybrid replies with the direct URL only when the video is too big for a Discord attachment (saves bandwidth and R2 storage), always_url skips downloading whenever a direct URL exists, always_download keeps the old rehost-everything behavior',
  },
  twitter_direct_url_fallback: {
    type: 'boolean',
    default: 'true',
    label: 'X / Twitter link fallback',
    section: 'delivery',
    description:
      'When an X/Twitter download fails (e.g. over the size or duration limit), reply with the direct media URL instead of an error',
  },
  max_video_size_mb: {
    type: 'number',
    default: String(Math.floor(botConfig.maxVideoSize / MB)),
    label: 'Max download size (MB)',
    section: 'delivery',
    description:
      'Maximum download size in MB, the primary limit. Oversized videos are rejected before download (yt-dlp aborts the pull). Applies immediately',
    min: 50,
    max: 2048,
  },
  max_video_duration: {
    type: 'number',
    default: '3600',
    label: 'Max video duration',
    section: 'delivery',
    description:
      'Backstop for video length in seconds. Size is the primary limit, oversized videos are rejected before download, so this only catches pathologically long ones',
    min: 30,
    max: 21600,
  },
  upload_ttl_tiers: {
    type: 'tiers',
    default: DEFAULT_TTL_TIERS,
    label: 'Upload lifetime tiers',
    section: 'storage',
    description:
      'How long an upload stays in R2. A file is kept for the first tier it fits under, so bigger files are deleted sooner',
  },
  r2_soft_limit_gb: {
    type: 'number',
    default: '9',
    label: 'R2 soft limit (GB)',
    section: 'storage',
    description:
      'Soft cap (GB) on total R2 storage. New uploads that would exceed it are rejected with a "storage full" message until files expire. 0 disables the guard',
    min: 0,
    max: 1000,
  },
  maintenance_mode: {
    type: 'boolean',
    default: 'false',
    label: 'Maintenance mode',
    section: 'access',
    description: 'Disable all commands with a maintenance message',
  },
  queue_paused: {
    type: 'boolean',
    default: 'false',
    label: 'Pause media queue',
    section: 'access',
    description:
      'Workers stop taking new media jobs; running ones finish (drain before a deploy). Queued requests wait, and are told they were interrupted after about 15 minutes. No effect with MEDIA_WORKERS=false',
  },
  disabled_services: {
    type: 'services',
    default: '[]',
    label: 'Turned-off sources',
    section: 'sources',
    description:
      'Download sources that are turned off. A /download from a turned-off source is refused with a message instead of downloading. Everything not listed here is on; the bot picks up changes within a minute',
  },
  source_routes: {
    type: 'routes',
    default: '{}',
    label: 'Source priority',
    section: 'sources',
    description:
      'Per site, the order the bot tries its download engines in and which are switched off. Sites not listed use the built-in order',
  },
  webui_issue_states: {
    type: 'issuestates',
    default: '{}',
    label: 'Issue states',
    section: 'issues',
    description: 'Muted and resolved issues on the webui Issues page',
  },
};

const parseJson = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

const PARSE = {
  boolean: text => text === 'true',
  number: (text, fallback) => (Number.isFinite(Number(text)) ? Number(text) : Number(fallback)),
  services: text => {
    const value = parseJson(text, []);
    return Array.isArray(value) ? value : [];
  },
  issuestates: text => parseJson(text, {}),
  routes: text => parseJson(text, {}),
};

// The stored value of a known setting, parsed to its type; the default when unset or unreadable.
export async function readSetting(key) {
  const meta = SETTINGS[key];
  if (!meta) throw new Error(`unknown setting: ${key}`);
  const text = (await getSetting(key, null)) ?? meta.default;
  const parse = PARSE[meta.type];
  return parse ? parse(text, meta.default) : text;
}
