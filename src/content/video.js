import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../utils/logger.js';
import { NetworkError, contentGone } from '../utils/errors.js';
import { jobSignal } from '../utils/media-file.js';
import { hostOf } from '../utils/url-host.js';
import {
  getYtdlpSite,
  getCookieArgs,
  getYouTubeArgs,
  getSiteArgs,
  isYouTubeUrl,
} from '../utils/ytdlp.js';
import { post, comment, thread, isoDate, linksIn, MAX_COMMENTS } from './schema.js';

const logger = createLogger('content-video');
const execFileAsync = promisify(execFile);

export const VIDEO_LIMITS = {
  comments: MAX_COMMENTS,
  tags: 30,
  timeoutMs: 30000,
  transcriptBytes: 8 * 1024 * 1024,
};

// Sites yt-dlp reads that are not in YTDLP_SITES (those download through cobalt).
const EXTRA_SITES = [
  { name: 'SoundCloud', hosts: ['soundcloud.com'] },
  { name: 'Twitch', hosts: ['twitch.tv'] },
  { name: 'Vimeo', hosts: ['vimeo.com'] },
  { name: 'Dailymotion', hosts: ['dailymotion.com', 'dai.ly'] },
];

// Sources of their own win; v.redd.it is in YTDLP_SITES for downloads only.
const OWN_SOURCES = [
  'reddit.com',
  'redd.it',
  'x.com',
  'twitter.com',
  'instagram.com',
  'tiktok.com',
];
const under = (host, hosts) => hosts.some(h => host === h || host.endsWith(`.${h}`));

function siteOf(url) {
  const host = hostOf(url);
  if (!host || !/^https?:/i.test(url) || under(host, OWN_SOURCES)) return null;
  return getYtdlpSite(url) ?? EXTRA_SITES.find(s => under(host, s.hosts))?.name ?? null;
}

export function isVideoContentUrl(url) {
  return siteOf(url) !== null;
}

function classify(stderr) {
  if (/Unsupported URL|is not a valid URL/i.test(stderr)) {
    return new NetworkError('that is not a link to a video page', 'BAD_URL', 400);
  }
  if (
    /Video unavailable|video is unavailable|Private video|members-only|Join this channel|has been removed|no longer available|does not exist|not found|404|account .*(suspended|terminated)|This video is private|login required|requires authentication/i.test(
      stderr
    )
  ) {
    return contentGone();
  }
  return null;
}

const lastLine = text =>
  String(text ?? '')
    .trim()
    .split('\n')
    .pop();

async function defaultRunner(args) {
  try {
    const { stdout } = await execFileAsync('yt-dlp', args, {
      timeout: VIDEO_LIMITS.timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 128 * 1024 * 1024,
      signal: jobSignal(),
    });
    return stdout;
  } catch (error) {
    error.stderr ??= error.message;
    throw error;
  }
}

function dump(url, site, wantComments, signedIn) {
  const args = ['--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings'];
  args.push(...getCookieArgs(url, signedIn), ...getYouTubeArgs(url, signedIn));
  args.push(...getSiteArgs(url));
  if (wantComments) {
    args.push(
      '--write-comments',
      '--extractor-args',
      `youtube:max_comments=${wantComments},all,0,0`
    );
  }
  return [...args, url];
}

async function readInfo(url, site, wantComments, runner) {
  const attempt = async signedIn => {
    try {
      return JSON.parse(await runner(dump(url, site, wantComments, signedIn)));
    } catch (error) {
      if (error instanceof SyntaxError) throw error;
      const stderr = String(error.stderr ?? error.message ?? '');
      if (
        !signedIn &&
        isYouTubeUrl(url) &&
        /confirm your age|not a bot|Please sign in/i.test(stderr)
      ) {
        return attempt(true);
      }
      throw Object.assign(error, { stderr });
    }
  };
  try {
    return await attempt(false);
  } catch (error) {
    const known = classify(String(error.stderr ?? ''));
    if (known) throw known;
    if (error.killed || error.signal) {
      throw new NetworkError('reading this video timed out');
    }
    logger.warn(`yt-dlp could not read ${site}: ${lastLine(error.stderr || error.message)}`);
    throw new NetworkError('failed to read this video');
  }
}

function thumbnailOf(info) {
  const best = [...(info.thumbnails ?? [])]
    .filter(t => t.url)
    .sort(
      (a, b) => (b.preference ?? 0) - (a.preference ?? 0) || (b.width ?? 0) - (a.width ?? 0)
    )[0];
  const url = best?.url ?? info.thumbnail ?? null;
  return url
    ? [
        {
          type: 'image',
          url,
          alt: null,
          width: best?.width ?? null,
          height: best?.height ?? null,
          duration: info.duration ?? null,
        },
      ]
    : [];
}

