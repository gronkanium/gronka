<script>
  import { onMount } from 'svelte';
  import { alerts as wsAlerts, connected as wsConnected } from '../stores/websocket-store.js';
  import { navigate } from '../utils/router.js';
  import {
    formatTimestamp,
    formatRelativeTime,
    formatDuration,
    timeRangeToStartTime,
  } from '../utils/format.js';
  import Pagination from '../components/Pagination.svelte';

  let alerts = [];
  let total = 0;
  let loading = true;
  let error = null;

  let selectedSeverity = '';
  let selectedComponent = '';
  let searchQuery = '';
  let timeRange = '';
  let groupRepeats = true;
  let limit = 100;
  let offset = 0;

  let components = [];
  const severities = ['info', 'warning', 'error'];

  let expandedKeys = new Set();

  async function fetchAlerts() {
    loading = true;
    error = null;
    try {
      const params = new URLSearchParams({
        limit: limit.toString(),
        offset: offset.toString(),
      });

      if (selectedSeverity) params.append('severity', selectedSeverity);
      if (selectedComponent) params.append('component', selectedComponent);
      if (searchQuery) params.append('search', searchQuery);

      const startTime = timeRangeToStartTime(timeRange);
      if (startTime) params.append('startTime', startTime.toString());

      const response = await fetch(`/api/alerts?${params}`);
      if (!response.ok) throw new Error('failed to fetch alerts');

      const data = await response.json();
      alerts = data.alerts || [];
      total = data.total || 0;
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  async function fetchComponents() {
    try {
      const response = await fetch('/api/alerts/components');
      if (!response.ok) throw new Error('failed to fetch alert components');
      const data = await response.json();
      components = data.components || [];
    } catch (err) {
      console.error('Error fetching alert components:', err);
    }
  }

  function refetch() {
    offset = 0;
    fetchAlerts();
  }

  function handleClearFilters() {
    selectedSeverity = '';
    selectedComponent = '';
    searchQuery = '';
    timeRange = '';
    refetch();
  }

  function handlePage(event) {
    offset = event.detail.offset;
    fetchAlerts();
  }

  function getSeverityClass(severity) {
    return severity ? severity.toLowerCase() : 'unknown';
  }

  function parseMetadata(alert) {
    if (!alert.metadata) return null;
    try {
      const parsed =
        typeof alert.metadata === 'string' ? JSON.parse(alert.metadata) : alert.metadata;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function alertKey(alert) {
    return alert.id ?? `${alert.timestamp}-${alert.component}-${alert.title}`;
  }

  function toggleExpanded(key) {
    if (expandedKeys.has(key)) {
      expandedKeys.delete(key);
    } else {
      expandedKeys.add(key);
    }
    expandedKeys = new Set(expandedKeys);
  }

  function goToUser(userId, event) {
    event.stopPropagation();
    navigate('users', { userId });
  }

  // Group alerts in the current page that share severity + component + title.
  // Each group keeps the newest alert as its representative plus a count.
  function groupAlerts(list) {
    const groups = [];
    const byKey = new Map();
    for (const alert of list) {
      const key = `${alert.severity}|${alert.component}|${alert.title}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
        existing.oldest = alert.timestamp;
      } else {
        const group = { alert, count: 1, oldest: alert.timestamp };
        byKey.set(key, group);
        groups.push(group);
      }
    }
    return groups;
  }

  $: displayGroups = groupRepeats
    ? groupAlerts(alerts)
    : alerts.map(alert => ({ alert, count: 1, oldest: alert.timestamp }));

  // Check if alert matches current filters (for live WS inserts)
  function matchesFilters(alert) {
    if (selectedSeverity && alert.severity !== selectedSeverity) return false;
    if (selectedComponent && alert.component !== selectedComponent) return false;
    const startTime = timeRangeToStartTime(timeRange);
    if (startTime && alert.timestamp < startTime) return false;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchesSearch =
        (alert.title && alert.title.toLowerCase().includes(query)) ||
        (alert.message && alert.message.toLowerCase().includes(query)) ||
        (alert.component && alert.component.toLowerCase().includes(query));
      if (!matchesSearch) return false;
    }
    return true;
  }

  function handleNewAlert(newAlert) {
    if (!matchesFilters(newAlert)) return;
    if (offset === 0) {
      alerts = [newAlert, ...alerts].slice(0, limit);
    }
    total += 1;
  }

  onMount(() => {
    fetchAlerts();
    fetchComponents();

    // Subscribe to WebSocket alerts (connection managed by App.svelte)
    const unsubscribe = wsAlerts.subscribe(newAlerts => {
      // The store prepends new alerts; walk from the front until we hit one we know
      for (const incoming of newAlerts) {
        const exists = alerts.some(
          alert =>
            (alert.id !== undefined && alert.id === incoming.id) ||
            (alert.timestamp === incoming.timestamp && alert.title === incoming.title)
        );
        if (exists) break;
        handleNewAlert(incoming);
      }
    });

    return () => {
      unsubscribe();
    };
  });
</script>

<div class="alerts-container">
  <div class="live-bar">
    <div class="ws-status" class:connected={$wsConnected}>
      {$wsConnected ? '● live' : '○ disconnected'}
    </div>
  </div>

  <div class="filters">
    <div class="filter-group">
      <label for="severity-filter">severity:</label>
      <select id="severity-filter" bind:value={selectedSeverity} on:change={refetch}>
        <option value="">all</option>
        {#each severities as severity}
          <option value={severity}>{severity}</option>
        {/each}
      </select>
    </div>

    <div class="filter-group">
      <label for="component-filter">component:</label>
      <select id="component-filter" bind:value={selectedComponent} on:change={refetch}>
        <option value="">all</option>
        {#each components as component}
          <option value={component}>{component}</option>
        {/each}
      </select>
    </div>

    <div class="filter-group">
      <label for="time-range-filter">time range:</label>
      <select id="time-range-filter" bind:value={timeRange} on:change={refetch}>
        <option value="">all time</option>
        <option value="1h">last hour</option>
        <option value="6h">last 6 hours</option>
        <option value="24h">last 24 hours</option>
        <option value="7d">last 7 days</option>
        <option value="30d">last 30 days</option>
      </select>
    </div>

    <div class="filter-group search-group">
      <label for="search-input">search:</label>
      <input
        id="search-input"
        type="text"
        bind:value={searchQuery}
        on:keydown={e => e.key === 'Enter' && refetch()}
        placeholder="search title or message..."
      />
      <button class="btn-small" on:click={refetch}>search</button>
    </div>

    <div class="filter-actions">
      <label class="group-toggle">
        <input type="checkbox" bind:checked={groupRepeats} />
        group repeats
      </label>
      <button class="btn-small" on:click={handleClearFilters}>clear filters</button>
    </div>
  </div>

  {#if loading && alerts.length === 0}
    <div class="loading">loading alerts...</div>
  {:else if error}
    <div class="state-error">error: {error}</div>
    <button on:click={fetchAlerts}>retry</button>
  {:else if alerts.length === 0}
    <div class="empty">no alerts found</div>
  {:else}
    <div class="alerts-list">
      {#each displayGroups as group (alertKey(group.alert))}
        {@const alert = group.alert}
        {@const key = alertKey(alert)}
        {@const expanded = expandedKeys.has(key)}
        {@const metadata = parseMetadata(alert)}
        <div class="alert-item severity-{getSeverityClass(alert.severity)}" class:expanded>
          <button class="alert-row" on:click={() => toggleExpanded(key)}>
            <span class="expand-icon">{expanded ? '▾' : '▸'}</span>
            <span class="severity-badge severity-{getSeverityClass(alert.severity)}"
              >{alert.severity}</span
            >
            <span class="component-badge">{alert.component}</span>
            <span class="alert-title">{alert.title}</span>
            {#if group.count > 1}
              <span class="repeat-badge" title="repeated {group.count}× in current page"
                >×{group.count}</span
              >
            {/if}
            <span class="timestamp" title={formatTimestamp(alert.timestamp)}>
              {formatRelativeTime(alert.timestamp)}
            </span>
          </button>

          {#if expanded}
            <div class="alert-detail">
              <div class="alert-message">{alert.message}</div>
              {#if group.count > 1}
                <div class="alert-meta">
                  repeated {group.count}× in this page — oldest
                  <span title={formatTimestamp(group.oldest)}
                    >{formatRelativeTime(group.oldest)}</span
                  >
                </div>
              {/if}
              {#if alert.operation_id}
                <div class="alert-meta">operation id: <code>{alert.operation_id}</code></div>
              {/if}
              {#if alert.user_id}
                <div class="alert-meta">
                  user id:
                  <button class="link-btn" on:click={e => goToUser(alert.user_id, e)}>
                    {alert.user_id}
                  </button>
                </div>
              {/if}
              {#if metadata}
                {#if metadata.duration !== undefined}
                  <div class="alert-meta">
                    duration: <code>{formatDuration(metadata.duration)}</code>
                  </div>
                {/if}
                <details class="alert-metadata">
                  <summary>metadata</summary>
                  <pre>{JSON.stringify(metadata, null, 2)}</pre>
                </details>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <Pagination {offset} {limit} {total} on:page={handlePage} />
  {/if}
</div>

<style>
  .alerts-container {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 1400px;
    margin-left: auto;
    margin-right: auto;
  }

  .live-bar {
    display: flex;
    justify-content: flex-end;
  }

  .ws-status {
    font-size: 0.85rem;
    color: var(--text-dim);
  }

  .ws-status.connected {
    color: var(--success);
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    padding: 1rem;
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }

  .filter-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .filter-group label {
    font-size: 0.85rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .filter-group select,
  .filter-group input[type='text'] {
    background-color: var(--surface-2);
    border: 1px solid var(--surface-3);
    color: var(--text-bright);
    padding: 0.4rem 0.6rem;
    font-size: 0.85rem;
    border-radius: var(--radius);
  }

  .filter-group select {
    min-width: 120px;
  }

  .search-group input[type='text'] {
    min-width: 250px;
  }

  .btn-small {
    padding: 0.4rem 0.8rem;
    font-size: 0.85rem;
    background-color: var(--surface-3);
    color: var(--text-bright);
    border: 1px solid var(--border-2);
    cursor: pointer;
    border-radius: var(--radius);
  }

  .btn-small:hover {
    background-color: var(--border-2);
  }

  .filter-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .group-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: var(--text-muted);
    cursor: pointer;
    white-space: nowrap;
  }

  .alerts-list {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .alert-item {
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--text-dim);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .alert-item.severity-info {
    border-left-color: var(--success);
  }

  .alert-item.severity-warning {
    border-left-color: var(--warning);
  }

  .alert-item.severity-error {
    border-left-color: var(--danger);
  }

  .alert-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    color: var(--text);
    font-size: 0.9rem;
  }

  .alert-row:hover {
    background-color: var(--surface-2);
  }

  .expand-icon {
    color: var(--text-dim);
    font-size: 0.75rem;
    width: 0.9rem;
    flex-shrink: 0;
  }

  .severity-badge {
    padding: 0.15rem 0.5rem;
    border-radius: var(--radius);
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;
    width: 4.5rem;
    text-align: center;
  }

  .severity-badge.severity-info {
    background-color: rgba(81, 207, 102, 0.2);
    color: var(--success);
  }

  .severity-badge.severity-warning {
    background-color: rgba(255, 217, 61, 0.2);
    color: var(--warning);
  }

  .severity-badge.severity-error {
    background-color: rgba(255, 107, 107, 0.2);
    color: var(--danger);
  }

  .component-badge {
    padding: 0.15rem 0.5rem;
    background-color: var(--surface-2);
    border-radius: var(--radius);
    font-size: 0.75rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .alert-title {
    color: var(--text-bright);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .repeat-badge {
    padding: 0.1rem 0.45rem;
    background-color: var(--surface-3);
    border: 1px solid var(--border-2);
    border-radius: var(--radius-lg);
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-bright);
    flex-shrink: 0;
  }

  .timestamp {
    margin-left: auto;
    color: var(--text-dim);
    font-size: 0.8rem;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .alert-detail {
    padding: 0.75rem 1rem 1rem 2.25rem;
    border-top: 1px solid var(--surface-2);
  }

  .alert-message {
    color: var(--text);
    font-size: 0.9rem;
    line-height: 1.6;
    margin-bottom: 0.5rem;
    word-break: break-word;
  }

  .alert-meta {
    font-size: 0.85rem;
    color: var(--text-dim);
    margin-top: 0.4rem;
  }

  .alert-meta code {
    background-color: var(--surface-2);
    padding: 0.2rem 0.4rem;
    border-radius: var(--radius);
    font-family: monospace;
    color: var(--success);
  }

  .link-btn {
    background: none;
    border: none;
    padding: 0;
    font-family: monospace;
    font-size: 0.85rem;
    color: var(--success);
    cursor: pointer;
    text-decoration: underline;
  }

  .link-btn:hover {
    color: var(--text-bright);
  }

  .alert-metadata {
    margin-top: 0.75rem;
  }

  .alert-metadata summary {
    cursor: pointer;
    color: var(--text-muted);
    font-size: 0.85rem;
    user-select: none;
  }

  .alert-metadata summary:hover {
    color: var(--text-bright);
  }

  .alert-metadata pre {
    margin-top: 0.5rem;
    padding: 1rem;
    background-color: var(--bg-deep);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow-x: auto;
    font-size: 0.8rem;
    color: var(--text);
  }

  .loading,
  .state-error,
  .empty {
    padding: 2rem;
    text-align: center;
  }

  .loading {
    color: var(--text-dim);
  }

  .state-error {
    color: var(--danger);
  }

  .empty {
    color: var(--text-dim);
  }

  @media (max-width: 768px) {
    button {
      min-height: 44px;
    }

    .alert-row {
      min-height: 44px;
      flex-wrap: wrap;
    }

    .filters {
      flex-direction: column;
      align-items: stretch;
    }

    .filter-group {
      flex-direction: column;
      align-items: stretch;
    }

    .filter-group select,
    .filter-group input[type='text'] {
      width: 100%;
    }

    .filter-actions {
      margin-left: 0;
      justify-content: space-between;
    }

    .alert-title {
      flex-basis: 100%;
      white-space: normal;
      order: 5;
    }

    .timestamp {
      margin-left: 0;
    }
  }
</style>
