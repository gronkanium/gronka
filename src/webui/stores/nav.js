import { getJson, getJsonOrNull } from '../utils/api.js';
import { writable, get } from 'svelte/store';
import { groupIssues } from '../issues.js';
import { poll } from '../utils/poll.js';

export const navStats = writable(null);
export const issueStates = writable({});

export async function refreshNav() {
  const [issues, system] = await Promise.all([
    getJsonOrNull('/api/alerts/summary?reasonLimit=300'),
    getJsonOrNull('/api/system'),
  ]);
  navStats.set({
    issues: groupIssues(issues?.byReason ?? []),
    paused: !!system?.jobs?.paused,
    version: system?.version ?? null,
  });
}

export function startNavStats() {
  refreshNav();
  loadIssueStates();
  return poll(refreshNav, 60_000);
}

async function loadIssueStates() {
  try {
    const { settings } = await getJson('/api/settings');
    issueStates.set(JSON.parse(settings.webui_issue_states?.value || '{}'));
  } catch {
    issueStates.set({});
  }
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
