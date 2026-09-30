<script module>
  /**
   * Level badge for the Logs explorer, plus the helpers every Log* component shares: the level
   * palette, timestamp formats, a stable colour per component and query-term highlighting.
   */
  export const LEVELS = {
    ERROR: { short: 'ERR', name: 'error', color: 'var(--danger)', text: 'var(--danger-text)' },
    WARN: { short: 'WRN', name: 'warn', color: 'var(--warning)', text: 'var(--warning-text)' },
    INFO: { short: 'INF', name: 'info', color: 'var(--info)', text: 'var(--accent)' },
    DEBUG: { short: 'DBG', name: 'debug', color: 'var(--text-dim)', text: 'var(--text-muted)' },
  };
  export const SEVERITY = ['ERROR', 'WARN', 'INFO', 'DEBUG'];

  export function lv(level) {
    const key = String(level ?? '').toUpperCase();
    return (
      LEVELS[key] ?? {
        short: key.slice(0, 3) || '—',
        name: key.toLowerCase(),
        color: 'var(--text-dim)',
        text: 'var(--text-muted)',
      }
    );
  }

  // Fields the API filters on, with what they hold (shown in the query bar's autocomplete).
  export const FIELDS = ['level', 'component', 'source', 'command', 'worker', 'op', 'user', 'job'];
  export const FIELD_HINTS = {
    level: 'error, warn, info, debug',
    component: 'part of the bot that wrote it',
    source: 'site the link points at',
    command: 'slash command',
    worker: 'worker process',
    op: 'request id',
    user: 'Discord user id',
    job: 'queue job id',
  };
  // A line's value for a field: level and component are columns, the rest live in metadata.
  export const fieldOf = (line, key) =>
    key === 'level' || key === 'component' ? line[key] : line.metadata?.[key];
  // Level values are stored upper case; compare them without caring.
  export const sameValue = (key, a, b) =>
    key === 'level' ? String(a).toUpperCase() === String(b).toUpperCase() : String(a) === String(b);
  export const shown = (key, v) => (key === 'level' ? String(v).toLowerCase() : String(v));

  const p = (n, w = 2) => String(n).padStart(w, '0');
  export const clock = t => {
    const d = new Date(t);
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };
  export const day = t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  // "Sep 30 14:02:11.482"
  export const stamp = t => `${day(t)} ${clock(t)}`;
  // "Sep 30, 2026 14:02:11.482"
  export const fullStamp = t =>
    `${new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} ${clock(t)}`;
  export const utc = t => new Date(t).toISOString().replace('T', ' ').replace('Z', ' UTC');

  // Components get a colour from a small palette that avoids the level hues (red, amber).
  const PALETTE = [
    'var(--chart-1)',
    'var(--chart-2)',
    'var(--chart-5)',
    'color-mix(in srgb, var(--chart-1) 50%, var(--chart-2))',
    'color-mix(in srgb, var(--chart-2) 55%, var(--chart-3))',
    'var(--text-muted)',
    'color-mix(in srgb, var(--chart-5) 50%, var(--chart-1))',
  ];
  export function compColor(name) {
    let h = 7;
    for (const c of String(name ?? '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  // Splits text around case-insensitive matches of q: [{ text, hit }].
  export function highlight(text, q) {
    const s = String(text ?? '');
    if (!q) return [{ text: s, hit: false }];
    const lower = s.toLowerCase();
    const needle = q.toLowerCase();
    const out = [];
    let at = 0;
    for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, at)) {
      if (i > at) out.push({ text: s.slice(at, i), hit: false });
      out.push({ text: s.slice(i, i + needle.length), hit: true });
      at = i + needle.length;
    }
    if (at < s.length) out.push({ text: s.slice(at), hit: false });
    return out;
  }
</script>

<script>
  let { level, long = false } = $props();
  const l = $derived(lv(level));
</script>

<span class="lvl-badge" style="--lc:{l.color};--lt:{l.text}" title={l.name}
  >{long ? l.name : l.short}</span
>

<style>
  .lvl-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 18px;
    min-width: 32px;
    padding: 0 4px;
    border-radius: 4px;
    font: 700 10px/1 var(--mono);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--lt);
    background: color-mix(in srgb, var(--lc) 12%, transparent);
    flex-shrink: 0;
  }
</style>
