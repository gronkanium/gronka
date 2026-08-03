<script>
  import { onMount } from 'svelte';
  import { alerts as wsAlerts, connected as wsConnected } from '../stores/sse-store.js';
  import { navigate } from '../utils/router.js';
  import {
    formatTimestamp,
    formatRelativeTime,
    formatDuration,
    timeRangeToStartTime,
  } from '../utils/format.js';
  import Pagination from '../components/Pagination.svelte';

  // Matches UNKNOWN_REASON in alerts-pg.js — failures logged with no error string
  // are a real bucket, not an absence, so they get a filterable identity.
  const UNKNOWN_REASON = '__no_reason__';

  let mode = 'failures';

  let summary = null;
  let summaryLoading = true;
  let summaryError = null;

  let alerts = [];
  let total = 0;
  let loading = true;
  let error = null;

  let selectedCommand = '';
  let searchQuery = '';
  let timeRange = '24h';
  let limit = 100;
  let offset = 0;

  let commands = [];

  let expandedReason = null;
  let reasonAlerts = [];
  let reasonLoading = false;
  let expandedIds = new Set();

  $: filtersActive = Boolean(selectedCommand || searchQuery || timeRange !== '24h');
  $: failureRate = summary && summary.total ? (summary.errors / summary.total) * 100 : 0;
  $: worstCommand = summary?.byCommand?.find(entry => entry.errors > 0) ?? null;

  function filterParams(extra = {}) {
    const params = new URLSearchParams();
    if (selectedCommand) params.append('command', selectedCommand);
    if (searchQuery) params.append('search', searchQuery);

    const startTime = timeRangeToStartTime(timeRange);
    if (startTime) params.append('startTime', startTime.toString());

    for (const [key, value] of Object.entries(extra)) {
      if (value !== null && value !== undefined) params.append(key, value.toString());
    }
    return params;
  }

  async function fetchSummary() {
    summaryLoading = true;
    summaryError = null;
    try {
      const response = await fetch(`/api/alerts/summary?${filterParams()}`);
      if (!response.ok) throw new Error('failed to fetch alert summary');
      summary = await response.json();
    } catch (err) {
      summaryError = err.message;
    } finally {
      summaryLoading = false;
    }
  }

  async function fetchAlerts() {
    loading = true;
    error = null;
    try {
      const params = filterParams({ limit, offset });
      if (mode === 'failures') params.append('severity', 'error');

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

  async function fetchReasonAlerts(reason) {
    reasonLoading = true;
    try {
      const params = filterParams({ severity: 'error', limit: 50 });
      params.append('reason', reason ?? UNKNOWN_REASON);

      const response = await fetch(`/api/alerts?${params}`);
      if (!response.ok) throw new Error('failed to fetch occurrences');

      const data = await response.json();
      reasonAlerts = data.alerts || [];
    } catch {
      reasonAlerts = [];
    } finally {
      reasonLoading = false;
    }
  }

  async function fetchCommands() {
    try {
      const response = await fetch('/api/alerts/commands');
      if (!response.ok) throw new Error('failed to fetch alert commands');
      const data = await response.json();
      commands = data.commands || [];
    } catch (err) {
      console.error('Error fetching alert commands:', err);
    }
  }

  function refetch() {
    offset = 0;
    expandedReason = null;
    reasonAlerts = [];
    fetchSummary();
    if (mode === 'stream') fetchAlerts();
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    offset = 0;
    expandedReason = null;
    if (mode === 'stream') fetchAlerts();
  }

  function handleClearFilters() {
    selectedCommand = '';
    searchQuery = '';
    timeRange = '24h';
    refetch();
  }

  function handlePage(event) {
    offset = event.detail.offset;
    fetchAlerts();
  }

  function toggleReason(reason) {
    const key = reason ?? UNKNOWN_REASON;
    if (expandedReason === key) {
      expandedReason = null;
      reasonAlerts = [];
      return;
    }
    expandedReason = key;
    reasonAlerts = [];
    fetchReasonAlerts(reason);
  }

  function toggleAlert(id) {
    if (expandedIds.has(id)) expandedIds.delete(id);
    else expandedIds.add(id);
    expandedIds = new Set(expandedIds);
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

  function goToUser(userId, event) {
    event.stopPropagation();
    navigate('users', { userId });
  }

  // The stored message is "<username>: <command> failed - <reason>"; the reason is
  // already its own column in the grouped view, so drop the tail here.
  function shortMessage(alert) {
    const message = alert.message || '';
    const cut = message.indexOf(' - ');
    return cut === -1 ? message : message.slice(0, cut);
  }

  function matchesFilters(alert) {
    if (mode === 'failures' && alert.severity !== 'error') return false;
    const metadata = parseMetadata(alert);
    if (selectedCommand && metadata?.command !== selectedCommand) return false;
    const startTime = timeRangeToStartTime(timeRange);
    if (startTime && alert.timestamp < startTime) return false;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const haystack = `${alert.title ?? ''} ${alert.message ?? ''} ${alert.metadata ?? ''}`;
      if (!haystack.toLowerCase().includes(query)) return false;
    }
    return true;
  }

  onMount(() => {
    fetchSummary();
    fetchCommands();

    // Subscribe to SSE alerts (connection managed by App.svelte)
    const unsubscribe = wsAlerts.subscribe(newAlerts => {
      // The store prepends new alerts; walk from the front until we hit one we know
      for (const incoming of newAlerts) {
        const exists = alerts.some(
          alert =>
            (alert.id !== undefined && alert.id === incoming.id) ||
            (alert.timestamp === incoming.timestamp && alert.title === incoming.title)
        );
        if (exists) break;
        if (!matchesFilters(incoming)) continue;
        if (mode === 'stream' && offset === 0) {
          alerts = [incoming, ...alerts].slice(0, limit);
          total += 1;
        }
        // A new failure invalidates every aggregate on screen
        if (incoming.severity === 'error') fetchSummary();
      }
    });

    return () => {
      unsubscribe();
    };
  });
</script>

<div class="alerts-container">
  <div class="toolbar">
    <div class="mode-switch" role="group" aria-label="view mode">
      <button class:active={mode === 'failures'} on:click={() => setMode('failures')}>
        failures
      </button>
      <button class:active={mode === 'stream'} on:click={() => setMode('stream')}>
        all activity
      </button>
    </div>

    <div class="ws-status" class:connected={$wsConnected}>
      {$wsConnected ? '● live' : '○ disconnected'}
    </div>
  </div>

  <div class="filters">
    <div class="filter-group">
      <label for="command-filter">command:</label>
      <select id="command-filter" bind:value={selectedCommand} on:change={refetch}>
        <option value="">all</option>
        {#each commands as command}
          <option value={command}>{command}</option>
        {/each}
      </select>
    </div>

    <div class="filter-group">
      <label for="time-range-filter">time range:</label>
      <select id="time-range-filter" bind:value={timeRange} on:change={refetch}>
        <option value="1h">last hour</option>
        <option value="6h">last 6 hours</option>
        <option value="24h">last 24 hours</option>
        <option value="7d">last 7 days</option>
        <option value="30d">last 30 days</option>
        <option value="">all time</option>
      </select>
    </div>

    <div class="filter-group search-group">
      <label for="search-input">search:</label>
      <input
        id="search-input"
        type="text"
        bind:value={searchQuery}
        on:keydown={e => e.key === 'Enter' && refetch()}
        placeholder="message, reason, or username..."
      />
      <button class="btn-small" on:click={refetch}>search</button>
    </div>

    {#if filtersActive}
      <div class="filter-actions">
        <button class="btn-small" on:click={handleClearFilters}>clear filters</button>
      </div>
    {/if}
  </div>

  {#if summaryError}
    <div class="state-error">error: {summaryError}</div>
  {:else if summary}
    <div class="stat-row">
      <div class="stat" class:bad={summary.errors > 0}>
        <span class="stat-value">{summary.errors}</span>
        <span class="stat-label">failures</span>
      </div>
      <div class="stat">
        <span class="stat-value">{failureRate.toFixed(1)}%</span>
        <span class="stat-label">of {summary.total} operations</span>
      </div>
      <div class="stat">
        <span class="stat-value">{worstCommand ? worstCommand.command : '—'}</span>
        <span class="stat-label">
          {worstCommand ? `worst command — ${worstCommand.errors} failed` : 'no failing command'}
        </span>
      </div>
      <div class="stat">
        <span class="stat-value">{summary.byReason.length}</span>
        <span class="stat-label">distinct causes</span>
      </div>
    </div>
  {/if}

  {#if mode === 'failures'}
    {#if summaryLoading && !summary}
      <div class="loading">loading failures...</div>
    {:else if summary && summary.byReason.length === 0}
      <div class="empty">no failures in this window</div>
    {:else if summary}
      <div class="reason-list">
        {#each summary.byReason as bucket (bucket.reason ?? UNKNOWN_REASON)}
          {@const key = bucket.reason ?? UNKNOWN_REASON}
          {@const expanded = expandedReason === key}
          {@const share = summary.errors ? (bucket.count / summary.errors) * 100 : 0}
          <div class="reason-item" class:expanded>
            <button class="reason-row" on:click={() => toggleReason(bucket.reason)}>
              <span class="expand-icon">{expanded ? '▾' : '▸'}</span>
              <span class="count-badge">{bucket.count}×</span>
              <span class="reason-text" class:unknown={!bucket.reason}>
                {bucket.reason ?? 'no reason recorded'}
              </span>
              {#each bucket.commands as command}
                <span class="command-chip">{command}</span>
              {/each}
              <span class="share" title="{share.toFixed(1)}% of failures in this window">
                {share.toFixed(0)}%
              </span>
              <span class="timestamp" title={formatTimestamp(bucket.lastSeen)}>
                {formatRelativeTime(bucket.lastSeen)}
              </span>
            </button>

            {#if expanded}
              <div class="reason-detail">
                {#if reasonLoading}
                  <div class="loading-inline">loading occurrences...</div>
                {:else if reasonAlerts.length === 0}
                  <div class="loading-inline">no occurrences found</div>
                {:else}
                  <table class="occurrences">
                    <thead>
                      <tr>
                        <th>when</th>
                        <th>user</th>
                        <th>what</th>
                        <th>duration</th>
                        <th>operation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each reasonAlerts as alert (alert.id)}
                        {@const metadata = parseMetadata(alert)}
                        <tr>
                          <td title={formatTimestamp(alert.timestamp)}>
                            {formatRelativeTime(alert.timestamp)}
                          </td>
                          <td>
                            {#if alert.user_id}
                              <button class="link-btn" on:click={e => goToUser(alert.user_id, e)}>
                                {metadata?.username ?? alert.user_id}
                              </button>
                            {:else}
                              <span class="dim">—</span>
                            {/if}
                          </td>
                          <td>{shortMessage(alert)}</td>
                          <td>
                            {metadata?.duration !== undefined
                              ? formatDuration(metadata.duration)
                              : '—'}
                          </td>
                          <td><code>{alert.operation_id ?? '—'}</code></td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                  {#if reasonAlerts.length >= 50}
                    <div class="loading-inline">showing the 50 most recent</div>
                  {/if}
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {:else if loading && alerts.length === 0}
    <div class="loading">loading alerts...</div>
  {:else if error}
    <div class="state-error">error: {error}</div>
    <button on:click={fetchAlerts}>retry</button>
  {:else if alerts.length === 0}
    <div class="empty">no alerts found</div>
  {:else}
    <div class="alerts-list">
      {#each alerts as alert (alert.id)}
        {@const expanded = expandedIds.has(alert.id)}
        {@const metadata = parseMetadata(alert)}
        <div class="alert-item severity-{alert.severity}" class:expanded>
          <button class="alert-row" on:click={() => toggleAlert(alert.id)}>
            <span class="expand-icon">{expanded ? '▾' : '▸'}</span>
            <span class="severity-badge severity-{alert.severity}">{alert.severity}</span>
            {#if metadata?.command}
              <span class="command-chip">{metadata.command}</span>
            {/if}
            <span class="alert-title">{alert.message}</span>
            <span class="timestamp" title={formatTimestamp(alert.timestamp)}>
              {formatRelativeTime(alert.timestamp)}
            </span>
          </button>

          {#if expanded}
            <div class="alert-detail">
              {#if alert.user_id}
                <div class="alert-meta">
                  user:
                  <button class="link-btn" on:click={e => goToUser(alert.user_id, e)}>
                    {metadata?.username ?? alert.user_id}
                  </button>
                </div>
              {/if}
              {#if metadata?.duration !== undefined}
                <div class="alert-meta">
                  duration: <code>{formatDuration(metadata.duration)}</code>
                </div>
              {/if}
              {#if alert.operation_id}
                <div class="alert-meta">operation id: <code>{alert.operation_id}</code></div>
              {/if}
              {#if metadata}
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

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .mode-switch {
    display: flex;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .mode-switch button {
    padding: 0.4rem 0.9rem;
    font-size: 0.85rem;
    background-color: var(--surface);
    color: var(--text-muted);
    border: none;
    cursor: pointer;
  }

  .mode-switch button:hover {
    color: var(--text-bright);
  }

  .mode-switch button.active {
    background-color: var(--surface-3);
    color: var(--text-bright);
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
  }

  .stat-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 0.75rem;
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.85rem 1rem;
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }

  .stat-value {
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--text-bright);
    line-height: 1.1;
  }

  .stat.bad .stat-value {
    color: var(--danger);
  }

  .stat-label {
    font-size: 0.8rem;
    color: var(--text-dim);
  }

  .reason-list,
  .alerts-list {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .reason-item,
  .alert-item {
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--danger);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .alert-item.severity-info {
    border-left-color: var(--success);
  }

  .alert-item.severity-warning {
    border-left-color: var(--warning);
  }

  .reason-row,
  .alert-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.55rem 0.75rem;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    color: var(--text);
    font-size: 0.9rem;
  }

  .reason-row:hover,
  .alert-row:hover {
    background-color: var(--surface-2);
  }

  .expand-icon {
    color: var(--text-dim);
    font-size: 0.75rem;
    width: 0.9rem;
    flex-shrink: 0;
  }

  .count-badge {
    min-width: 3.25rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--text-bright);
    flex-shrink: 0;
  }

  .reason-text {
    color: var(--text-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .reason-text.unknown {
    color: var(--text-dim);
    font-style: italic;
  }

  .share {
    font-size: 0.8rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
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

  .command-chip {
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

  .timestamp {
    color: var(--text-dim);
    font-size: 0.8rem;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .reason-detail,
  .alert-detail {
    padding: 0.75rem 1rem 1rem 2.25rem;
    border-top: 1px solid var(--surface-2);
  }

  .occurrences {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  .occurrences th {
    text-align: left;
    padding: 0.3rem 0.6rem 0.4rem 0;
    font-weight: 500;
    color: var(--text-dim);
    border-bottom: 1px solid var(--surface-2);
  }

  .occurrences td {
    padding: 0.35rem 0.6rem 0.35rem 0;
    color: var(--text);
    vertical-align: top;
  }

  .occurrences code {
    font-family: monospace;
    font-size: 0.8rem;
    color: var(--text-dim);
  }

  .dim {
    color: var(--text-dim);
  }

  .loading-inline {
    font-size: 0.85rem;
    color: var(--text-dim);
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

    .reason-row,
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
    }

    .reason-text,
    .alert-title {
      flex-basis: 100%;
      white-space: normal;
      order: 5;
    }

    .reason-detail,
    .alert-detail {
      padding-left: 0.75rem;
    }

    .occurrences {
      display: block;
      overflow-x: auto;
    }
  }
</style>
