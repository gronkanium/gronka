import { YTDLP_SITES } from './ytdlp.js';
import { GALLERY_DL_SITES } from './gallery-dl.js';
import { getSetting } from './database.js';
import { hostOf } from './url-host.js';
import { canonicalizeMirrorUrl } from './cobalt.js';
import { SOURCES } from '../core/sources.js';

// The on/off switches for every source, so the webui can list them and each can be turned off.
// Routing lives in core/sources.js; a switch only says whether its hosts may be downloaded.
//
// `category` groups services in the settings UI. `id` is the stable key stored in the
// disabled_services setting (never rename an id or existing toggles reset).

// yt-dlp and gallery-dl switches come from their site tables; cobalt's sites are listed here.
const YTDLP_CATEGORY = {
  YouTube: 'video',
  Bilibili: 'video',
  Rumble: 'video',
  Coub: 'video',
  Imgur: 'video',
  Kick: 'video',
  Niconico: 'video',
  Medal: 'video',
  Tenor: 'social',
  Xiaohongshu: 'social',
  RedGifs: 'adult',
  XVideos: 'adult',
  Pornhub: 'adult',
  xHamster: 'adult',
  RedTube: 'adult',
  Rule34Video: 'adult',
};

const ytdlpServices = YTDLP_SITES.map(site => ({
  id: site.name.toLowerCase(),
  label: site.name,
  category: YTDLP_CATEGORY[site.name] || 'video',
  hosts: site.hosts,
}));

const galleryDlServices = [
  ...GALLERY_DL_SITES.map(site => ({
    id: `gallery-dl-${site.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    label: `${site.name} (gallery-dl)`,
    category: 'gallery',
    hosts: site.hosts,
  })),
];

const cobaltServices = [
  { id: 'twitter', label: 'Twitter / X', category: 'social', hosts: ['twitter.com', 'x.com'] },
  { id: 'bluesky', label: 'Bluesky', category: 'social', hosts: ['bsky.app'] },
  { id: 'tiktok', label: 'TikTok', category: 'social', hosts: ['tiktok.com'] },
  { id: 'instagram', label: 'Instagram', category: 'social', hosts: ['instagram.com'] },
  { id: 'reddit', label: 'Reddit', category: 'social', hosts: ['reddit.com', 'redd.it'] },
  { id: 'facebook', label: 'Facebook', category: 'social', hosts: ['facebook.com', 'fb.watch'] },
  { id: 'twitch', label: 'Twitch (clips)', category: 'social', hosts: ['twitch.tv'] },
  { id: 'soundcloud', label: 'SoundCloud', category: 'social', hosts: ['soundcloud.com'] },
  { id: 'tumblr', label: 'Tumblr', category: 'social', hosts: ['tumblr.com'] },
  { id: 'streamable', label: 'Streamable', category: 'social', hosts: ['streamable.com'] },
  {
    id: 'dailymotion',
    label: 'Dailymotion',
    category: 'social',
    hosts: ['dailymotion.com', 'dai.ly'],
  },
  { id: 'snapchat', label: 'Snapchat', category: 'social', hosts: ['snapchat.com'] },
];

// Sources with their own extractor carry their switches in the source table.
const customServices = SOURCES.flatMap(source => source.services ?? []);

// v.redd.it routes through yt-dlp but is not a separate source to a user: a yt-dlp entry whose
// name a cobalt entry already owns contributes its hosts for routing, without a second toggle.
const cobaltServiceIds = new Set(cobaltServices.map(service => service.id));

/** Every download source, in UI display order (social → video → adult → booru). */
export const DOWNLOAD_SERVICES = [
  ...cobaltServices,
  ...ytdlpServices.filter(service => !cobaltServiceIds.has(service.id)),
  ...galleryDlServices,
  ...customServices,
];

/** Set of valid service ids, for validating the disabled_services setting. */
export const DOWNLOAD_SERVICE_IDS = new Set(DOWNLOAD_SERVICES.map(s => s.id));

export function getServiceForUrl(url) {
  const hostname = hostOf(canonicalizeMirrorUrl(url));
  if (!hostname) return null;
  return (
    DOWNLOAD_SERVICES.find(service =>
      service.hosts.some(host => hostname === host || hostname.endsWith(`.${host}`))
    ) || null
  );
}

// If the URL belongs to a service that has been turned off in the webui, return that service's display label; otherwise null
export async function getDisabledServiceLabel(url) {
  const service = getServiceForUrl(url);
  if (!service) {
    return null;
  }
  let disabled;
  try {
    disabled = JSON.parse(await getSetting('disabled_services', '[]'));
  } catch {
    disabled = [];
  }
  return Array.isArray(disabled) && disabled.includes(service.id) ? service.label : null;
}
