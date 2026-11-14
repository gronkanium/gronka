import { NetworkError } from '../utils/errors.js';
import { fetchPage } from '../utils/ssrf-guard.js';
import { getRequestHeaders } from '../utils/discord-cdn.js';
import { isDirectMediaUrl } from '../utils/file-downloader.js';
import { typeForExtension } from '../utils/media-file.js';
import { hostOf } from '../utils/url-host.js';
import { post, thread, linksIn } from './schema.js';

export const PAGE_LIMITS = { text: 20_000, images: 4, tags: 30 };

export const isPageContentUrl = url => /^https?:\/\//i.test(url) && hostOf(url) !== null;

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…' };

// HTMLRewriter hands over text and attributes exactly as written, entities and all.
const decode = text =>
  String(text ?? '')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n) =>
      String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n))
    )
    .replace(/&([a-z]+);/gi, (whole, name) => NAMED[name.toLowerCase()] ?? whole);

const clean = text => decode(text).replace(/\s+/g, ' ').trim() || null;

// Bun's HTMLRewriter streams the markup; nothing on the page runs.
export async function readPage(html) {
  const meta = new Map();
  const ld = [];
  const bodies = { article: [], main: [] };
  const page = { title: '', canonical: null, language: null };
  let open = null;
  const paragraphs = where => ({
    element(el) {
      const parts = [];
      open = parts;
      el.onEndTag(() => bodies[where].push(parts.join('')));
    },
    text(chunk) {
      open?.push(chunk.text);
    },
  });
  await new HTMLRewriter()
    .on('html', { element: el => void (page.language = el.getAttribute('lang')) })
    .on('title', { text: chunk => void (page.title += chunk.text) })
    .on('link[rel="canonical"]', { element: el => void (page.canonical = el.getAttribute('href')) })
    .on('meta', {
      element(el) {
        const key = (el.getAttribute('property') ?? el.getAttribute('name'))?.toLowerCase();
        const value = el.getAttribute('content');
        if (key && value) meta.set(key, [...(meta.get(key) ?? []), decode(value).trim()]);
      },
    })
    .on('script[type="application/ld+json"]', {
      element: () => void ld.push(''),
      text: chunk => void (ld[ld.length - 1] += chunk.text),
    })
    .on('article p', paragraphs('article'))
    .on('main p', paragraphs('main'))
    .transform(new Response(html))
    .text();
  return { meta, ld: ld.flatMap(linkedData), bodies, page };
}

function linkedData(text) {
  try {
    const flatten = node =>
      Array.isArray(node)
        ? node.flatMap(flatten)
        : node?.['@graph']
          ? flatten(node['@graph'])
          : [node];
    return flatten(JSON.parse(text)).filter(item => item && typeof item === 'object');
  } catch {
    return [];
  }
}

const MAIN_TYPES = [
  /Article|BlogPosting|Report/,
  /Recording|Album|Episode|Movie|VideoObject|Recipe|Product|Event|Book/,
  /Posting|WebPage/,
];
const typesOf = item => [item['@type']].flat().map(String);
const mainItem = items =>
  MAIN_TYPES.map(type => items.find(item => typesOf(item).some(name => type.test(name)))).find(
    Boolean
  ) ?? null;

const first = value => [value].flat().find(item => item != null && item !== '') ?? null;
const urlOf = value => {
  const found = first(value);
  return typeof found === 'string' ? found : (found?.url ?? found?.contentUrl ?? null);
};

const seconds = value => {
  if (Number.isFinite(Number(value)) && value !== '') return Number(value) || null;
  const [, h = 0, m = 0, s = 0] =
    /^PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(String(value ?? '')) ?? [];
  return h * 3600 + m * 60 + Number(s) || null;
};

const isoOr = value => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
};

const pixels = value => Number.parseInt(value, 10) || null;

function mediaOf(get, all, item, base) {
  const absolute = value => (value ? (URL.parse(value, base)?.href ?? null) : null);
  const images = (all('og:image:secure_url').length ? all('og:image:secure_url') : all('og:image'))
    .concat(all('og:image').length ? [] : all('twitter:image'))
    .concat(all('og:image').length || all('twitter:image').length ? [] : [urlOf(item?.image)])
    .map(absolute)
    .filter(Boolean);
  const media = [...new Set(images)].slice(0, PAGE_LIMITS.images).map((url, index) => ({
    type: 'image',
    url,
    alt: index ? null : clean(get('og:image:alt') ?? get('twitter:image:alt')),
    width: index ? null : pixels(get('og:image:width')),
    height: index ? null : pixels(get('og:image:height')),
  }));
  // og:video is often an embeddable player page, not a file.
  const video = absolute(get('og:video:secure_url') ?? get('og:video:url') ?? get('og:video'));
  if (video && /^video\//.test(get('og:video:type') ?? '')) {
    media.unshift({
      type: 'video',
      url: video,
      alt: null,
      width: pixels(get('og:video:width')),
      height: pixels(get('og:video:height')),
    });
  }
  const audio = absolute(get('og:audio:secure_url') ?? get('og:audio'));
  if (audio) media.push({ type: 'audio', url: audio, alt: null, width: null, height: null });
  return media;
}

