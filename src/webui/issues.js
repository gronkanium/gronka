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
    return { kind, basis: `recorded as ${classes.join(', ')}` };
  }
  return {
    kind: GUESSES.find(([, re]) => re.test(text))?.[0] ?? 'defect',
    basis: 'guessed from the message',
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
      commands: new Set(),
      classes: new Set(),
    };
    g.members.push(r.reason);
    g.count += r.count;
    g.lastSeen = Math.max(g.lastSeen, r.lastSeen);
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

export const isOpen = (group, states) => ['open', 'regressed'].includes(stateOf(group, states));
