// Issue grouping, classification and state, shared by the Issues page, Overview and the nav.

// What the bot recorded for a failure: an error class, or an early refusal's reason code.
const USER = new Set([
  'ValidationError',
  'invalid_url',
  'missing_url',
  'missing_input',
  'multiple_inputs',
  'invalid_attachment',
  'invalid_lossy_level',
  'unsupported_format',
  'ytdlp_disabled',
  'gallery_dl_disabled',
  'cobalt_disabled',
]);
const UPSTREAM = new Set(['NetworkError', 'YtdlpRateLimitError', 'url_download_failed']);

// Fallback for failures with nothing recorded (early refusals before refuse() recorded them).
const GUESSES = [
  [
    'user',
    /not from a supported|no video or image attachment|please provide|invalid url|not a valid|too large|too long|maximum allowed|exceeds the maximum|no video in it|private or internal address|only works on|unsupported content type|wait \d|rate limit|cooldown|banned|maintenance/i,
  ],
  [
    'upstream',
    /changed its page|is blocking|deleted, private|unavailable|removed|age-restricted|age verification|sign-in|login required|members-only|blocked|not found at the provided|not available in your/i,
  ],
];

export const KIND_LABEL = { defect: 'defect', upstream: 'upstream', user: 'user error' };

// Variants of one cause differ only in numbers or a charset suffix.
export const keyOf = reason =>
  reason
    .toLowerCase()
    .replace(/;\s*charset=[\w-]+/g, '')
    .replace(/\d+(\.\d+)?/g, '#')
    .trim();

function classify(classes, text) {
  if (classes.length) {
    const kinds = classes.map(c =>
      USER.has(c) ? 'user' : UPSTREAM.has(c) ? 'upstream' : 'defect'
    );
    const kind = kinds.includes('defect')
      ? 'defect'
      : kinds.includes('upstream')
        ? 'upstream'
        : 'user';
    return { kind, basis: `from the recorded error (${classes.join(', ')})` };
  }
  return {
    kind: GUESSES.find(([, re]) => re.test(text))?.[0] ?? 'defect',
    basis: 'by a guess from the message',
  };
}

export function groupIssues(byReason = []) {
  const groups = new Map();
  for (const r of byReason) {
    if (!r.reason) continue;
    const key = keyOf(r.reason);
    const g = groups.get(key) ?? {
      key,
      members: [],
      count: 0,
      lastSeen: 0,
      firstSeen: Infinity,
      commands: new Set(),
      classes: new Set(),
    };
    g.members.push(r.reason);
    g.count += r.count;
    g.lastSeen = Math.max(g.lastSeen, r.lastSeen);
    g.firstSeen = Math.min(g.firstSeen, r.firstSeen ?? r.lastSeen);
    r.commands.forEach(c => g.commands.add(c));
    (r.classes ?? []).forEach(c => g.classes.add(c));
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(g => {
      const classes = [...g.classes];
      return {
        ...g,
        title: g.members.length > 1 ? g.key.replace(/#/g, 'N') : g.members[0],
        commands: [...g.commands],
        classes,
        ...classify(classes, g.members[0]),
      };
    })
    .sort((a, b) => b.count - a.count);
}

// muted until a time; resolved at a time and reopened ("regressed") if it happens again after.
export function stateOf(group, states = {}, now = Date.now()) {
  const s = states[group.key];
  if (s?.state === 'muted' && s.until > now) return 'muted';
  if (s?.state === 'resolved') return group.lastSeen > s.at ? 'regressed' : 'resolved';
  return 'open';
}

export const isNew = (group, now = Date.now()) => group.firstSeen > now - 24 * 3600e3;

export const isOpen = (group, states) => ['open', 'regressed'].includes(stateOf(group, states));

const TAB_KIND = { defects: 'defect', upstream: 'upstream', user: 'user' };

export const inTab = (tab, group, state) =>
  tab === 'muted' || tab === 'resolved'
    ? state === tab
    : ['open', 'regressed'].includes(state) && (!TAB_KIND[tab] || TAB_KIND[tab] === group.kind);

const HOUR = 3600e3;
const DAY = 24 * HOUR;

// n hourly or daily buckets ending with the one that holds `at`, in local time.
export function buckets(times, unit, n, at) {
  const size = unit === 'day' ? DAY : HOUR;
  const start = new Date(at);
  if (unit === 'day') start.setHours(0, 0, 0, 0);
  else start.setMinutes(0, 0, 0);
  const first = start.getTime() - (n - 1) * size;
  const out = Array.from({ length: n }, (_, i) => ({ at: first + i * size, n: 0 }));
  for (const t of times) {
    const i = Math.floor((t - first) / size);
    if (i >= 0 && i < n) out[i].n++;
  }
  return out;
}

export function abbr(n) {
  if (n == null) return '–';
  if (n < 1000) return String(n);
  if (n < 1e4) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1e6) return `${Math.round(n / 1e3)}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}
