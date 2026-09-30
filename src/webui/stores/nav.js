import { writable, get } from 'svelte/store';

export const navStats = writable(null);
export const savedViews = writable([]);

const DAY = 24 * 3600 * 1000;
const json = url => fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(url))));

async function refreshStats() {
  const since = Date.now() - DAY;
  const [req, facets, issues, stats] = await Promise.all([
    json(`/api/requests?dateFrom=${since}&limit=5000`).catch(() => null),
    json(`/api/logs/facets?startTime=${since}`).catch(() => null),
    json('/api/alerts/summary?reasonLimit=100').catch(() => null),
    json('/api/stats').catch(() => null),
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
    issues: issues?.byReason ?? [],
    users: stats?.ever_active_users,
  });
}

export function startNavStats() {
  refreshStats();
  loadViews();
  const timer = setInterval(refreshStats, 60_000);
  return () => clearInterval(timer);
}

async function loadViews() {
  try {
    const { settings } = await json('/api/settings');
    savedViews.set(JSON.parse(settings.webui_saved_views?.value || '[]'));
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
