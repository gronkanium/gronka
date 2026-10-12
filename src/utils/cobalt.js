import axios from 'axios';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError, withCause, describeCause, contentGone } from './errors.js';
import { fetchToFile, withExtension } from './media-file.js';
import { detectFileType } from './storage.js';
import { mapLimit, ITEM_FANOUT } from './map-limit.js';
import { hostOf, normalizeHost } from './url-host.js';

const logger = createLogger('cobalt');

// How many items of a single picker/carousel response download at once. Bounds the memory a
// single multi-file post can hold; picker items are usually photos, so this stays generous
// enough not to slow normal carousels down.

const CONTENT_TYPE_EXTENSIONS = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-msvideo': '.avi',
  'video/x-matroska': '.mkv',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

// Cobalt's tunnel sends no content-type header at all, so defaulting to video/mp4 relabelled
// every real GIF (x.com animated GIFs arrive as GIF89a) and /convert then rejected them as
// "not a valid video format". Magic bytes are the only honest signal when the header is absent.
export function resolveContentType(headerType, filename, head) {
  if (headerType) {
    return headerType;
  }
  const ext = (filename.toLowerCase().match(/\.[^.]+$/) || [''])[0];
  const kind = detectFileType(ext, '', head);
  if (kind === 'gif') {
    return 'image/gif';
  }
  if (kind === 'image') {
    return { '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'image/jpeg';
  }
  return { '.mov': 'video/quicktime', '.webm': 'video/webm' }[ext] || 'video/mp4';
}

export function normalizeFilenameForContentType(filename, contentType) {
  const extension = CONTENT_TYPE_EXTENSIONS[contentType.toLowerCase().split(';', 1)[0].trim()];
  if (!extension) {
    return filename;
  }

  return /\.[^.]+$/.test(filename)
    ? filename.replace(/\.[^.]+$/, extension)
    : `${filename}${extension}`;
}

const RATE_LIMITED = site =>
  `${site} is rate limiting downloads right now, try again in a few minutes.`;
const FETCH_FAILED = site => `failed to reach ${site}, try again in a bit.`;

// What the user is told for each of cobalt's error codes (error.api.<code>); anything else is
// "could not download", with cobalt's code kept as the cause.
const COBALT_ERROR_MESSAGES = {
  'content.post.private': 'this post is private.',
  'content.video.private': 'this video is private.',
  'content.post.age': 'this post is age-restricted and cannot be downloaded.',
  'content.video.age': 'this video is age-restricted and cannot be downloaded.',
  'content.region': 'this post is not available in the country the bot runs from.',
  'content.video.region': 'this video is not available in the country the bot runs from.',
  'content.video.live': 'live streams can be downloaded once they end.',
  'content.paid': 'this is paid content and cannot be downloaded.',
  'content.too_long': 'this video is too long to download.',
  'fetch.empty': site => `${site} returned nothing to download for this link.`,
  'fetch.fail': FETCH_FAILED,
  'fetch.critical': FETCH_FAILED,
  'fetch.critical.core': FETCH_FAILED,
  'fetch.rate': RATE_LIMITED,
  rate_exceeded: RATE_LIMITED,
  'fetch.short_link': 'this short link could not be opened, try the full link.',
  'link.invalid': 'that link is not valid.',
  'link.unsupported': site => `${site} links are not supported.`,
  'service.unsupported': site => `${site} links are not supported.`,
  'service.disabled': site => `downloads from ${site} are turned off.`,
  'youtube.login': 'youtube is asking this server to sign in, this is usually temporary.',
  'youtube.drm': "the site only streams this one encrypted (drm), so it can't be downloaded.",
};

// Gone, private, invalid and unsupported are final; only rate limits are worth a retry.
export function cobaltError(errorCode, site) {
  const code = (errorCode ?? '').replace(/^error\.api\./, '');
  if (code === 'content.post.unavailable' || code === 'content.video.unavailable') {
    return contentGone();
  }
  const entry = COBALT_ERROR_MESSAGES[code];
  const message = typeof entry === 'function' ? entry(site) : entry;
  return new NetworkError(
    message ?? `could not download this ${site} link.`,
    code.includes('rate') ? 'RATE_LIMITED' : 'NETWORK_ERROR'
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// X/Twitter status-URL tracking params and host aliases used for normalization
const X_STATUS_TRACKING_PARAMS = ['s', 't', 'src'];
const X_HOST_ALIASES = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
]);

// Embed-fixer mirror domains people paste instead of x.com, mapped to the canonical host Cobalt understands. Cobalt doesn't
// know these hosts, so they must always be rewritten before the API call.
const EMBED_FIXER_HOSTS = new Map([
  // FxEmbed (fxtwitter) and its community instances
  ['fxtwitter.com', 'twitter.com'],
  ['fixupx.com', 'twitter.com'],
  ['twittpr.com', 'twitter.com'],
  ['pxtwitter.com', 'twitter.com'],
  ['cunnyx.com', 'twitter.com'],
  ['girlcockx.com', 'twitter.com'],
  ['stupidpenisx.com', 'twitter.com'],
  ['chudx.com', 'twitter.com'],
  ['forsenx.com', 'twitter.com'],
  ['ucobx.com', 'twitter.com'],
  ['yiffx.com', 'twitter.com'],
  ['boycuntx.com', 'twitter.com'],
  ['boypussyx.com', 'twitter.com'],
  ['catgirlsex.com', 'twitter.com'],
  ['mpregx.com', 'twitter.com'],
  ['furryfeetx.com', 'twitter.com'],
  ['hotyurisex.com', 'twitter.com'],
  ['yaoisex.com', 'twitter.com'],
  ['skibidix.com', 'twitter.com'],
  ['peepeepoopoodumdumtwitterx.org', 'twitter.com'],
  ['imthehottest18yearoldononlyfansx.com', 'twitter.com'],
  ['x1tt3r.com', 'twitter.com'],
  ['ios.horse', 'twitter.com'],
  ['x.embed.rip', 'twitter.com'],
  ['dormiex.com', 'twitter.com'],
  ['pinkcatx.com', 'twitter.com'],
  ['femboysx.com', 'twitter.com'],
  ['forsen.sex', 'twitter.com'],
  ['megapenispoopenfarten.sex', 'twitter.com'],
  ['kroniigirlcockx.com', 'twitter.com'],
  ['kittycockx.com', 'twitter.com'],
  ['fixgirldix.com', 'twitter.com'],
  ['sandycheekscockvorex.com', 'twitter.com'],
  ['boberx.com', 'twitter.com'],
  ['faggotx.com', 'twitter.com'],
  ['hitlerx.com', 'twitter.com'],
  ['goyimx.com', 'twitter.com'],
  ['epsteinx.com', 'twitter.com'],
  ['autistic.kids', 'twitter.com'],
  ['niggerfaggotx.com', 'twitter.com'],
  ['stupidfaggotlittlecocksuckerx.com', 'twitter.com'],
  // BetterTwitFix (vxtwitter)
  ['vxtwitter.com', 'twitter.com'],
  ['fixvx.com', 'twitter.com'],
  ['twitterez.com', 'twitter.com'],
  ['xeezz.com', 'twitter.com'],
  // Nitter front ends keep x.com's paths
  ['xcancel.com', 'twitter.com'],
  ['nitter.tiekoetter.com', 'twitter.com'],
  ['fxbsky.app', 'bsky.app'],
  ['bskx.app', 'bsky.app'],
  ['bskyx.app', 'bsky.app'],
  ['bsyy.app', 'bsky.app'],
  ['vxbsky.app', 'bsky.app'],
  ['bskye.app', 'bsky.app'],
  ['boobsky.app', 'bsky.app'],
  ['xbsky.app', 'bsky.app'],
  // ddinstagram.com omitted: no longer resolves.
  ['kkinstagram.com', 'instagram.com'],
  ['eeinstagram.com', 'instagram.com'],
  ['vxinstagram.com', 'instagram.com'],
  ['zzinstagram.com', 'instagram.com'],
  ['uuinstagram.com', 'instagram.com'],
  ['instagramfix.com', 'instagram.com'],
  ['toinstagram.com', 'instagram.com'],
  ['fxig.seria.moe', 'instagram.com'],
  ['67instagram.com', 'instagram.com'],
  ['instagramez.com', 'instagram.com'],
  ['rxddit.com', 'reddit.com'],
  ['vxreddit.com', 'reddit.com'],
  ['fxreddit.seria.moe', 'reddit.com'],
  ['redditez.com', 'reddit.com'],
  ['tnktok.com', 'tiktok.com'],
  ['tfxktok.com', 'tiktok.com'],
  ['vxtiktok.com', 'tiktok.com'],
  ['tiktxk.com', 'tiktok.com'],
  ['fixtiktok.com', 'tiktok.com'],
  ['dxtiktok.com', 'tiktok.com'],
  ['cocktiktok.com', 'tiktok.com'],
  ['kktiktok.com', 'tiktok.com'],
  ['tiktokez.com', 'tiktok.com'],
  ['tt.site', 'tiktok.com'],
  ['koutube.com', 'youtube.com'],
  ['fixyoutube.com', 'youtube.com'],
  ['yfxtube.com', 'youtube.com'],
  ['koutu.be', 'youtu.be'],
  ['fxyoutu.be', 'youtu.be'],
  ['fixthreads.seria.moe', 'threads.com'],
  ['facebed.com', 'facebook.com'],
  ['facebookez.com', 'facebook.com'],
  ['vxbilibili.com', 'bilibili.com'],
  ['fxbilibili.seria.moe', 'bilibili.com'],
  ['bilibiliez.com', 'bilibili.com'],
  ['tpmblr.com', 'tumblr.com'],
  ['txtumblr.com', 'tumblr.com'],
  ['fxtwitch.seria.moe', 'twitch.tv'],
  ['fixdeviantart.com', 'deviantart.com'],
  ['pinterestez.com', 'pinterest.com'],
]);

// Fixers keep minting <letters>instagram.com hosts (kkinstagram, kkkinstagram...), so match the shape too.
const mirrorTarget = host =>
  EMBED_FIXER_HOSTS.get(host) ??
  (/^[a-z0-9-]+instagram\.com$/.test(host) ? 'instagram.com' : undefined);

const GIPHY_PAGE_PATH = /^\/(?:gifs|stickers|embed)\/(?:[^/]*-)?([A-Za-z0-9]+)\/?$/;

// Canonicalize before routing: the Instagram extractor matches canonical hosts only.
export function canonicalizeMirrorUrl(url) {
  try {
    const urlObj = new URL(url);
    // A giphy page's id maps straight to its gif, so it routes as a direct media link.
    const giphyId = /^(www\.)?giphy\.com$/i.test(urlObj.hostname)
      ? urlObj.pathname.match(GIPHY_PAGE_PATH)?.[1]
      : null;
    if (giphyId) {
      return `https://i.giphy.com/${giphyId}.gif`;
    }
    const canonicalHost = mirrorTarget(normalizeHost(urlObj.hostname));
    if (!canonicalHost) {
      return url;
    }
    urlObj.hostname = canonicalHost;
    return urlObj.toString();
  } catch {
    return url;
  }
}

// Normalize social media URLs before sending them to Cobalt
export function normalizeSocialMediaUrlForCobalt(url) {
  try {
    const urlObj = new URL(url);
    let hostname = urlObj.hostname.toLowerCase();

    const canonicalHost = mirrorTarget(normalizeHost(hostname));
    if (canonicalHost) {
      urlObj.hostname = canonicalHost;
      hostname = canonicalHost;
    }

    if (X_HOST_ALIASES.has(hostname) && /^\/(?:[^/]+|i)\/status\/\d+\/?$/i.test(urlObj.pathname)) {
      urlObj.hostname = 'twitter.com';
      urlObj.hash = '';

      for (const param of X_STATUS_TRACKING_PARAMS) {
        urlObj.searchParams.delete(param);
      }

      if ([...urlObj.searchParams.keys()].length === 0) {
        urlObj.search = '';
      }
    }

    return urlObj.toString();
  } catch {
    return url;
  }
}

// Hosts cobalt handles; each also matches its subdomains (www., m., vm., clips. ...).
const SOCIAL_MEDIA_DOMAINS = [
  'twitter.com',
  'x.com',
  // Embed-fixer mirrors (rewritten to canonical hosts before hitting Cobalt)
  ...EMBED_FIXER_HOSTS.keys(),
  'bsky.app',
  'tiktok.com',
  'instagram.com',
  'youtube.com',
  'youtu.be',
  'reddit.com',
  'v.redd.it',
  'facebook.com',
  'fb.watch',
  // pinterest intentionally NOT listed: Cobalt 11 returns error.api.fetch.empty and yt-dlp's
  // extractor has been globally broken since ~2025-06 (yt-dlp #13554). Pinterest is handled by
  // the custom JSON-LD extractor in pinterest.js instead, routed before this list is consulted.
  // twitch: cobalt only handles clips (clips.twitch.tv + twitch.tv/<channel>/clip/<slug>),
  // matched host-only here, non-clip twitch URLs route through and get a curated error.
  'twitch.tv',
  'soundcloud.com', // also covers m./on. subdomains + short links
  'tumblr.com', // covers <blog>.tumblr.com and www.tumblr.com
  'streamable.com',
  'dailymotion.com',
  'dai.ly', // dailymotion short links
  'snapchat.com', // covers t.snapchat.com spotlight links
];

export function isSocialMediaUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = normalizeHost(urlObj.hostname);

    return SOCIAL_MEDIA_DOMAINS.some(
      domain => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

// cobalt 11 prefixes some Streamable links with a stray scheme: `https:https://cdn-cf-west...`.
export const repairUrl = url =>
  typeof url === 'string' ? url.replace(/^https?:(?=https?:\/\/)/i, '') : url;

async function callCobaltApi(apiUrl, url, retryCount = 0, maxRetries = 3) {
  const attemptNum = retryCount + 1;
  const normalizedUrl = normalizeSocialMediaUrlForCobalt(url);

  if (normalizedUrl !== url) {
    logger.debug(`Normalized social media URL for Cobalt: ${url} -> ${normalizedUrl}`);
  }

  logger.debug(
    `Calling Cobalt API at ${apiUrl} with URL: ${normalizedUrl} (attempt ${attemptNum}/${maxRetries})`
  );

  try {
    const response = await axios.post(
      apiUrl,
      {
        url: normalizedUrl,
        videoQuality: 'max',
        audioFormat: 'mp3',
        downloadMode: 'auto',
        filenameStyle: 'pretty',
      },
      {
        timeout: 60000, // 60 second timeout
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }
    );

    logger.debug(`Cobalt API response status: ${response.status}`);
    if (response.status !== 200) {
      throw withCause(
        new NetworkError(`could not download this ${hostOf(url) ?? 'site'} link.`),
        `cobalt: HTTP ${response.status}`
      );
    }

    const data = response.data;
    if (data?.url) data.url = repairUrl(data.url);
    for (const item of data?.picker ?? []) item.url = repairUrl(item.url);
    return data;
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      logger.debug(`Cobalt answered ${status}: ${JSON.stringify(data)}`);
      const errorCode = data?.code || data?.error?.code;
      const why = `cobalt: ${errorCode ?? `HTTP ${status} ${JSON.stringify(data ?? '').slice(0, 200)}`}`;
      const curated = cobaltError(errorCode, hostOf(url) ?? 'this site');
      if ((curated.code === 'RATE_LIMITED' || status === 429) && retryCount < maxRetries - 1) {
        const delayMs = Math.pow(2, retryCount) * 1000;
        logger.warn(
          `Rate limit detected, retrying in ${delayMs}ms (attempt ${attemptNum}/${maxRetries})`
        );
        await sleep(delayMs);
        return callCobaltApi(apiUrl, url, retryCount + 1, maxRetries);
      }
      throw withCause(curated, why);
    }
    if (error.code === 'ECONNABORTED') {
      throw withCause(
        new NetworkError('the download service took too long to answer, try again in a bit.'),
        `cobalt: ${describeCause(error)}`
      );
    }
    if (error.code === 'ECONNREFUSED') {
      throw withCause(
        new NetworkError('the download service is down right now, try again in a bit.'),
        `cobalt: ${describeCause(error)}`
      );
    }
    logger.warn(`Cobalt API call failed: ${describeCause(error)}`);
    throw withCause(
      new NetworkError('failed to reach the download service. please try again later.'),
      `cobalt: ${describeCause(error)}`
    );
  }
}

const MISSING_FILE_MESSAGE = 'the download service answered without a file, try again.';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DISPOSITION_NAME = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;

// Streams a cobalt (or source) URL to disk. {what} names the file in user-facing errors.
async function fetchCobaltFile(url, { accept, timeout, maxSize, what, failMessage }) {
  try {
    const file = await fetchToFile(
      url,
      {
        timeout,
        maxRedirects: 5,
        validateStatus: status => status >= 200 && status < 400,
        headers: { 'User-Agent': BROWSER_UA, Accept: accept, Referer: url },
      },
      { maxSize }
    );
    // cobalt's tunnel answers 200 with no body when its own fetch fails (seen on Bluesky HLS).
    if (file.size === 0) {
      throw withCause(
        new NetworkError('the download came back empty.'),
        'cobalt: tunnel answered 200 with an empty body'
      );
    }
    const match = (file.headers['content-disposition'] || '').match(DISPOSITION_NAME);
    return { ...file, dispositionName: match?.[1]?.replace(/['"]/g, '') || null };
  } catch (error) {
    if (error.code === 'TOO_LARGE' || error.response?.status === 413) {
      throw new ValidationError(
        `${what} is too large (max ${maxSize / (1024 * 1024)}mb)`,
        undefined,
        undefined,
        { cause: error }
      );
    }
    if (error instanceof NetworkError) throw error;
    const why = `cobalt file: ${describeCause(error)}`;
    if (error.response?.status === 404) {
      throw contentGone(why);
    }
    if (error.code === 'ECONNABORTED') {
      throw withCause(new NetworkError(`the ${what} took too long to download, try again.`), why);
    }
    logger.warn(`Cobalt ${what} download failed: ${describeCause(error)}`);
    throw withCause(new NetworkError(failMessage ?? `${what} could not be downloaded`), why);
  }
}

const PHOTO_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

async function downloadPhoto(photoUrl, index, maxSize = Infinity) {
  const file = await fetchCobaltFile(photoUrl, {
    accept: 'image/*,*/*',
    timeout: 60000,
    maxSize,
    what: `photo ${index + 1}`,
  });
  const contentType = file.headers['content-type'] || 'image/jpeg';
  const filename =
    file.dispositionName ?? `photo_${index + 1}${PHOTO_EXTENSIONS[contentType] || '.jpg'}`;
  logger.debug(
    `Downloaded photo ${index + 1}: ${filename}, size: ${file.size} bytes, content-type: ${contentType}`
  );
  return withExtension({ ...file, contentType, filename });
}

async function downloadVideo(videoUrl, index, maxSize = Infinity) {
  const file = await fetchCobaltFile(videoUrl, {
    accept: 'video/*,*/*',
    timeout: 300000,
    maxSize,
    what: `video ${index + 1}`,
  });
  const named = file.dispositionName ?? `video_${index + 1}.mp4`;
  const contentType = resolveContentType(file.headers['content-type'], named, file.head);
  const filename =
    file.dispositionName ?? `video_${index + 1}${CONTENT_TYPE_EXTENSIONS[contentType] || '.mp4'}`;
  logger.debug(
    `Downloaded video ${index + 1}: ${filename}, size: ${file.size} bytes, content-type: ${contentType}`
  );
  return withExtension({ ...file, contentType, filename });
}

async function downloadMediaFromPicker(pickerArray, maxSize = Infinity) {
  const mediaItems = pickerArray.filter(
    item => (item.type === 'photo' || item.type === 'video') && item.url
  );

  if (mediaItems.length === 0) {
    throw withCause(
      new NetworkError('this post has no photo or video to download.'),
      'cobalt: picker had no photo or video with a url'
    );
  }

  logger.debug(
    `Found ${mediaItems.length} media items in picker response (${mediaItems.filter(i => i.type === 'photo').length} photos, ${mediaItems.filter(i => i.type === 'video').length} videos)`
  );

  const results = await mapLimit(mediaItems, ITEM_FANOUT, (item, index) =>
    item.type === 'photo'
      ? downloadPhoto(item.url, index, maxSize)
      : downloadVideo(item.url, index, maxSize)
  );
  logger.debug(`Successfully downloaded ${results.length} media items from picker`);

  return results;
}

// Cobalt's tunnel URLs carry its Docker hostname ("cobalt"), which only resolves inside the Docker network
function replaceTunnelHostname(url, apiUrl) {
  try {
    const urlObj = new URL(url);
    const apiUrlObj = new URL(apiUrl);

    if (urlObj.hostname !== apiUrlObj.hostname) {
      urlObj.hostname = apiUrlObj.hostname;
      if (apiUrlObj.port) {
        urlObj.port = apiUrlObj.port;
      }
      logger.debug(`Replacing tunnel hostname: ${url} -> ${urlObj.toString()}`);
      return urlObj.toString();
    }
    return url;
  } catch (error) {
    logger.warn(`Failed to replace tunnel hostname: ${error.message}, using original URL`);
    return url;
  }
}

async function downloadFromCobalt(cobaltResponse, maxSize = Infinity, apiUrl = null) {
  // Cobalt API returns different response formats depending on the platform

  // Check for picker response (e.g., Twitter with multiple photos/videos)
  if (
    cobaltResponse.status === 'picker' &&
    cobaltResponse.picker &&
    Array.isArray(cobaltResponse.picker)
  ) {
    logger.debug('Detected picker response with media files');
    return await downloadMediaFromPicker(cobaltResponse.picker, maxSize);
  }

  let videoUrl = null;
  let filename = 'video.mp4';

  if (cobaltResponse.status === 'success') {
    if (cobaltResponse.url) {
      videoUrl = cobaltResponse.url;
    } else if (cobaltResponse.video) {
      videoUrl = cobaltResponse.video;
    } else if (cobaltResponse.audio) {
      videoUrl = cobaltResponse.audio;
    }

    if (cobaltResponse.filename) {
      filename = cobaltResponse.filename;
    } else if (cobaltResponse.text) {
      // Sometimes filename is in text field
      const textMatch = cobaltResponse.text.match(/filename[^:]*:\s*([^\n]+)/i);
      if (textMatch) {
        filename = textMatch[1].trim();
      }
    }
  } else if (cobaltResponse.status === 'tunnel') {
    // Handle tunnel response - Cobalt returns a tunnel URL that needs to be accessed
    logger.debug('Detected tunnel response from Cobalt');
    if (cobaltResponse.url) {
      videoUrl = cobaltResponse.url;
      // Replace Docker hostname with API URL hostname if needed
      if (apiUrl) {
        videoUrl = replaceTunnelHostname(videoUrl, apiUrl);
      }
    } else {
      throw withCause(new NetworkError(MISSING_FILE_MESSAGE), 'cobalt: tunnel response had no url');
    }

    if (cobaltResponse.filename) {
      filename = cobaltResponse.filename;
    }
  } else if (cobaltResponse.status === 'error') {
    throw withCause(
      cobaltError(cobaltResponse.error?.code, 'this site'),
      `cobalt: status error ${cobaltResponse.error?.code ?? cobaltResponse.text ?? ''}`.trim()
    );
  } else {
    const possibleKeys = ['url', 'video', 'videoUrl', 'downloadUrl', 'directUrl'];
    for (const key of possibleKeys) {
      if (cobaltResponse[key]) {
        videoUrl = cobaltResponse[key];
        if (apiUrl && videoUrl.includes('/tunnel')) {
          videoUrl = replaceTunnelHostname(videoUrl, apiUrl);
        }
        break;
      }
    }
    filename = cobaltResponse.filename || filename;
  }

  if (!videoUrl) {
    throw withCause(
      new NetworkError(MISSING_FILE_MESSAGE),
      `cobalt: status ${cobaltResponse.status} with no url`
    );
  }

  const file = await fetchCobaltFile(videoUrl, {
    accept: '*/*',
    timeout: 300000,
    maxSize,
    what: 'file',
    failMessage: 'the file could not be downloaded, try again.',
  });
  const declared = file.headers['content-type'];
  const generic = declared === 'application/octet-stream' || declared === 'binary/octet-stream';
  const named = file.dispositionName ?? filename;
  const contentType = resolveContentType(generic ? '' : declared, named, file.head);
  const finalName = normalizeFilenameForContentType(named, contentType);
  logger.debug(
    `Downloaded file: ${finalName}, size: ${file.size} bytes, content-type: ${contentType}`
  );
  return withExtension({ ...file, contentType, filename: finalName });
}

export async function getCobaltMediaUrls(apiUrl, url) {
  const cobaltResponse = await callCobaltApi(apiUrl, url);

  if (
    cobaltResponse.status === 'picker' &&
    cobaltResponse.picker &&
    Array.isArray(cobaltResponse.picker)
  ) {
    const items = cobaltResponse.picker
      .filter(item => (item.type === 'photo' || item.type === 'video') && item.url)
      .map(item => ({ url: item.url, type: item.type, filename: null }));

    // One tunnelled slide means the gallery can't be served as links without dropping it.
    if (items.length === 0 || items.some(item => item.url.includes('/tunnel'))) {
      return { urls: [], direct: false, response: cobaltResponse };
    }
    return { urls: items, direct: true, response: cobaltResponse };
  }

  if (cobaltResponse.status === 'redirect' && cobaltResponse.url) {
    return {
      urls: [
        {
          url: cobaltResponse.url,
          type: 'video',
          filename: cobaltResponse.filename || null,
        },
      ],
      direct: true,
      response: cobaltResponse,
    };
  }

  if (cobaltResponse.status === 'tunnel') {
    // Tunnel URLs point at the local cobalt container and are useless to Discord users
    return { urls: [], direct: false, response: cobaltResponse };
  }

  if (cobaltResponse.status === 'error') {
    throw withCause(
      cobaltError(cobaltResponse.error?.code, 'this site'),
      `cobalt: status error ${cobaltResponse.error?.code ?? cobaltResponse.text ?? ''}`.trim()
    );
  }

  return { urls: [], direct: false, response: cobaltResponse };
}

// Get the byte size of a remote media URL without downloading it, via a ranged GET (more widely supported than HEAD on media CDNs)
export async function getRemoteContentLength(mediaUrl) {
  try {
    const response = await axios.get(mediaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Range: 'bytes=0-0',
      },
      responseType: 'stream',
      timeout: 10000,
      maxRedirects: 5,
    });
    // Only the headers are needed; a host that ignores Range would otherwise send the whole file.
    response.data?.destroy?.();
    // content-range: "bytes 0-0/12345678" - the total after the slash is the full size
    const contentRange = response.headers['content-range'] || '';
    const totalMatch = contentRange.match(/\/(\d+)$/);
    if (totalMatch) {
      return parseInt(totalMatch[1], 10);
    }
    // Server ignored the Range header and sent the whole file
    const contentLength = parseInt(response.headers['content-length'] || '', 10);
    return Number.isFinite(contentLength) && response.status === 200 ? contentLength : null;
  } catch (error) {
    logger.warn(`Failed to get remote content length: ${error.message}`);
    return null;
  }
}

export async function downloadFromSocialMedia(apiUrl, url, maxSize = Infinity, prefetched = null) {
  logger.debug(`Attempting to download from social media URL via Cobalt: ${url}`);
  const cobaltResponse = prefetched ?? (await callCobaltApi(apiUrl, url));
  return downloadFromCobalt(cobaltResponse, maxSize, apiUrl);
}
