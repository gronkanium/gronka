import { NetworkError, contentGone } from '../utils/errors.js';
import { isBooruUrl, fetchBooruPost } from '../utils/booru.js';
import { post, thread, isoDate, linksIn } from './schema.js';

export const BOORU_LIMITS = {};

export const isBooruContentUrl = isBooruUrl;

const RATINGS = { g: 'safe', s: 'safe', q: 'questionable', e: 'explicit' };
const VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v']);

const words = text => (typeof text === 'string' ? text.split(/\s+/).filter(Boolean) : []);
const dateOf = value => {
  if (typeof value === 'number') return isoDate(value);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

function mediaOf(url, ext, width, height) {
  if (!url) return [];
  const type = ext === 'gif' ? 'gif' : VIDEO.has(ext) ? 'video' : 'image';
  return [{ type, url, alt: null, width: width ?? null, height: height ?? null }];
}

function sourceLinks(source) {
  return linksIn(Array.isArray(source) ? source.join(' ') : source);
}

function fromDanbooru(json) {
  const tags = {
    artist: words(json.tag_string_artist),
    character: words(json.tag_string_character),
    copyright: words(json.tag_string_copyright),
    general: words(json.tag_string_general),
    meta: words(json.tag_string_meta),
  };
  return {
    id: json.id,
    createdAt: dateOf(json.created_at),
    author: null,
    uploaderId: json.uploader_id ?? null,
    description: json.description ?? '',
    tags,
    rating: RATINGS[json.rating],
    score: json.score,
    favorites: json.fav_count,
    source: json.source,
    md5: json.md5,
    fileSize: json.file_size,
    width: json.image_width,
    height: json.image_height,
    ext: json.file_ext,
  };
}

function fromE621(json) {
  const item = json.post;
  const file = item.file ?? {};
  return {
    id: item.id,
    createdAt: dateOf(item.created_at),
    author: item.uploader_name ?? null,
    uploaderId: item.uploader_id ?? null,
    description: item.description ?? '',
    tags: {
      artist: (item.tags?.artist ?? []).filter(name => name !== 'conditional_dnp'),
      character: item.tags?.character ?? [],
      copyright: item.tags?.copyright ?? [],
      species: item.tags?.species ?? [],
      general: item.tags?.general ?? [],
      meta: item.tags?.meta ?? [],
      lore: item.tags?.lore ?? [],
    },
    rating: RATINGS[item.rating],
    score: item.score?.total,
    favorites: item.fav_count,
    source: item.sources ?? [],
    md5: file.md5,
    fileSize: file.size,
    width: file.width,
    height: file.height,
    ext: file.ext,
    deleted: item.flags?.deleted,
  };
}

function fromMoebooru(json) {
  const item = json[0];
  return {
    id: item.id,
    createdAt: dateOf(item.created_at),
    author: item.author ?? null,
    uploaderId: item.creator_id ?? null,
    description: '',
    tags: { general: words(item.tags) },
    rating: RATINGS[item.rating],
    score: item.score,
    favorites: null,
    source: item.source,
    md5: item.md5,
    fileSize: item.file_size,
    width: item.width,
    height: item.height,
    ext: item.file_ext ?? item.file_url?.split('.').pop(),
  };
}

function pick(json) {
  if (Array.isArray(json)) return json.length ? fromMoebooru(json) : null;
  if (json?.post) return fromE621(json);
  return json?.id ? fromDanbooru(json) : null;
}

export function normalizeBooruPost(json, { url, site }) {
  const data = pick(json);
  if (!data || data.deleted) throw contentGone();
  const fileUrl = site.pickFileUrl(json);
  const links = sourceLinks(data.source);
  const mediaUrl = fileUrl ? new URL(fileUrl, url).href : null;
  return post({
    id: String(data.id),
    url,
    author: data.author ? { handle: data.author, name: data.author, url: null } : undefined,
    createdAt: data.createdAt,
    text: data.description,
    media: mediaOf(mediaUrl, String(data.ext ?? '').toLowerCase(), data.width, data.height),
    links,
    stats: { score: data.score, likes: data.favorites },
    flags: { nsfw: data.rating === 'questionable' || data.rating === 'explicit' },
    extra: {
      site: site.name,
      tags: data.tags,
      rating: data.rating ?? null,
      score: data.score ?? null,
      favorites: data.favorites ?? null,
      source: links[0] ?? null,
      md5: data.md5 ?? null,
      fileSize: data.fileSize ?? null,
      width: data.width ?? null,
      height: data.height ?? null,
      uploaderId: data.uploaderId,
    },
  });
}

export async function fetchBooruThread(url, { fetchJson } = {}) {
  if (!isBooruUrl(url))
    throw new NetworkError('that is not a link to a booru post', 'BAD_URL', 400);
  const { site, host, postId, data } = await fetchBooruPost(url, fetchJson);
  const canonical = `https://${host}${site.name === 'yande.re' || site.name === 'konachan' ? '/post/show' : '/posts'}/${postId}`;
  const subject = normalizeBooruPost(data, { url: canonical, site });
  return thread({ source: 'booru', url: canonical, post: subject });
}