function createdAt(info) {
  if (info.timestamp) return isoDate(info.timestamp);
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(info.upload_date ?? '');
  return d ? `${d[1]}-${d[2]}-${d[3]}T00:00:00.000Z` : null;
}

function commentOf(item) {
  return comment({
    id: item.id ?? null,
    author: {
      handle: item.author_id ?? null,
      name: item.author ?? null,
      url: item.author_url ?? null,
    },
    createdAt: isoDate(item.timestamp),
    text: item.text ?? '',
    stats: { likes: item.like_count },
    depth: 0,
  });
}

export function normalizeVideo(info, url, site) {
  const text = info.description ?? '';
  return post({
    id: info.id ?? null,
    url: info.webpage_url ?? url,
    author: {
      handle: info.uploader_id ?? info.channel_id ?? null,
      name: info.uploader ?? info.channel ?? null,
      url: info.uploader_url ?? info.channel_url ?? null,
    },
    createdAt: createdAt(info),
    title: info.title ?? null,
    text,
    media: thumbnailOf(info),
    links: linksIn(text),
    stats: { likes: info.like_count, replies: info.comment_count, views: info.view_count },
    flags: { nsfw: (info.age_limit ?? 0) >= 18 },
    extra: {
      site,
      duration: info.duration ?? null,
      tags: (info.tags ?? []).slice(0, VIDEO_LIMITS.tags),
      categories: info.categories ?? [],
      chapters: (info.chapters ?? []).map(c => ({ title: c.title, start: c.start_time })),
      live_status: info.live_status ?? null,
      channel_follower_count: info.channel_follower_count ?? null,
    },
  });
}

// Uploaded captions beat youtube's speech recognition; "-orig" is the auto track before translation.
export function pickTrack(info, lang) {
  const want = String(lang ?? info.language ?? 'en').toLowerCase();
  const base = want.split('-')[0];
  const find = (tracks, exact) => {
    const names = Object.keys(tracks ?? {}).filter(k => k !== 'live_chat');
    const name =
      exact.map(e => names.find(k => k.toLowerCase() === e)).find(Boolean) ??
      names.find(k => k.toLowerCase().split('-')[0] === base);
    const json3 = name && tracks[name].find(f => f.ext === 'json3' && f.url);
    return json3 ? { language: name, url: json3.url } : null;
  };
  const manual = find(info.subtitles, [want]);
  if (manual) return { ...manual, generated: false };
  const auto = find(info.automatic_captions, [`${want}-orig`, want]);
  return auto ? { ...auto, generated: true } : null;
}

export function parseJson3(data) {
  const segments = [];
  for (const event of data?.events ?? []) {
    const text = (event.segs ?? [])
      .map(s => s.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const start = (event.tStartMs ?? 0) / 1000;
    segments.push({ start, end: start + (event.dDurationMs ?? 0) / 1000, text });
  }
  return segments;
}

async function defaultFetcher(url) {
  const { data } = await axios.get(url, {
    timeout: VIDEO_LIMITS.timeoutMs,
    maxContentLength: VIDEO_LIMITS.transcriptBytes,
    responseType: 'json',
  });
  return data;
}

async function readTranscript(info, lang, fetcher) {
  const track = pickTrack(info, lang);
  if (!track) return null;
  try {
    const segments = parseJson3(await fetcher(track.url));
    return { language: track.language, generated: track.generated, segments };
  } catch (error) {
    logger.warn(`could not fetch the transcript: ${error.message}`);
    throw new NetworkError('failed to read the transcript');
  }
}

export async function fetchVideoThread(
  url,
  { comments = 0, transcript = false, runner = defaultRunner, fetcher = defaultFetcher } = {}
) {
  const site = siteOf(url);
  if (!site) throw new NetworkError('that is not a link to a video page', 'BAD_URL', 400);
  const want = site === 'YouTube' ? Math.min(comments, VIDEO_LIMITS.comments) : 0;
  const info = await readInfo(url, site, want, runner);
  const subject = normalizeVideo(info, url, site);
  if (transcript && site === 'YouTube') {
    const lang = typeof transcript === 'string' ? transcript : null;
    subject.extra.transcript = await readTranscript(info, lang, fetcher);
  }
  const replies = want > 0 ? (info.comments ?? []).filter(c => c.parent === 'root') : [];
  return thread({
    source: 'video',
    url: subject.url,
    post: subject,
    comments: replies.slice(0, want).map(commentOf),
    truncated: want > 0 && replies.length >= want,
  });
}
