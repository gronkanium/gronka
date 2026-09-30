import { writable, get } from 'svelte/store';
import { groupIssues } from '../issues.js';

export const navStats = writable(null);
export const savedViews = writable([]);
export const issueStates = writable({});

const DAY = 24 * 3600 * 1000;
const json = url => fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(url))));

export async function refreshNav() {
  const since = Date.now() - DAY;
  const [req, facets, issues, stats, system] = await Promise.all([
    json(`/api/requests?dateFrom=${since}&limit=5000`).catch(() => null),
    json(`/api/logs/facets?startTime=${since}`).catch(() => null),
    json('/api/alerts/summary?reasonLimit=300').catch(() => null),
    json('/api/stats').catch(() => null),
    json('/api/system').catch(() => null),
  ]);
  const ops = req?.requests ?? [];
  const byType = {};
  for (const op of ops) byType[op.type] = (byType[op.type] || 0) + 1;
  navStats.set({
    requests: {
      total: ops.length,
      failed: ops.filter(op => op.status === 'error').length,
      slow: ops.filter(op => (op.performanceMetrics?.duration ?? 0) > 10000).length,
      byType,
    },
    logs: facets?.facets ?? {},
    issues: groupIssues(issues?.byReason ?? []),
    users: stats?.ever_active_users,
    paused: !!system?.jobs?.paused,
  });
}

export function startNavStats() {
  refreshNav();
  loadViews();
  const timer = setInterval(refreshNav, 60_000);
  return () => clearInterval(timer);
}

async function loadViews() {
  try {
    const { settings } = await json('/api/settings');
    savedViews.set(JSON.parse(settings.webui_saved_views?.value || '[]'));
    issueStates.set(JSON.parse(settings.webui_issue_states?.value || '{}'));
  } catch {
    savedViews.set([]);
  }
}

async function storeViews(views) {
  const res = await fetch('/api/settings/webui_saved_views', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: views }),
  });
  if (!res.ok) throw new Error('could not save view');
  savedViews.set(views);
}

export function saveView(view) {
  return storeViews([...get(savedViews).filter(v => v.name !== view.name), view]);
}

export function removeView(name) {
  return storeViews(get(savedViews).filter(v => v.name !== name));
}

// state: { state: 'muted', until } | { state: 'resolved', at } | null to reopen.
export async function setIssueState(key, state) {
  const next = { ...get(issueStates) };
  if (state) next[key] = state;
  else delete next[key];
  const res = await fetch('/api/settings/webui_issue_states', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: next }),
  });
  if (!res.ok) throw new Error('could not save issue state');
  issueStates.set(next);
}
