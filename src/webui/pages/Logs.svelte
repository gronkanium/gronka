<script>
  import { onMount } from 'svelte';
  import { logs as wsLogs, connected as wsConnected } from '../stores/sse-store.js';
  import { formatTimestamp, formatRelativeTime, timeRangeToStartTime } from '../utils/format.js';
  import Pagination from '../components/Pagination.svelte';

  let logs = [];
  let total = 0;
  let loading = true;
  let error = null;

  // Filters
  let selectedComponent = '';
  let selectedLevels = ['ERROR', 'WARN', 'INFO'];
  let searchQuery = '';
  let timeRange = '';

  // Pagination
  let limit = 50;
  let offset = 0;

  // Components list for dropdown/exclude chips
  let components = [];

  let expandedIds = new Set();

  const levelDefs = [
    { level: 'ERROR', label: 'error', cls: 'error' },
    { level: 'WARN', label: 'warn', cls: 'warn' },
    { level: 'INFO', label: 'info', cls: 'info' },
    { level: 'DEBUG', label: 'debug', cls: 'debug' },
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
    refetch();
  }

  function handleClearFilters() {
    selectedComponent = '';
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

    // Subscribe to SSE logs (connection managed by App.svelte)
    const unsubscribe = wsLogs.subscribe(newLogs => {
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
  <div class="toolbar">
    <div class="search-box">
      <svg
        class="icon"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="text"
        aria-label="search logs"
        bind:value={searchQuery}
        on:keydown={e => e.key === 'Enter' && refetch()}
        placeholder="search logs…"
      />
      {#if searchQuery}
        <button
          class="clear-search"
          title="clear search"
          on:click={() => {
            searchQuery = '';
            refetch();
          }}>×</button
        >
      {/if}
    </div>

    <div class="levels" role="group" aria-label="log levels">
      {#each levelDefs as def}
        <button
          class="level {def.cls}"
          class:on={selectedLevels.includes(def.level)}
          aria-pressed={selectedLevels.includes(def.level)}
          on:click={() => handleLevelToggle(def.level)}
        >
          <span class="dot"></span>{def.label}
        </button>
      {/each}
    </div>

    <select
      class="control"
      aria-label="component"
      bind:value={selectedComponent}
      on:change={handleComponentChange}
    >
      <option value="">all components</option>
      {#each components as component}
        <option value={component}>{component}</option>
      {/each}
    </select>

    <select class="control" aria-label="time range" bind:value={timeRange} on:change={refetch}>
      <option value="">all time</option>
      <option value="1h">last hour</option>
      <option value="6h">last 6 hours</option>
      <option value="24h">last 24 hours</option>
      <option value="7d">last 7 days</option>
      <option value="30d">last 30 days</option>
    </select>

    <div class="toolbar-right">
      <span
        class="status"
        class:live={$wsConnected}
        title={$wsConnected ? 'streaming live' : 'reconnecting…'}
      >
        <span class="dot"></span>{$wsConnected ? 'live' : 'offline'}
      </span>
      <button class="control ghost" on:click={handleClearFilters}>clear</button>
      <button
        class="control ghost"
        on:click={() => exportPage('json')}
        title="export current page as JSON">json</button
      >
      <button
        class="control ghost"
        on:click={() => exportPage('csv')}
        title="export current page as CSV">csv</button
      >
    </div>
  </div>

  {#if loading && logs.length === 0}
    <div class="state-msg loading">loading logs...</div>
  {:else if error}
    <div class="state-msg state-error">error: {error}</div>
    <button on:click={fetchLogs}>retry</button>
  {:else if logs.length === 0}
    <div class="state-msg empty">no logs found</div>
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
              <td class="message-cell">{log.message}</td>
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

  /* One cohesive toolbar: every control shares height, surface, radius.
     Color appears only as small accent dots — never as filled boxes. */
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
    padding: 0.6rem 0.7rem;
    background-color: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-width: 100%;
  }

  /* Shared control baseline */
  .control,
  .search-box,
  .levels,
  .status {
    height: 32px;
    box-sizing: border-box;
    border-radius: var(--radius);
    font-size: 0.78rem;
  }

  .control {
    display: inline-flex;
    align-items: center;
    padding: 0 0.6rem;
    background-color: var(--surface-2);
    border: 1px solid var(--surface-3);
    color: var(--text-bright);
    cursor: pointer;
    white-space: nowrap;
    transition:
      background-color 0.15s,
      border-color 0.15s,
      color 0.15s;
  }

  .control:hover {
    background-color: var(--border);
  }

  select.control {
    min-width: 130px;
  }

  .control.ghost {
    background-color: transparent;
    border-color: transparent;
    color: var(--text-muted);
  }

  .control.ghost:hover {
    background-color: var(--surface-2);
    color: var(--text-bright);
  }

  /* Search — the primary control, grows to fill the row */
  .search-box {
    flex: 1 1 240px;
    min-width: 180px;
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0 0.55rem;
    background-color: var(--surface-2);
    border: 1px solid var(--surface-3);
    transition: border-color 0.15s;
  }

  .search-box:focus-within {
    border-color: var(--border-2);
  }

  .search-box .icon {
    color: var(--text-dim);
    flex-shrink: 0;
  }

  .search-box input {
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    outline: none;
    color: var(--text-bright);
    font-size: 0.8rem;
  }

  .search-box input::placeholder {
    color: var(--text-dim);
  }

  .clear-search {
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    padding: 0 0.1rem;
  }

  .clear-search:hover {
    color: var(--text-bright);
  }

  /* Level toggles — a connected segmented control, no loud color blocks */
  .levels {
    display: inline-flex;
    border: 1px solid var(--surface-3);
    overflow: hidden;
  }

  .level {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0 0.6rem;
    background-color: var(--surface-2);
    border: none;
    border-right: 1px solid var(--surface-3);
    color: var(--text-dim);
    font-size: 0.75rem;
    cursor: pointer;
    opacity: 0.55;
    transition:
      opacity 0.15s,
      background-color 0.15s,
      color 0.15s;
  }

  .level:last-child {
    border-right: none;
  }

  .level:hover {
    background-color: var(--border);
  }

  .level.on {
    opacity: 1;
    color: var(--text-bright);
    background-color: var(--surface-3);
  }

  .level .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background-color: var(--text-dim);
    flex-shrink: 0;
  }

  .level.on.error .dot {
    background-color: var(--danger);
  }

  .level.on.warn .dot {
    background-color: var(--warning);
  }

  .level.on.info .dot {
    background-color: var(--success);
  }

  .level.on.debug .dot {
    background-color: var(--text-muted);
  }

  /* Right cluster: live status + actions, pushed to the end */
  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-left: auto;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0 0.5rem;
    color: var(--text-dim);
    white-space: nowrap;
  }

  .status .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background-color: var(--text-dim);
  }

  .status.live {
    color: var(--success);
  }

  .status.live .dot {
    background-color: var(--success);
    box-shadow: 0 0 6px var(--success);
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

  .state-msg {
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
    section {
      padding: 0.75rem;
    }

    .search-box {
      flex-basis: 100%;
      min-height: 40px;
    }

    .control,
    .levels,
    .status {
      min-height: 40px;
      height: auto;
    }

    select.control {
      flex: 1 1 auto;
    }

    .toolbar-right {
      margin-left: 0;
      width: 100%;
      flex-wrap: wrap;
    }

    .toolbar-right .control {
      flex: 1;
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
