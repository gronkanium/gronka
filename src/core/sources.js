import { botConfig } from '../utils/config.js';
import { isSocialMediaUrl } from '../utils/cobalt.js';
import { getYtdlpSite, downloadWithYtdlp } from '../utils/ytdlp.js';
import { getGalleryDlSite, downloadWithGalleryDl } from '../utils/gallery-dl.js';
import { isDeviationUrl, downloadFromDeviantArt } from '../utils/deviantart.js';
import { isHentaiGifzUrl, downloadFromHentaiGifz } from '../utils/hentaigifz.js';
import { isBooruUrl, downloadFromBooru, booruCdnUserAgent } from '../utils/booru.js';
import { isPinterestUrl, downloadFromPinterest } from '../utils/pinterest.js';
import { isKlipyUrl, downloadFromKlipy } from '../utils/klipy.js';
import { isJumpshareUrl, resolveJumpshareUrl } from '../utils/jumpshare.js';
import { isMedalUrl, downloadFromMedal } from '../utils/medal.js';
import { isThreadsUrl, downloadFromThreads } from '../utils/threads.js';
import { isMegaUrl, downloadFromMega } from '../utils/mega.js';
import {
  isInstagramStoryUrl,
  hasInstagramSession,
  downloadFromInstagram,
} from '../utils/instagram.js';
import { isDirectMediaUrl, downloadDirectMedia } from '../utils/file-downloader.js';

const {
  cobaltEnabled: COBALT_ENABLED,
  ytdlpEnabled: YTDLP_ENABLED,
  ytdlpQuality: YTDLP_QUALITY,
  galleryDlEnabled: GALLERY_DL_ENABLED,
} = botConfig;

// yt-dlp only does video, so a still image on a yt-dlp host (i.imgur.com/x.jpg) goes direct.
const isStillImage = url => {
  try {
    return /\.(jpe?g|png|webp|bmp)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

const ytdlp = async (url, ctx) =>
  downloadWithYtdlp(url, {
    maxSize: ctx.maxSize,
    quality: YTDLP_QUALITY,
    maxDuration: await ctx.maxDuration(),
    startTime: ctx.startTime,
    duration: ctx.duration,
  });

const switches = (category, ...entries) =>
  entries.map(([id, label, hosts]) => ({ id, label, category, hosts }));

// Every download source, in the order they are tried: the first whose `match` takes a URL owns it.
// `enabled` false means the source exists but is turned off here; `fallback` is tried when the
// source fails for a reason that is not the user's or the post's; `streams` lets web hand out a
// stream link; `services` are its on/off switches in the webui (yt-dlp, gallery-dl and cobalt
// sites take theirs from their own tables).
export const SOURCES = [
  {
    id: 'medal',
    label: () => 'Medal',
    match: isMedalUrl,
    extract: (url, ctx) => ctx.maxDuration().then(max => downloadFromMedal(url, max)),
    fallback: 'ytdlp',
  },
  {
    id: 'ytdlp',
    label: url => `${getYtdlpSite(url)} via yt-dlp`,
    match: url => getYtdlpSite(url) !== null && !isStillImage(url),
    enabled: () => YTDLP_ENABLED,
    disabledMessage: url => `${getYtdlpSite(url).toLowerCase()} downloads are disabled.`,
    extract: (url, ctx) => ytdlp(url, ctx),
    streams: true,
  },
  {
    id: 'gallery-dl',
    label: url => `${getGalleryDlSite(url)} via gallery-dl`,
    match: url => !isDeviationUrl(url) && getGalleryDlSite(url) !== null,
    enabled: () => GALLERY_DL_ENABLED,
    disabledMessage: url => `${getGalleryDlSite(url).toLowerCase()} downloads are disabled.`,
    extract: (url, ctx) => downloadWithGalleryDl(url, ctx.maxSize, ctx.galleryOptions),
  },
  {
    id: 'deviantart',
    label: () => 'DeviantArt',
    match: isDeviationUrl,
    extract: (url, ctx) => downloadFromDeviantArt(url, ctx.maxSize),
  },
  {
    id: 'hentaigifz',
    label: () => 'hentaigifz',
    match: isHentaiGifzUrl,
    extract: url => downloadFromHentaiGifz(url),
    services: switches('adult', ['hentaigifz', 'hentaigifz', ['hentaigifz.com']]),
  },
  {
    id: 'booru',
    label: () => 'booru',
    match: isBooruUrl,
    extract: url => downloadFromBooru(url),
    services: switches(
      'booru',
      ['danbooru', 'Danbooru', ['danbooru.donmai.us']],
      ['e621', 'e621 / e926', ['e621.net', 'e926.net']],
      ['yandere', 'yande.re', ['yande.re']],
      ['konachan', 'Konachan', ['konachan.com', 'konachan.net']]
    ),
  },
  {
    id: 'pinterest',
    label: () => 'Pinterest',
    match: isPinterestUrl,
    extract: url => downloadFromPinterest(url),
    services: switches('social', ['pinterest', 'Pinterest', ['pinterest.com', 'pin.it']]),
  },
  {
    id: 'klipy',
    label: () => 'Klipy',
    match: isKlipyUrl,
    extract: url => downloadFromKlipy(url),
    services: switches('social', ['klipy', 'Klipy', ['klipy.com']]),
  },
  {
    id: 'jumpshare',
    label: () => 'Jumpshare',
    match: isJumpshareUrl,
    extract: async (url, ctx) => downloadDirectMedia(await resolveJumpshareUrl(url), ctx.client),
    services: switches('video', ['jumpshare', 'Jumpshare', ['jumpshare.com']]),
  },
  {
    id: 'threads',
    label: () => 'Threads',
    match: isThreadsUrl,
    extract: url => downloadFromThreads(url),
    services: switches('social', ['threads', 'Threads', ['threads.com', 'threads.net']]),
  },
  {
    id: 'instagram-story',
    label: () => 'Instagram story',
    match: url => isInstagramStoryUrl(url) && hasInstagramSession(),
    extract: url => downloadFromInstagram(url),
  },
  {
    id: 'mega',
    label: () => 'Mega',
    match: isMegaUrl,
    extract: (url, ctx) => downloadFromMega(url, ctx.maxSize),
    services: switches('video', ['mega', 'Mega', ['mega.nz', 'mega.io']]),
  },
  {
    id: 'direct',
    label: () => 'direct media link',
    match: isDirectMediaUrl,
    extract: (url, ctx) =>
      downloadDirectMedia(url, ctx.client, { userAgent: booruCdnUserAgent(url) }),
    streams: true,
    // giphy pages canonicalize to their i.giphy.com file.
    services: switches('social', ['giphy', 'Giphy', ['giphy.com']]),
  },
  {
    id: 'cobalt',
    label: () => 'Cobalt',
    match: isSocialMediaUrl,
    enabled: () => COBALT_ENABLED,
    disabledMessage: () => 'cobalt is not enabled. please enable it to use the download command.',
    streams: true,
  },
];

const byId = new Map(SOURCES.map(source => [source.id, source]));
export const sourceById = id => byId.get(id) ?? null;

// The source that owns a URL, or null when no source takes it.
export const routeFor = url => SOURCES.find(source => source.match(url)) ?? null;

export const isEnabled = source => source.enabled?.() ?? true;
