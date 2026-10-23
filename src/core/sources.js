import { botConfig } from '../utils/config.js';
import { isSocialMediaUrl, downloadFromSocialMedia } from '../utils/cobalt.js';
import { getYtdlpSite, downloadWithYtdlp } from '../utils/ytdlp.js';
import {
  getGalleryDlSite,
  downloadWithGalleryDl,
  isFacebookPhotoUrl,
  isFacebookPostUrl,
} from '../utils/gallery-dl.js';
import { isDeviationUrl, downloadFromDeviantArt } from '../utils/deviantart.js';
import { isHentaiGifzUrl, downloadFromHentaiGifz } from '../utils/hentaigifz.js';
import { isBooruUrl, downloadFromBooru, booruCdnUserAgent } from '../utils/booru.js';
import { isPinterestUrl, downloadFromPinterest } from '../utils/pinterest.js';
import { isKlipyUrl, downloadFromKlipy } from '../utils/klipy.js';
import { isJumpshareUrl, resolveJumpshareUrl } from '../utils/jumpshare.js';
import { isMedalUrl, downloadFromMedal } from '../utils/medal.js';
import { isThreadsUrl, downloadFromThreads } from '../utils/threads.js';
import { downloadFromX } from '../utils/x-media.js';
import { isMegaUrl, downloadFromMega } from '../utils/mega.js';
import {
  isInstagramStoryUrl,
  isInstagramPostUrl,
  hasInstagramSession,
  downloadFromInstagram,
} from '../utils/instagram.js';
import {
  isDirectMediaUrl,
  downloadDirectMedia,
  parseTenorUrl,
  TENOR_VIEW_URL,
} from '../utils/file-downloader.js';
import { isTiktokContentUrl } from '../content/tiktok.js';
import { isTwitterContentUrl } from '../content/twitter.js';
import { hostOf } from '../utils/url-host.js';
import { readSetting } from '../utils/settings.js';

