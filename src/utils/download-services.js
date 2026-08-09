import { YTDLP_SITES } from './ytdlp.js';
import { getSetting } from './database.js';

// Registry of every source /download can pull from, so the webui can list them and each
// can be individually turned off. This is a *parallel* classifier used only for the
// catalog + the enable/disable gate — the real routing still uses isSocialMediaUrl,
// getYtdlpSite, isHentaiGifzUrl, isBooruUrl, and isPinterestUrl unchanged. Host matching mirrors those:
// exact-or-subdomain on the www-stripped hostname.
//
// `category` groups services in the settings UI. `id` is the stable key stored in the
// disabled_services setting (never rename an id or existing toggles reset).

// yt-dlp services are derived from the shared YTDLP_SITES table so their host lists have a
// single source of truth. Everything else (cobalt-social, hentaigifz, booru) is defined
// here since those hosts live behind boolean matchers with no per-service breakdown.
const YTDLP_CATEGORY = {
  YouTube: 'video',
  Bilibili: 'video',
  Rumble: 'video',
  Coub: 'video',
  Imgur: 'video',
  Kick: 'video',
  Newgrounds: 'video',
  Xiaohongshu: 'social',
  RedGifs: 'adult',
  Pornhub: 'adult',
  XVideos: 'adult',
  xHamster: 'adult',
  RedTube: 'adult',
};

const ytdlpServices = YTDLP_SITES.map(site => ({
  id: site.name.toLowerCase(),
  label: site.name,
  category: YTDLP_CATEGORY[site.name] || 'video',
  hosts: site.hosts,
}));

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

const customServices = [
  // Pinterest is a custom extractor rather than a cobalt service; its hosts list covers the
  // main domain and the pin.it shortener, not every regional ccTLD isPinterestUrl accepts.
  { id: 'pinterest', label: 'Pinterest', category: 'social', hosts: ['pinterest.com', 'pin.it'] },
  { id: 'hentaigifz', label: 'hentaigifz', category: 'adult', hosts: ['hentaigifz.com'] },
  { id: 'danbooru', label: 'Danbooru', category: 'booru', hosts: ['danbooru.donmai.us'] },
  { id: 'e621', label: 'e621 / e926', category: 'booru', hosts: ['e621.net', 'e926.net'] },
  { id: 'yandere', label: 'yande.re', category: 'booru', hosts: ['yande.re'] },
  {
    id: 'konachan',
    label: 'Konachan',
    category: 'booru',
    hosts: ['konachan.com', 'konachan.net'],
  },
];

/** Every download source, in UI display order (social → video → adult → booru). */
export const DOWNLOAD_SERVICES = [...cobaltServices, ...ytdlpServices, ...customServices];

/** Set of valid service ids, for validating the disabled_services setting. */
export const DOWNLOAD_SERVICE_IDS = new Set(DOWNLOAD_SERVICES.map(s => s.id));

/**
 * Resolve which download service a URL belongs to.
 * @param {string} url - URL to classify
 * @returns {{id: string, label: string, category: string, hosts: string[]}|null}
 */
export function getServiceForUrl(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  return (
    DOWNLOAD_SERVICES.find(service =>
      service.hosts.some(host => hostname === host || hostname.endsWith(`.${host}`))
    ) || null
  );
}

/**
 * If the URL belongs to a service that has been turned off in the webui, return that
 * service's display label; otherwise null. Reads the (cached) disabled_services setting.
 * @param {string} url - URL to check
 * @returns {Promise<string|null>} The disabled service's label, or null
 */
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