export function normalizePage({ meta, ld, bodies, page }, url) {
  const all = key => meta.get(key) ?? [];
  const get = key => all(key)[0] ?? null;
  const item = mainItem(ld);
  const author = first(item?.author ?? item?.byArtist ?? item?.creator);
  const description = clean(
    get('og:description') ?? get('description') ?? get('twitter:description') ?? item?.description
  );
  const paragraphs = bodies.article.length ? bodies.article : bodies.main;
  const body = item?.articleBody
    ? decode(item.articleBody).trim()
    : paragraphs.map(clean).filter(Boolean).join('\n\n');
  const text = (body || description || '').slice(0, PAGE_LIMITS.text);
  const canonical = URL.parse(page.canonical ?? get('og:url') ?? '', url)?.href ?? url;
  const tags = [...all('article:tag'), ...(get('keywords')?.split(',') ?? [])]
    .map(clean)
    .filter(Boolean);
  return post({
    url: canonical,
    author: {
      handle: get('twitter:creator')?.replace(/^@/, '') ?? null,
      name: clean(
        typeof author === 'string'
          ? author
          : (author?.name ?? get('author') ?? get('music:musician_description'))
      ),
      url: typeof author === 'object' ? (author?.url ?? null) : null,
    },
    createdAt: isoOr(
      get('article:published_time') ?? item?.datePublished ?? item?.uploadDate ?? item?.startDate
    ),
    title:
      clean(get('og:title') ?? get('twitter:title') ?? item?.headline ?? item?.name) ??
      clean(page.title),
    text,
    media: mediaOf(get, all, item, canonical),
    links: linksIn(body),
    flags: { nsfw: get('rating') === 'adult' || get('rating') === 'RTA-5042-1996-1400-1577-RTA' },
    extra: {
      site: clean(get('og:site_name') ?? get('application-name')) ?? hostOf(canonical),
      type: get('og:type') ?? (item ? typesOf(item)[0] : null),
      language: page.language,
      description: body && description !== text ? description : null,
      modifiedAt: isoOr(get('article:modified_time') ?? item?.dateModified),
      duration: seconds(get('music:duration') ?? get('video:duration') ?? item?.duration),
      tags: [...new Set(tags)].slice(0, PAGE_LIMITS.tags),
    },
  });
}

function mediaFile(url) {
  const ext = URL.parse(url)?.pathname.split('.').pop() ?? '';
  const kind = (typeForExtension(`.${ext}`) ?? 'image/').split('/')[0];
  return post({
    url,
    media: [
      {
        type: kind === 'audio' ? 'audio' : kind === 'video' ? 'video' : 'image',
        url,
        alt: null,
        width: null,
        height: null,
      },
    ],
    extra: { site: hostOf(url), type: 'file' },
  });
}

const ACCEPT = { Accept: 'text/html,application/xhtml+xml' };

// A browser User-Agent gets Spotify's empty app shell; other sites refuse anything else.
async function defaultFetcher(url) {
  const read = headers =>
    fetchPage(url, { failMessage: "couldn't open that page right now.", headers });
  const response = await read(ACCEPT).catch(error => {
    if (![401, 403].includes(error.cause?.response?.status)) throw error;
    return read({ ...getRequestHeaders(), ...ACCEPT });
  });
  return {
    url: response.request?.res?.responseUrl ?? url,
    type: String(response.headers?.['content-type'] ?? ''),
    html: String(response.data ?? ''),
  };
}

export async function fetchPageThread(url, { fetcher = defaultFetcher } = {}) {
  if (!isPageContentUrl(url)) throw new NetworkError('that is not a web link', 'BAD_URL', 400);
  if (isDirectMediaUrl(url)) return thread({ source: 'page', url, post: mediaFile(url) });
  const page = await fetcher(url);
  if (page.type && !/html|xml/i.test(page.type)) {
    throw new NetworkError("that link isn't a web page.", 'BAD_URL', 400);
  }
  const subject = normalizePage(await readPage(page.html), page.url);
  return thread({ source: 'page', url: subject.url, post: subject });
}
