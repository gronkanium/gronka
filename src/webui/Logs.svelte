<script>
  import { onMount, onDestroy } from 'svelte';

  let logs = [];
  let total = 0;
  let loading = true;
  let error = null;
  let ws = null;
  let connected = false;

  // Filters
  let selectedComponent = '';
  let selectedLevels = ['ERROR', 'WARN', 'INFO'];
  let searchQuery = '';
  let autoScroll = false;

  // Pagination
  let limit = 50;
  let offset = 0;

  // Components list for dropdown
  let components = [];

  function formatTimestamp(timestamp) {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    return date.toLocaleString();
  }

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

  function handleLevelToggle(level) {
    if (selectedLevels.includes(level)) {
      selectedLevels = selectedLevels.filter(l => l !== level);
    } else {
      selectedLevels = [...selectedLevels, level];
    }
    offset = 0;
    fetchLogs();
  }

  function handleComponentChange(event) {
    selectedComponent = event.target.value;
    offset = 0;
    fetchLogs();
  }

  function handleSearch() {
    offset = 0;
    fetchLogs();
  }

  function handleClearFilters() {
    selectedComponent = '';
    selectedLevels = ['ERROR', 'WARN', 'INFO'];
    searchQuery = '';
    offset = 0;
    fetchLogs();
  }

  function handlePrevPage() {
    if (offset > 0) {
      offset = Math.max(0, offset - limit);
      fetchLogs();
    }
  }

  function handleNextPage() {
    if (offset + limit < total) {
      offset += limit;
      fetchLogs();
    }
  }

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/ws`;

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        connected = true;
      };

      ws.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'log') {
            // Add new log at the beginning if we're on the first page
            if (offset === 0 && autoScroll) {
              logs = [message.data, ...logs];
              // Keep only limit logs
              if (logs.length > limit) {
                logs = logs.slice(0, limit);
              }
              total += 1;
            }
          }
        } catch (err) {
          console.error('Error parsing websocket message:', err);
        }
      };

      ws.onerror = err => {
        console.error('WebSocket error:', err);
        connected = false;
      };

      ws.onclose = () => {
        connected = false;
        // Attempt to reconnect after 3 seconds
        setTimeout(() => {
          if (!ws || ws.readyState === WebSocket.CLOSED) {
            connectWebSocket();
          }
        }, 3000);
      };
    } catch (err) {
      console.error('Error creating WebSocket:', err);
      connected = false;
    }
  }

  onMount(() => {
    fetchLogs();
    fetchComponents();
    connectWebSocket();
  });

  onDestroy(() => {
    if (ws) {
      ws.close();
    }
  });
</script>

<section class="logs">
  <div class="header">
    <h2>logs</h2>
    <div class="ws-status" class:connected>
      {connected ? '● live' : '○ disconnected'}
    </div>
  </div>

  <div class="filters">
    <div class="filter-group">
      <label for="component-filter">component:</label>
      <select id="component-filter" value={selectedComponent} on:change={handleComponentChange}>
        <option value="">all</option>
        {#each components as component}
          <option value={component}>{component}</option>
        {/each}
      </select>
    </div>

    <div class="filter-group">
      <label>level:</label>
      <div class="level-toggles">
        <button
          class="level-btn error"
          class:active={selectedLevels.includes('ERROR')}
          on:click={() => handleLevelToggle('ERROR')}
        >
          error
        </button>
        <button
          class="level-btn warn"
          class:active={selectedLevels.includes('WARN')}
          on:click={() => handleLevelToggle('WARN')}
        >
          warn
        </button>
        <button
          class="level-btn info"
          class:active={selectedLevels.includes('INFO')}
          on:click={() => handleLevelToggle('INFO')}
        >
          info
        </button>
        <button
          class="level-btn debug"
          class:active={selectedLevels.includes('DEBUG')}
          on:click={() => handleLevelToggle('DEBUG')}
        >
          debug
        </button>
      </div>
    </div>

    <div class="filter-group search-group">
      <label for="search-input">search:</label>
      <input
        id="search-input"
        type="text"
        bind:value={searchQuery}
        on:keydown={e => e.key === 'Enter' && handleSearch()}
        placeholder="search messages..."
      />
      <button class="btn-small" on:click={handleSearch}>search</button>
    </div>

    <div class="filter-actions">
      <button class="btn-small" on:click={handleClearFilters}>clear filters</button>
      <label class="auto-scroll-toggle">
        <input type="checkbox" bind:checked={autoScroll} />
        auto-scroll
      </label>
    </div>
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
            <th class="timestamp-col">timestamp</th>
            <th class="level-col">level</th>
            <th class="component-col">component</th>
            <th class="message-col">message</th>
          </tr>
        </thead>
        <tbody>
          {#each logs as log (log.id)}
            <tr class="log-row {getLevelClass(log.level)}">
              <td class="timestamp-cell">{formatTimestamp(log.timestamp)}</td>
              <td class="level-cell">
                <span class="level-badge {getLevelClass(log.level)}">
                  {log.level}
                </span>
              </td>
              <td class="component-cell">{log.component}</td>
              <td class="message-cell">{log.message}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div class="pagination">
      <div class="pagination-info">
        showing {offset + 1}-{Math.min(offset + limit, total)} of {total}
      </div>
      <div class="pagination-controls">
        <button on:click={handlePrevPage} disabled={offset === 0}>
          previous
        </button>
        <button on:click={handleNextPage} disabled={offset + limit >= total}>
          next
        </button>
      </div>
    </div>
  {/if}
</section>

<style>
  section {
    padding: 1rem;
    border: 1px solid #333;
    background-color: #222;
    grid-column: 1 / -1;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
    border-bottom: 1px solid #333;
    padding-bottom: 0.5rem;
  }

  h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 500;
    color: #fff;
  }

  .ws-status {
    font-size: 0.85rem;
    color: #666;
  }

  .ws-status.connected {
    color: #51cf66;
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin-bottom: 1rem;
    padding: 0.75rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 3px;
  }

  .filter-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .filter-group label {
    font-size: 0.85rem;
    color: #aaa;
    white-space: nowrap;
  }

  .filter-group select,
  .filter-group input[type="text"] {
    background-color: #2a2a2a;
    border: 1px solid #444;
    color: #fff;
    padding: 0.4rem 0.6rem;
    font-size: 0.85rem;
    border-radius: 3px;
  }

  .filter-group select {
    min-width: 120px;
  }

  .search-group input[type="text"] {
    min-width: 200px;
  }

  .level-toggles {
    display: flex;
    gap: 0.25rem;
  }

  .level-btn {
    padding: 0.4rem 0.8rem;
    font-size: 0.8rem;
    border: 1px solid #444;
    background-color: #2a2a2a;
    color: #888;
    cursor: pointer;
    border-radius: 3px;
    text-transform: uppercase;
    font-weight: 500;
  }

  .level-btn:hover {
    background-color: #333;
  }

  .level-btn.active {
    border-color: currentColor;
    background-color: rgba(255, 255, 255, 0.1);
  }

  .level-btn.error.active {
    color: #ff6b6b;
  }

  .level-btn.warn.active {
    color: #ffd93d;
  }

  .level-btn.info.active {
    color: #51cf66;
  }

  .level-btn.debug.active {
    color: #888;
  }

  .btn-small {
    padding: 0.4rem 0.8rem;
    font-size: 0.85rem;
    background-color: #444;
    color: #fff;
    border: 1px solid #555;
    cursor: pointer;
    border-radius: 3px;
  }

  .btn-small:hover {
    background-color: #555;
  }

  .btn-small:active {
    background-color: #333;
  }

  .filter-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-left: auto;
  }

  .auto-scroll-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: #aaa;
    cursor: pointer;
  }

  .logs-container {
    overflow-x: auto;
    margin-bottom: 1rem;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  thead {
    background-color: #2a2a2a;
    position: sticky;
    top: 0;
  }

  th {
    padding: 0.75rem 0.5rem;
    text-align: left;
    font-weight: 500;
    color: #aaa;
    border-bottom: 1px solid #333;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .timestamp-col {
    width: 180px;
  }

  .level-col {
    width: 80px;
  }

  .component-col {
    width: 120px;
  }

  .message-col {
    width: auto;
  }

  tbody tr {
    border-bottom: 1px solid #2a2a2a;
  }

  tbody tr:hover {
    background-color: #2a2a2a;
  }

  td {
    padding: 0.6rem 0.5rem;
    color: #e0e0e0;
    vertical-align: top;
  }

  .log-row.error {
    background-color: rgba(255, 107, 107, 0.05);
  }

  .log-row.warn {
    background-color: rgba(255, 217, 61, 0.05);
  }

  .timestamp-cell {
    color: #888;
    font-size: 0.8rem;
    font-family: monospace;
    white-space: nowrap;
  }

  .level-badge {
    display: inline-block;
    padding: 0.2rem 0.5rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .level-badge.error {
    background-color: rgba(255, 107, 107, 0.2);
    color: #ff6b6b;
  }

  .level-badge.warn {
    background-color: rgba(255, 217, 61, 0.2);
    color: #ffd93d;
  }

  .level-badge.info {
    background-color: rgba(81, 207, 102, 0.2);
    color: #51cf66;
  }

  .level-badge.debug {
    background-color: rgba(136, 136, 136, 0.2);
    color: #888;
  }

  .component-cell {
    color: #aaa;
    font-size: 0.85rem;
  }

  .message-cell {
    color: #e0e0e0;
    word-break: break-word;
    font-family: monospace;
    font-size: 0.85rem;
  }

  .pagination {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 3px;
  }

  .pagination-info {
    font-size: 0.85rem;
    color: #aaa;
  }

  .pagination-controls {
    display: flex;
    gap: 0.5rem;
  }

  .pagination-controls button {
    padding: 0.4rem 0.8rem;
    font-size: 0.85rem;
    background-color: #444;
    color: #fff;
    border: 1px solid #555;
    cursor: pointer;
    border-radius: 3px;
  }

  .pagination-controls button:hover:not(:disabled) {
    background-color: #555;
  }

  .pagination-controls button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .loading,
  .error,
  .empty {
    padding: 2rem;
    text-align: center;
  }

  .loading {
    color: #888;
  }

  .error {
    color: #ff6b6b;
  }

  .empty {
    color: #888;
  }

  @media (max-width: 768px) {
    .filters {
      flex-direction: column;
      align-items: stretch;
    }

    .filter-group {
      flex-direction: column;
      align-items: stretch;
    }

    .filter-group select,
    .filter-group input[type="text"] {
      width: 100%;
    }

    .filter-actions {
      margin-left: 0;
    }

    table {
      font-size: 0.75rem;
    }

    .timestamp-col {
      width: 120px;
    }
  }
</style>

