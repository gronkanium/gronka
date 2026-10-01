// The one shape every content source normalizes into, so a caller parses reddit and x the same
// way. Keep it flat and boring: text first, everything else optional and null when unknown.
//
// Thread  { source, url, post: Post, thread: Post[], comments: Comment[], truncated }
//   source    'reddit' | 'twitter'
//   url       the canonical link, after share-link and mirror-host rewriting
//   post      the item the link points at
//   thread    the author's own continuation, in order, post included (x threads). empty elsewhere
//   comments  replies by other people, as a tree (reddit). empty for x: the api never asks for them
//   truncated true when depth or count caps dropped something
//
// Post    { id, url, author, createdAt, title, text, media, links, quoted, stats, ... }
//   author    { handle, name, url } ; handle is the @name or u/name without the prefix
//   createdAt iso 8601 utc, or null
//   title     reddit only, null elsewhere
//   text      the body as plain text, markdown left as the author wrote it on reddit
//   media     [{ type: 'image' | 'video' | 'gif', url, alt, width, height }]
//   links     outbound links in the text, the reddit link post's target included
//   quoted    a Post the item quotes or crossposts, or null
//   parent    { id, url, author } of the item this one replies to, or null
//   stats     { likes, reposts, replies, score, views }, each a number or null
//   flags     { nsfw, spoiler, edited } booleans where the source says
//   extra     source fields that do not fit above (subreddit, poll, note, article)
//
// Comment extends Post with { depth, replies: Comment[] }

function pickNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function post(fields) {
  return {
    id: fields.id ?? null,
    url: fields.url ?? null,
    author: fields.author ?? { handle: null, name: null, url: null },
    createdAt: fields.createdAt ?? null,
    title: fields.title ?? null,
    text: fields.text ?? '',
    media: fields.media ?? [],
    links: fields.links ?? [],
    quoted: fields.quoted ?? null,
    parent: fields.parent ?? null,
    stats: {
      likes: pickNumber(fields.stats?.likes),
      reposts: pickNumber(fields.stats?.reposts),
      replies: pickNumber(fields.stats?.replies),
      score: pickNumber(fields.stats?.score),
      views: pickNumber(fields.stats?.views),
    },
    flags: {
      nsfw: Boolean(fields.flags?.nsfw),
      spoiler: Boolean(fields.flags?.spoiler),
      edited: Boolean(fields.flags?.edited),
    },
    extra: fields.extra ?? {},
  };
}

export function comment(fields) {
  return { ...post(fields), depth: fields.depth ?? 0, replies: fields.replies ?? [] };
}

export function thread(fields) {
  return {
    source: fields.source,
    url: fields.url,
    post: fields.post,
    thread: fields.thread ?? [],
    comments: fields.comments ?? [],
    truncated: Boolean(fields.truncated),
  };
}

export function isoDate(seconds) {
  return typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

/** Outbound http(s) links in a body, deduplicated, in order of appearance. */
export function linksIn(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(/https?:\/\/[^\s<>()[\]"']+/g)) {
    found.add(match[0].replace(/[.,;:!?]+$/, ''));
  }
  return [...found];
}

function authorLine(item) {
  const handle = item.author?.handle ? `@${item.author.handle}` : 'unknown';
  const name =
    item.author?.name && item.author.name !== item.author.handle ? ` (${item.author.name})` : '';
  const when = item.createdAt ? ` · ${item.createdAt.slice(0, 16).replace('T', ' ')}` : '';
  return `${handle}${name}${when}`;
}

function postLines(item, indent = '') {
  const lines = [];
  if (item.title) lines.push(`${indent}# ${item.title}`);
  lines.push(`${indent}${authorLine(item)}`);
  for (const line of String(item.text ?? '').split('\n')) lines.push(`${indent}${line}`);
  for (const media of item.media ?? []) {
    lines.push(`${indent}[${media.type}] ${media.url}${media.alt ? ` — ${media.alt}` : ''}`);
  }
  if (item.quoted) {
    lines.push(`${indent}> quoting ${item.quoted.url ?? ''}`.trimEnd());
    for (const line of postLines(item.quoted, `${indent}> `)) lines.push(line);
  }
  return lines;
}

function commentLines(items, indent) {
  const lines = [];
  for (const item of items) {
    lines.push(...postLines(item, indent), '');
    lines.push(...commentLines(item.replies ?? [], `${indent}    `));
  }
  return lines;
}

/**
 * A plain-text rendering of a Thread, for pasting into a prompt or a terminal: the post, the
 * author's thread under it, then the comment tree indented four spaces per level.
 */
export function toPlainText(result) {
  const lines = [`${result.source}: ${result.url}`, ''];
  const sequence = result.thread.length ? result.thread : [result.post];
  for (const item of sequence) lines.push(...postLines(item), '');
  if (result.comments.length) {
    lines.push('--- comments ---', '', ...commentLines(result.comments, ''));
  }
  if (result.truncated) lines.push('(truncated)');
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}
