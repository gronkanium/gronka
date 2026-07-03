<script>
  import { onMount } from 'svelte';
  import { logs as wsLogs, connected as wsConnected } from '../stores/websocket-store.js';
  import { formatTimestamp, formatRelativeTime, timeRangeToStartTime } from '../utils/format.js';
  import Pagination from '../components/Pagination.svelte';

  let logs = [];
  let total = 0;
  let loading = true;
  let error = null;

  // Filters
  let selectedComponent = '';
  let excludedComponents = [];
  let selectedLevels = ['ERROR', 'WARN', 'INFO'];
  let searchQuery = '';
  let timeRange = '';
  let liveUpdates = true;

  // Pagination
  let limit = 50;
  let offset = 0;

  // Components list for dropdown/exclude chips
  let components = [];

  let expandedIds = new Set();

  const levelDefs = [
    { level: 'ERROR', label: 'err', cls: 'error' },
    { level: 'WARN', label: 'wrn', cls: 'warn' },
    { level: 'INFO', label: 'inf', cls: 'info' },
    { level: 'DEBUG', label: 'dbg', cls: 'debug' },
  ];

  function getLevelClass(level) {
    return level ? level.toLowerCase() : 'unknown';
  }

  async function fetchLogs() {
    loading = true;
    error = null;
    try {
      const params = new URLSearchParams({
        limit: limit.toString(),
        offset: offset.toString(),
      });

      if (selectedComponent) params.append('component', selectedComponent);
      if (selectedLevels.length > 0) params.append('level', selectedLevels.join(','));
      if (searchQuery) params.append('search', searchQuery);
      if (excludedComponents.length > 0)
        params.append('excludedComponents', excludedComponents.join(','));

      const startTime = timeRangeToStartTime(timeRange);
      if (startTime) params.append('startTime', startTime.toString());

      const response = await fetch(`/api/logs?${params}`);
      if (!response.ok) throw new Error('Failed to fetch logs');

      const data = await response.json();
      logs = data.logs || [];
      total = data.total || 0;
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  async function fetchComponents() {
    try {
      const response = await fetch('/api/logs/components');
      if (!response.ok) throw new Error('Failed to fetch components');

      const data = await response.json();
      components = data.components || [];
    } catch (err) {
      console.error('Error fetching components:', err);
    }
  }

  function refetch() {
    offset = 0;
    fetchLogs();
  }

  function handleLevelToggle(level) {
    if (selectedLevels.includes(level)) {
      selectedLevels = selectedLevels.filter(l => l !== level);
    } else {
      selectedLevels = [...selectedLevels, level];
    }
    refetch();
  }

  function handleComponentChange() {
    // Including a specific component makes exclusions moot
    if (selectedComponent) excludedComponents = [];
    refetch();
  }

  function handleExcludedComponentToggle(component) {
    if (excludedComponents.includes(component)) {
      excludedComponents = excludedComponents.filter(c => c !== component);
    } else {
      excludedComponents = [...excludedComponents, component];
      if (selectedComponent === component) selectedComponent = '';
    }
    refetch();
  }

  function handleClearFilters() {
    selectedComponent = '';
    excludedComponents = [];
    selectedLevels = ['ERROR', 'WARN', 'INFO'];
    searchQuery = '';
    timeRange = '';
    refetch();
  }

  function handlePage(event) {
    offset = event.detail.offset;
    fetchLogs();
  }

  function toggleExpanded(id) {
    if (expandedIds.has(id)) {
      expandedIds.delete(id);
    } else {
      expandedIds.add(id);
    }
    expandedIds = new Set(expandedIds);
  }

  function formatMetadata(metadata) {
    if (typeof metadata !== 'string') return JSON.stringify(metadata, null, 2);
    try {
      return JSON.stringify(JSON.parse(metadata), null, 2);
    } catch {
      return metadata;
    }
  }

  // Exports the currently visible page of logs
  function exportPage(format) {
    if (logs.length === 0) return;

    if (format === 'json') {
      const dataStr = JSON.stringify(logs, null, 2);
      downloadBlob(new Blob([dataStr], { type: 'application/json' }), `logs-${Date.now()}.json`);
    } else if (format === 'csv') {
      const headers = ['timestamp', 'level', 'component', 'message'];
      const csvContent = [
        headers.join(','),
        ...logs.map(log =>
          headers
            .map(h => {
              const value = h === 'timestamp' ? new Date(log[h]).toISOString() : log[h] || '';
              return `"${String(value).replace(/"/g, '""')}"`;
            })
            .join(',')
        ),
      ].join('\n');
      downloadBlob(new Blob([csvContent], { type: 'text/csv' }), `logs-${Date.now()}.csv`);
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Check if a log entry matches current filters (for live WS inserts)
  function matchesFilters(logEntry) {
    if (selectedComponent && logEntry.component !== selectedComponent) return false;
    if (excludedComponents.includes(logEntry.component)) return false;
    if (selectedLevels.length > 0 && !selectedLevels.includes(logEntry.level)) return false;
    const startTime = timeRangeToStartTime(timeRange);
    if (startTime && logEntry.timestamp < startTime) return false;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchesSearch =
        (logEntry.message && logEntry.message.toLowerCase().includes(query)) ||
        (logEntry.component && logEntry.component.toLowerCase().includes(query));
      if (!matchesSearch) return false;
    }
    return true;
  }

  function handleNewLog(newLog) {
    if (!matchesFilters(newLog)) return;
    if (offset === 0) {
      logs = [newLog, ...logs].slice(0, limit);
    }
    total += 1;
  }

  onMount(() => {
    fetchLogs();
    fetchComponents();

    // Subscribe to WebSocket logs (connection managed by App.svelte)
    const unsubscribe = wsLogs.subscribe(newLogs => {
      if (!liveUpdates) return;
      // The store prepends new logs; walk from the front until we hit one we know
      for (const incoming of newLogs) {
        const exists = logs.some(
          log =>
            (log.id !== undefined && log.id === incoming.id) ||
            (log.timestamp === incoming.timestamp && log.message === incoming.message)
        );
        if (exists) break;
        handleNewLog(incoming);
      }
    });

    return () => {
      unsubscribe();
    };
  });
</script>

<section class="logs">
  <div class="filters">
    <div class="filter-group">
      <label for="component-filter">component:</label>
      <select id="component-filter" bind:value={selectedComponent} on:change={handleComponentChange}>
        <option value="">all</option>
        {#each components as component}
          <option value={component}>{component}</option>
        {/each}
      </select>
    </div>

    <div class="filter-group">
      <!-- svelte-ignore a11y_label_has_associated_control -->
      <label>level:</label>
      <div class="level-toggles">
        {#each levelDefs as def}
          <button
            class="level-btn {def.cls}"
            class:active={selectedLevels.includes(def.level)}
            on:click={() => handleLevelToggle(def.level)}
          >
            <span class="level-icon">●</span><span class="level-text">{def.label}</span>
          </button>
        {/each}
      </div>
    </div>

    <div class="filter-group search-group">
      <label for="search-input">search:</label>
      <input
        id="search-input"
        type="text"
        bind:value={searchQuery}
        on:keydown={e => e.key === 'Enter' && refetch()}
        placeholder="search messages..."
      />
      <button class="btn-small" on:click={refetch}>search</button>
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

    <div class="filter-actions">
      <label class="live-toggle" title="pause/resume live log streaming">
        <input type="checkbox" bind:checked={liveUpdates} />
        <span class="ws-status" class:connected={$wsConnected && liveUpdates}>
          {#if !$wsConnected}
            ○ disconnected
          {:else if liveUpdates}
            ● live
          {:else}
            ⏸ paused
          {/if}
        </span>
      </label>
      <button class="btn-small" on:click={handleClearFilters}>clear filters</button>
      <div class="export-buttons">
        <button class="btn-small" on:click={() => exportPage('json')} title="exports the current page only">export page json</button>
        <button class="btn-small" on:click={() => exportPage('csv')} title="exports the current page only">export page csv</button>
      </div>
    </div>

    {#if !selectedComponent && components.length > 0}
      <details class="exclude-details" open={excludedComponents.length > 0}>
        <summary>
          exclude components{excludedComponents.length > 0
            ? ` (${excludedComponents.length} excluded)`
            : ''}
        </summary>
        <div class="component-checkbox-list">
          {#each components as component}
            <label class="component-checkbox">
              <input
                type="checkbox"
                checked={excludedComponents.includes(component)}
                on:change={() => handleExcludedComponentToggle(component)}
              />
              <span>{component}</span>
            </label>
          {/each}
        </div>
      </details>
    {/if}
  </div>

  {#if loading && logs.length === 0}
    <div class="loading">loading logs...</div>
  {:else if error}
    <div class="error">error: {error}</div>
    <button on:click={fetchLogs}>retry</button>
  {:else if logs.length === 0}
    <div class="empty">no logs found</div>
  {:else}
    <div class="logs-container">
      <table>
        <thead>
          <tr>
            <th class="expand-col"></th>
            <th class="timestamp-col">time</th>
            <th class="level-col">level</th>
            <th class="component-col">component</th>
            <th class="message-col">message</th>
          </tr>
        </thead>
        <tbody>
          {#each logs as log (log.id ?? `${log.timestamp}-${log.message}`)}
            {@const id = log.id ?? `${log.timestamp}-${log.message}`}
            {@const expanded = expandedIds.has(id)}
            <tr class="log-row {getLevelClass(log.level)}" class:expanded>
              <td class="expand-cell">
                <button class="expand-btn" on:click={() => toggleExpanded(id)}>
                  {expanded ? '▾' : '▸'}
                </button>
              </td>
              <td class="timestamp-cell" title={formatTimestamp(log.timestamp)}>
                {formatRelativeTime(log.timestamp)}
              </td>
              <td class="level-cell">
                <span class="level-badge {getLevelClass(log.level)}">
                  {log.level}
                </span>
              </td>
              <td class="component-cell">{log.component}</td>
              <td class="message-cell" class:clamped={!expanded}>{log.message}</td>
            </tr>
            {#if expanded}
              <tr class="detail-row {getLevelClass(log.level)}">
                <td></td>
                <td colspan="4">
                  <div class="detail-content">
                    <div class="detail-field">
                      <span class="detail-label">timestamp</span>
                      <span class="detail-value">{formatTimestamp(log.timestamp)}</span>
                    </div>
                    <div class="detail-field">
                      <span class="detail-label">message</span>
                      <pre class="detail-message">{log.message}</pre>
                    </div>
                    {#if log.metadata}
                      <div class="detail-field">
                        <span class="detail-label">metadata</span>
                        <pre class="detail-message">{formatMetadata(log.metadata)}</pre>
                      </div>
                    {/if}
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>

    <Pagination {offset} {limit} {total} on:page={handlePage} />
  {/if}
</section>

<style>
  section {
    padding: 1rem;
    border: 1px solid var(--border);
    background-color: var(--surface);
    grid-column: 1 / -1;
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 1rem;
    padding: 0.5rem;
    background-color: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-width: 100%;
    align-items: center;
  }

  .filter-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .filter-group label {
    font-size: 0.8rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .filter-group select,
  .filter-group input[type='text'] {
    background-color: var(--surface-2);
    border: 1px solid var(--surface-3);
    color: var(--text-bright);
    padding: 0.3rem 0.5rem;
    font-size: 0.8rem;
    border-radius: var(--radius);
  }

  .filter-group select {
    min-width: 120px;
  }

  .search-group input[type='text'] {
    min-width: 200px;
  }

  .level-toggles {
    display: flex;
    gap: 0.15rem;
    align-items: center;
  }

  .level-btn {
    padding: 0.2rem 0.4rem;
    font-size: 0.7rem;
    border: 1px solid var(--surface-3);
    background-color: var(--surface-2);
    color: var(--text-dim);
    cursor: pointer;
    border-radius: var(--radius);
    font-weight: 500;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    transition:
      background-color 0.2s,
      border-color 0.2s,
      color 0.2s;
    height: 24px;
    line-height: 1;
    box-sizing: border-box;
    width: 44px;
    flex-shrink: 0;
  }

  .level-btn:hover {
    background-color: var(--border);
  }

  .level-btn .level-icon {
    font-size: 0.6rem;
    line-height: 1;
    display: flex;
    align-items: center;
  }

  .level-btn .level-text {
    text-transform: lowercase;
    font-size: 0.65rem;
    line-height: 1;
  }

  .level-btn.active {
    border-color: currentColor;
    background-color: rgba(255, 255, 255, 0.1);
  }

  .level-btn.error.active {
    color: var(--danger);
  }

  .level-btn.warn.active {
    color: var(--warning);
  }

  .level-btn.info.active {
    color: var(--success);
  }

  .level-btn.debug.active {
    color: var(--text-dim);
  }

  .btn-small {
    padding: 0.3rem 0.6rem;
    font-size: 0.75rem;
    background-color: var(--surface-3);
    color: var(--text-bright);
    border: 1px solid var(--border-2);
    cursor: pointer;
    border-radius: var(--radius);
  }

  .btn-small:hover {
    background-color: var(--border-2);
  }

  .btn-small:active {
    background-color: var(--border);
  }

  .filter-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-left: auto;
  }

  .live-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .live-toggle input[type='checkbox'] {
    cursor: pointer;
  }

  .ws-status {
    font-size: 0.85rem;
    color: var(--text-dim);
    white-space: nowrap;
  }

  .ws-status.connected {
    color: var(--success);
  }

  .export-buttons {
    display: flex;
    gap: 0.5rem;
  }

  .exclude-details {
    flex-basis: 100%;
  }

  .exclude-details summary {
    cursor: pointer;
    font-size: 0.8rem;
    color: var(--text-muted);
    user-select: none;
  }

  .exclude-details summary:hover {
    color: var(--text-bright);
  }

  .component-checkbox-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    max-height: 120px;
    overflow-y: auto;
    padding: 0.4rem;
    margin-top: 0.4rem;
    background-color: var(--surface-2);
    border: 1px solid var(--surface-3);
    border-radius: var(--radius);
  }

  .component-checkbox {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.2rem 0.4rem;
    background-color: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    white-space: nowrap;
  }

  .component-checkbox:hover {
    background-color: var(--surface-2);
    border-color: var(--border-2);
  }

  .component-checkbox input[type='checkbox'] {
    cursor: pointer;
  }

  .component-checkbox input[type='checkbox']:checked + span {
    color: var(--danger);
    font-weight: 500;
  }

  .logs-container {
    overflow-x: auto;
    margin-bottom: 1rem;
    max-width: 100%;
    width: 100%;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
    table-layout: auto;
  }

  thead {
    background-color: var(--surface-2);
    position: sticky;
    top: 0;
  }

  th {
    padding: 0.75rem 0.5rem;
    text-align: left;
    font-weight: 500;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    white-space: nowrap;
  }

  .expand-col {
    width: 24px;
  }

  .timestamp-col {
    width: 110px;
  }

  .level-col {
    width: 70px;
  }

  .component-col {
    width: 120px;
  }

  .message-col {
    width: auto;
    min-width: 200px;
  }

  tbody tr {
    border-bottom: 1px solid var(--surface-2);
  }

  tbody tr.log-row:hover {
    background-color: var(--surface-2);
  }

  .expand-btn {
    background: none;
    border: none;
    padding: 0;
    color: var(--text-dim);
    font-size: 0.75rem;
    cursor: pointer;
    line-height: 1.2;
  }

  .expand-btn:hover {
    color: var(--text-bright);
  }

  td {
    padding: 0.5rem;
    color: var(--text);
    vertical-align: top;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .log-row.error,
  .detail-row.error {
    background-color: rgba(255, 107, 107, 0.05);
  }

  .log-row.warn,
  .detail-row.warn {
    background-color: rgba(255, 217, 61, 0.05);
  }

  .expand-cell {
    color: var(--text-dim);
    font-size: 0.75rem;
  }

  .timestamp-cell {
    color: var(--text-dim);
    font-size: 0.8rem;
    font-family: monospace;
    white-space: nowrap;
  }

  .level-badge {
    display: inline-block;
    padding: 0.05rem 0.2rem;
    border-radius: var(--radius);
    font-size: 0.65rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    line-height: 1.2;
  }

  .level-badge.error {
    background-color: rgba(255, 107, 107, 0.2);
    color: var(--danger);
  }

  .level-badge.warn {
    background-color: rgba(255, 217, 61, 0.2);
    color: var(--warning);
  }

  .level-badge.info {
    background-color: rgba(81, 207, 102, 0.2);
    color: var(--success);
  }

  .level-badge.debug {
    background-color: rgba(136, 136, 136, 0.2);
    color: var(--text-dim);
  }

  .component-cell {
    color: var(--text-muted);
    font-size: 0.85rem;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .message-cell {
    color: var(--text);
    word-break: break-word;
    font-family: monospace;
    font-size: 0.85rem;
    text-align: left;
    max-width: 600px;
  }

  .message-cell.clamped {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .detail-content {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.25rem 0 0.5rem;
  }

  .detail-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .detail-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
  }

  .detail-value {
    font-family: monospace;
    font-size: 0.8rem;
    color: var(--text);
  }

  .detail-message {
    margin: 0;
    padding: 0.5rem;
    background-color: var(--bg-deep);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow-x: auto;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-size: 0.8rem;
    color: var(--text);
  }

  .loading,
  .error,
  .empty {
    padding: 2rem;
    text-align: center;
  }

  .loading {
    color: var(--text-dim);
  }

  .error {
    color: var(--danger);
  }

  .empty {
    color: var(--text-dim);
  }

  @media (max-width: 768px) {
    section {
      padding: 0.75rem;
    }

    .filters {
      flex-direction: column;
      align-items: stretch;
      gap: 0.75rem;
    }

    .filter-group {
      flex-direction: column;
      align-items: stretch;
    }

    .filter-group select,
    .filter-group input[type='text'] {
      width: 100%;
      min-height: 44px;
    }

    .filter-group button {
      min-height: 44px;
    }

    .filter-actions {
      margin-left: 0;
      width: 100%;
      flex-wrap: wrap;
    }

    .filter-actions button {
      flex: 1;
      min-height: 44px;
    }

    .logs-container {
      -webkit-overflow-scrolling: touch;
    }

    table {
      min-width: 700px;
      font-size: 0.75rem;
    }

    th,
    td {
      font-size: 0.75rem;
      padding: 0.5rem 0.25rem;
    }
  }
</style>