const {
  cobaltEnabled: COBALT_ENABLED,
  cobaltApiUrl: COBALT_API_URL,
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

const onHost =
  (...hosts) =>
  url => {
    const host = hostOf(url);
    return Boolean(host) && hosts.some(h => host === h || host.endsWith(`.${h}`));
  };

const switches = (category, ...entries) =>
  entries.map(([id, label, hosts]) => ({ id, label, category, hosts }));

// What can fetch a link. `streams` lets web hand out a stream link instead of the file.
export const ENGINES = {
  cobalt: {
    name: 'cobalt',
    enabled: () => COBALT_ENABLED,
    disabledMessage: () => 'downloads from this site are turned off.',
    extract: (url, ctx) =>
      downloadFromSocialMedia(COBALT_API_URL, url, ctx.maxSize, ctx.cobaltResponse),
    streams: true,
  },
  ytdlp: {
    name: 'yt-dlp',
    enabled: () => YTDLP_ENABLED,
    disabledMessage: url =>
      `${(getYtdlpSite(url) ?? 'this site').toLowerCase()} downloads are disabled.`,
    extract: async (url, ctx) =>
      downloadWithYtdlp(url, {
        maxSize: ctx.maxSize,
        quality: YTDLP_QUALITY,
        maxDuration: await ctx.maxDuration(),
        startTime: ctx.startTime,
        duration: ctx.duration,
      }),
    streams: true,
  },
  'gallery-dl': {
    name: 'gallery-dl',
    enabled: () => GALLERY_DL_ENABLED,
    disabledMessage: url =>
      `${(getGalleryDlSite(url) ?? 'gallery').toLowerCase()} downloads are disabled.`,
    extract: (url, ctx) => downloadWithGalleryDl(url, ctx.maxSize, ctx.galleryOptions),
  },
  instagram: { name: 'Instagram session', extract: url => downloadFromInstagram(url) },
  medal: {
    name: 'Medal',
    extract: (url, ctx) => ctx.maxDuration().then(max => downloadFromMedal(url, max)),
  },
  deviantart: {
    name: 'DeviantArt',
    extract: (url, ctx) => downloadFromDeviantArt(url, ctx.maxSize),
  },
  hentaigifz: { name: 'hentaigifz', extract: url => downloadFromHentaiGifz(url) },
  booru: { name: 'booru', extract: url => downloadFromBooru(url) },
  pinterest: { name: 'Pinterest', extract: url => downloadFromPinterest(url) },
  klipy: { name: 'Klipy', extract: url => downloadFromKlipy(url) },
  jumpshare: {
    name: 'Jumpshare',
    extract: async (url, ctx) => downloadDirectMedia(await resolveJumpshareUrl(url), ctx.client),
  },
  tenor: {
    name: 'Tenor',
    extract: async (url, ctx) => downloadDirectMedia(await parseTenorUrl(url), ctx.client),
  },
  threads: { name: 'Threads', extract: url => downloadFromThreads(url) },
  x: { name: 'X', extract: url => downloadFromX(url) },
  mega: { name: 'Mega', extract: (url, ctx) => downloadFromMega(url, ctx.maxSize) },
  direct: {
    name: 'direct file',
    extract: (url, ctx) =>
      downloadDirectMedia(url, ctx.client, { userAgent: booruCdnUserAgent(url) }),
    streams: true,
  },
};

export const isEnabled = engine => engine.enabled?.() ?? true;

const step = (engine, extra = {}) => ({ engine, ...extra });

// The first route whose `owns` takes a link owns it; the owner can reorder or switch off its chain.
export const ROUTES = [
  {
    id: 'medal',
    name: 'Medal',
    owns: isMedalUrl,
    chain: [step('medal'), step('ytdlp')],
    switchIds: ['medal'],
  },
  {
    id: 'facebook-photo',
    name: 'Facebook photos',
    owns: isFacebookPhotoUrl,
    chain: [step('gallery-dl')],
  },
  { id: 'deviantart', name: 'DeviantArt', owns: isDeviationUrl, chain: [step('deviantart')] },
  {
    id: 'gallery-dl',
    name: 'Galleries',
    owns: url => getGalleryDlSite(url) !== null,
    chain: [step('gallery-dl')],
  },
  {
    id: 'hentaigifz',
    name: 'hentaigifz',
    owns: isHentaiGifzUrl,
    chain: [step('hentaigifz')],
    services: switches('adult', ['hentaigifz', 'hentaigifz', ['hentaigifz.com']]),
  },
  {
    id: 'booru',
    name: 'Boorus',
    owns: isBooruUrl,
    chain: [step('booru')],
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
    name: 'Pinterest',
    owns: isPinterestUrl,
    chain: [step('pinterest')],
    services: switches('social', ['pinterest', 'Pinterest', ['pinterest.com', 'pin.it']]),
  },
  {
    id: 'klipy',
    name: 'Klipy',
    owns: isKlipyUrl,
    chain: [step('klipy')],
    services: switches('social', ['klipy', 'Klipy', ['klipy.com']]),
  },
  {
    id: 'jumpshare',
    name: 'Jumpshare',
    owns: isJumpshareUrl,
    chain: [step('jumpshare')],
    services: switches('video', ['jumpshare', 'Jumpshare', ['jumpshare.com']]),
  },
  {
    id: 'threads',
    name: 'Threads',
    owns: isThreadsUrl,
    chain: [step('threads')],
    services: switches('social', ['threads', 'Threads', ['threads.com', 'threads.net']]),
  },
  {
    id: 'instagram-story',
    name: 'Instagram stories',
    owns: url => isInstagramStoryUrl(url) && hasInstagramSession(),
    chain: [step('instagram')],
  },
  {
    id: 'mega',
    name: 'Mega',
    owns: isMegaUrl,
    chain: [step('mega')],
    services: switches('video', ['mega', 'Mega', ['mega.nz', 'mega.io']]),
  },
  // Cobalt tries Instagram's logged-out routes first; the session extractor is the backstop.
  {
    id: 'instagram',
    name: 'Instagram',
    owns: onHost('instagram.com'),
    chain: [
      step('cobalt'),
      step('instagram', {
        when: url => isInstagramPostUrl(url) && hasInstagramSession(),
        note: 'posts',
      }),
      step('ytdlp'),
    ],
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    owns: onHost('tiktok.com'),
    chain: [
      step('cobalt'),
      step('ytdlp'),
      step('gallery-dl', { when: isTiktokContentUrl, note: 'posts' }),
    ],
  },
  {
    id: 'x',
    name: 'X / Twitter',
    owns: onHost('x.com', 'twitter.com'),
    chain: [step('cobalt'), step('x', { when: isTwitterContentUrl, note: 'posts' }), step('ytdlp')],
  },
  {
    id: 'youtube',
    name: 'YouTube',
    owns: onHost('youtube.com', 'youtu.be'),
    chain: [step('ytdlp'), step('cobalt', { on: false })],
  },
  {
    id: 'tenor',
    name: 'Tenor',
    owns: url => TENOR_VIEW_URL.test(url),
    chain: [step('tenor')],
    services: switches('social', ['tenor', 'Tenor', ['tenor.com']]),
  },
  {
    id: 'ytdlp',
    name: 'yt-dlp sites',
    owns: url => getYtdlpSite(url) !== null && !isStillImage(url),
    chain: [step('ytdlp')],
  },
  {
    id: 'direct',
    name: 'Direct file links',
    owns: isDirectMediaUrl,
    chain: [step('direct')],
    // giphy pages canonicalize to their i.giphy.com file.
    services: switches('social', ['giphy', 'Giphy', ['giphy.com']]),
  },
  // A photo post has no video for yt-dlp; gallery-dl reads its photos.
  {
    id: 'facebook',
    name: 'Facebook',
    owns: onHost('facebook.com', 'fb.watch'),
    chain: [
      step('cobalt'),
      step('ytdlp'),
      step('gallery-dl', { when: isFacebookPostUrl, note: 'photo posts' }),
    ],
  },
  {
    id: 'social',
    name: 'Other social sites',
    owns: isSocialMediaUrl,
    chain: [step('cobalt'), step('ytdlp')],
  },
];

const routesById = new Map(ROUTES.map(route => [route.id, route]));
export const routeById = id => routesById.get(id) ?? null;

// The route that owns a URL, or null when no route takes it.
export const routeFor = url => ROUTES.find(route => route.owns(url)) ?? null;

// The owner's saved order applied; steps it doesn't know go last, steps the code dropped vanish.
export function arrangeChain(route, saved) {
  const order = Array.isArray(saved?.[route.id]) ? saved[route.id] : null;
  const steps = route.chain.map(s => ({ ...s, on: s.on ?? true }));
  if (!order) return steps;
  const byEngine = new Map(steps.map(s => [s.engine, s]));
  const seen = new Set();
  const arranged = order
    .filter(s => byEngine.has(s?.engine) && !seen.has(s.engine) && seen.add(s.engine))
    .map(s => ({ ...byEngine.get(s.engine), on: s.on !== false }));
  return [...arranged, ...steps.filter(s => !seen.has(s.engine))];
}

// The engines that will try a URL, in order: switched on, applying to this link, and enabled.
export async function chainFor(url, route = routeFor(url)) {
  if (!route) return { route: null, engines: [], disabled: null };
  const steps = arrangeChain(route, await readSetting('source_routes')).filter(
    s => s.on && (!s.when || s.when(url))
  );
  if (!steps.length) {
    const off = {
      id: route.id,
      disabledMessage: () => `downloads from ${route.name} are turned off.`,
    };
    return { route, engines: [], disabled: off };
  }
  const engines = steps.map(s => ({ id: s.engine, ...ENGINES[s.engine] }));
  const enabled = engines.filter(isEnabled);
  return { route, engines: enabled, disabled: enabled.length ? null : (engines[0] ?? null) };
}
