import { formatDuration } from './utils/format.js';

const STEP_LABELS = {
  pending: 'received',
  running: 'started',
  success: 'delivered',
  error: 'failed',
};

const LEVEL = { ERROR: 'ERR', WARN: 'WARN', INFO: 'INFO', DEBUG: 'DBG', TRACE: 'TRC' };

// One timeline from the operation's status steps plus every log line stamped with this request.
export function buildTimeline(op, trace, logs) {
  if (!op) return null;
  const events = [
    ...(trace?.logs ?? []).map(s => ({
      at: s.timestamp,
      label:
        s.step === 'created'
          ? `received /${op.type}`
          : s.status === 'error'
            ? `failed: ${s.message}`
            : (STEP_LABELS[s.status] ?? s.message),
      kind: s.status === 'error' ? 'err' : s.status === 'success' ? 'ok' : 'step',
      group: 'bot',
      component: 'operation',
      source: 'trace',
      raw: s,
    })),
    ...logs.map(l => ({
      at: l.timestamp,
      label: l.message,
      kind: l.level === 'ERROR' ? 'err' : l.level === 'WARN' ? 'warn' : 'log',
      component: l.component,
      group: l.metadata?.worker ?? 'bot',
      source: 'log',
      level: l.level,
      raw: l,
    })),
  ].sort((a, b) => a.at - b.at);
  if (!events.length) return null;
  const start = events[0].at;
  const end = Math.max(events.at(-1).at, op.latestTimestamp ?? 0, start + 1);
  const span = end - start;
  const groups = [];
  events.forEach((e, i) => {
    const next = events[i + 1]?.at ?? end;
    const row = {
      ...e,
      index: i,
      left: ((e.at - start) / span) * 100,
      width: Math.max(0.6, ((next - e.at) / span) * 100),
      took: next - e.at,
      offset: e.at - start,
    };
    if (groups.at(-1)?.group !== e.group) groups.push({ group: e.group, start: e.at, rows: [] });
    groups.at(-1).rows.push(row);
  });
  return { span, start, groups };
}

// The waterfall tree: one parent row per group (bot gateway, each worker attempt), spans under it.
export function buildTree(timeline) {
  const groups = [];
  const spans = [];
  if (!timeline) return { groups, spans };
  let attempt = 0;
  timeline.groups.forEach((g, gi) => {
    const bot = g.group === 'bot';
    if (!bot) attempt++;
    const last = g.rows.at(-1);
    const offset = g.rows[0].offset;
    const kids = g.rows.map((r, ri) => ({
      ...r,
      type: 'span',
      key: String(r.index),
      gi,
      bot,
      worker: bot ? (r.raw?.metadata?.worker ?? null) : g.group,
      last: ri === g.rows.length - 1,
      tone: r.kind === 'err' ? 'err' : r.kind === 'warn' ? 'warn' : bot ? 'bot' : 'worker',
    }));
    spans.push(...kids);
    groups.push({
      type: 'group',
      key: `g${gi}`,
      gi,
      bot,
      worker: bot ? null : g.group,
      label: bot ? 'Bot gateway' : `Attempt ${attempt} · ${g.group}`,
      at: g.start,
      offset,
      took: last.offset + last.took - offset,
      kids,
      errors: kids.filter(k => k.tone === 'err').length,
      tone: bot ? 'bot' : 'worker',
    });
  });
  return { groups, spans };
}

// Splits text around each case-insensitive occurrence of needle (already lowercased).
export function highlight(text, needle) {
  const s = String(text ?? '');
  if (!needle) return [{ t: s }];
  const lo = s.toLowerCase();
  const out = [];
  let i = 0;
  for (;;) {
    const j = lo.indexOf(needle, i);
    if (j < 0) {
      if (i < s.length) out.push({ t: s.slice(i) });
      return out;
    }
    if (j > i) out.push({ t: s.slice(i, j) });
    out.push({ t: s.slice(j, j + needle.length), m: true });
    i = j + needle.length;
  }
}

export const fmtDur = ms =>
  ms < 1000
    ? `${Math.round(ms)}ms`
    : ms < 10e3
      ? `${(ms / 1000).toFixed(2)}s`
      : ms < 60e3
        ? `${(ms / 1000).toFixed(1)}s`
        : formatDuration(ms);

export const plus = ms => `+${fmtDur(ms)}`;
export const plusFine = ms => (ms < 1000 ? `+${ms.toFixed(1)}ms` : `+${(ms / 1000).toFixed(2)}s`);

export const pctOf = (ms, span) => {
  const p = span ? (ms / span) * 100 : 0;
  return p > 0 && p < 0.1 ? '<0.1%' : `${p.toFixed(1)}%`;
};

export const levelOf = r =>
  r.source === 'trace' ? 'STEP' : (LEVEL[r.level] ?? String(r.level ?? 'LOG').slice(0, 5));

export function spanAttrs(r) {
  if (r?.type !== 'span') return [];
  const raw = r.raw ?? {};
  const base =
    r.source === 'log'
      ? { id: raw.id, level: raw.level, component: raw.component, ...(raw.metadata ?? {}) }
      : {
          source: 'operation trace',
          ...Object.fromEntries(Object.entries(raw).filter(([k]) => k !== 'message')),
        };
  return Object.entries(base)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
}
