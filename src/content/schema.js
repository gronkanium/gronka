// The one shape every content source returns; wiki/Content-API.md describes each field.

// Replies are a sample, not the conversation: off unless asked for, and never more than this.
export const MAX_COMMENTS = 20;

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

// Outbound http(s) links in a body, deduplicated, in order of appearance
export function linksIn(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(/https?:\/\/[^\s<>()[\]"']+/g)) {
    found.add(match[0].replace(/[.,;:!?]+$/, ''));
  }
  return [...found];
}

function clock(seconds) {
  const s = Math.floor(seconds);
  const hms = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60];
  const [h, m, sec] = hms.map(n => String(n).padStart(2, '0'));
  return hms[0] ? `${h}:${m}:${sec}` : `${m}:${sec}`;
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
    lines.push(`${indent}[${media.type}] ${media.url}${media.alt ? ` (${media.alt})` : ''}`);
  }
  if (item.extra?.transcript?.segments?.length) {
    lines.push(`${indent}--- transcript (${item.extra.transcript.language}) ---`);
    for (const seg of item.extra.transcript.segments) {
      lines.push(`${indent}[${clock(seg.start)}] ${seg.text}`);
    }
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

// A plain-text rendering of a Thread, for pasting into a prompt or a terminal: the post, the author's thread under it, then the comment tree indented four spaces per level
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
