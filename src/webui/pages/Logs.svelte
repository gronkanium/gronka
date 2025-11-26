<script>
  import { onMount } from 'svelte';
  import { logs as wsLogs, connected as wsConnected } from '../stores/websocket-store.js';

  let logs = [];
  let total = 0;
  let loading = true;
  let error = null;

  // Filters
  let selectedComponent = '';
  let excludedComponents = [];
  let selectedLevels = ['ERROR', 'WARN', 'INFO'];
  let searchQuery = '';
  let autoScroll = false;
  let timeRange = '';
  let componentFilterMode = 'all'; // 'include', 'exclude', or 'all'

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
      if (excludedComponents.length > 0) params.append('excludedComponents', excludedComponents.join(','));

      // Add time range filters
      if (timeRange) {
        const now = Date.now();
        let startTime;
        
        switch (timeRange) {
          case '1h':
            startTime = now - 60 * 60 * 1000;
            break;
          case '6h':
            startTime = now - 6 * 60 * 60 * 1000;
            break;
          case '24h':
            startTime = now - 24 * 60 * 60 * 1000;
            break;
          case '7d':
            startTime = now - 7 * 24 * 60 * 60 * 1000;
            break;
          case '30d':
            startTime = now - 30 * 24 * 60 * 60 * 1000;
            break;
        }
        
        if (startTime) {
          params.append('startTime', startTime.toString());
        }
      }

      const response = await fetch(`/api/logs?${params}`);
      if (!response.ok) throw new Error('Failed to fetch logs');
      
      const data = await response.json();
      logs = data.logs || [];
      // Note: total count may be approximate when using exclusion filter
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
    // Clear excluded components when including a component
    if (selectedComponent) {
      excludedComponents = [];
      componentFilterMode = 'include';
    }
    offset = 0;
    fetchLogs();
  }

  function handleExcludedComponentToggle(component) {
    if (excludedComponents.includes(component)) {
      excludedComponents = excludedComponents.filter(c => c !== component);
      // If no excluded components left, switch to 'all' mode
      if (excludedComponents.length === 0) {
        componentFilterMode = 'all';
      }
    } else {
      excludedComponents = [...excludedComponents, component];
      componentFilterMode = 'exclude';
      // Clear selected component when excluding components
      if (selectedComponent === component) {
        selectedComponent = '';
      }
    }
    offset = 0;
    fetchLogs();
  }

  function handleSearch() {
    offset = 0;
    fetchLogs();
  }

  function handleClearFilters() {
    selectedComponent = '';
    excludedComponents = [];
    componentFilterMode = 'all';
    selectedLevels = ['ERROR', 'WARN', 'INFO'];
    searchQuery = '';
    timeRange = '';
    offset = 0;
    fetchLogs();
  }

  function handleTimeRangeChange(event) {
    timeRange = event.target.value;
    offset = 0;
    fetchLogs();
  }

  function exportLogs(format) {
    if (logs.length === 0) return;

    if (format === 'json') {
      const dataStr = JSON.stringify(logs, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      downloadBlob(dataBlob, `logs-${Date.now()}.json`);
    } else if (format === 'csv') {
      const headers = ['timestamp', 'level', 'component', 'message'];
      const csvContent = [
        headers.join(','),
        ...logs.map(log =>
          headers
            .map(h => {
              const value = h === 'timestamp' ? new Date(log[h]).toISOString() : (log[h] || '');
              return `"${String(value).replace(/"/g, '""')}"`;
            })
            .join(',')
        ),
      ].join('\n');
      const dataBlob = new Blob([csvContent], { type: 'text/csv' });
      downloadBlob(dataBlob, `logs-${Date.now()}.csv`);
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

  // Check if a log entry matches current filters
  function matchesFilters(logEntry) {
    if (selectedComponent && logEntry.component !== selectedComponent) {
      return false;
    }
    if (excludedComponents.length > 0 && excludedComponents.includes(logEntry.component)) {
      return false;
    }
    if (selectedLevels.length > 0 && !selectedLevels.includes(logEntry.level)) {
      return false;
    }
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchesSearch =
        (logEntry.message && logEntry.message.toLowerCase().includes(query)) ||
        (logEntry.component && logEntry.component.toLowerCase().includes(query));
      if (!matchesSearch) {
        return false;
      }
    }
    if (timeRange) {
      const now = Date.now();
      let startTime;
      switch (timeRange) {
        case '1h':
          startTime = now - 60 * 60 * 1000;
          break;
        case '6h':
          startTime = now - 6 * 60 * 60 * 1000;
          break;
        case '24h':
          startTime = now - 24 * 60 * 60 * 1000;
          break;
        case '7d':
          startTime = now - 7 * 24 * 60 * 60 * 1000;
          break;
        case '30d':
          startTime = now - 30 * 24 * 60 * 60 * 1000;
          break;
      }
      if (startTime && logEntry.timestamp < startTime) {
        return false;
      }
    }
    return true;
  }

  // Handle new logs from WebSocket
  function handleNewLog(newLog) {
    // Only add if it matches current filters
    if (!matchesFilters(newLog)) {
      return;
    }

    // If we're on the first page, add to the list
    if (offset === 0) {
      logs = [newLog, ...logs];
      // Keep only limit logs
      if (logs.length > limit) {
        logs = logs.slice(0, limit);
      }
      total += 1;
    } else {
      // If we're on a later page, just update the total
      total += 1;
    }
  }

  onMount(() => {
    fetchLogs();
    fetchComponents();
    
    // Subscribe to WebSocket logs (connection managed by App.svelte)
    const unsubscribe = wsLogs.subscribe(newLogs => {
      // Only process new logs that aren't already in our list
      if (newLogs.length > 0) {
        const latestLog = newLogs[0];
        const exists = logs.some(log => log.id === latestLog.id || 
          (log.timestamp === latestLog.timestamp && log.message === latestLog.message));
        
        if (!exists) {
          handleNewLog(latestLog);
        }
      }
    });
    
    return () => {
      unsubscribe();
    };
  });
</script>

<section class="logs">
  <div class="header">
    <h2>logs</h2>
    <div class="ws-status" class:connected={$wsConnected}>
      {$wsConnected ? '● live' : '○ disconnected'}
    </div>
  </div>

  <div class="filters">
    <div class="filter-group component-filters">
      <!-- svelte-ignore a11y_label_has_associated_control -->
      <label>components:</label>
      <div class="component-filter-mode">
        <label class="mode-toggle">
          <input 
            type="radio" 
            name="component-mode" 
            value="include" 
            checked={componentFilterMode === 'include'}
            on:change={() => { 
              componentFilterMode = 'include';
              excludedComponents = [];
              selectedComponent = '';
              offset = 0;
              fetchLogs();
            }}
          />
          <span>include</span>
        </label>
        <label class="mode-toggle">
          <input 
            type="radio" 
            name="component-mode" 
            value="exclude" 
            checked={componentFilterMode === 'exclude'}
            on:change={() => { 
              componentFilterMode = 'exclude';
              selectedComponent = '';
              offset = 0;
              fetchLogs();
            }}
          />
          <span>exclude</span>
        </label>
        <label class="mode-toggle">
          <input 
            type="radio" 
            name="component-mode" 
            value="all" 
            checked={componentFilterMode === 'all'}
            on:change={() => { 
              componentFilterMode = 'all';
              selectedComponent = '';
              excludedComponents = [];
              offset = 0;
              fetchLogs();
            }}
          />
          <span>all</span>
        </label>
      </div>
      <div class="component-checkboxes">
        {#if componentFilterMode === 'include'}
          <!-- Include mode: single select dropdown -->
          <select id="component-filter" value={selectedComponent} on:change={handleComponentChange}>
            <option value="">all</option>
            {#each components as component}
              <option value={component}>{component}</option>
            {/each}
          </select>
        {:else if componentFilterMode === 'exclude'}
          <!-- Exclude mode: checkboxes -->
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
        {/if}
      </div>
    </div>

    <div class="filter-group">
      <!-- svelte-ignore a11y_label_has_associated_control -->
      <label>level:</label>
      <div class="level-toggles">
        <button
          class="level-btn-icon-text error"
          class:active={selectedLevels.includes('ERROR')}
          on:click={() => handleLevelToggle('ERROR')}
        >
          <span class="level-icon">●</span><span class="level-text">err</span>
        </button>
        <button
          class="level-btn-icon-text warn"
          class:active={selectedLevels.includes('WARN')}
          on:click={() => handleLevelToggle('WARN')}
        >
          <span class="level-icon">●</span><span class="level-text">wrn</span>
        </button>
        <button
          class="level-btn-icon-text info"
          class:active={selectedLevels.includes('INFO')}
          on:click={() => handleLevelToggle('INFO')}
        >
          <span class="level-icon">●</span><span class="level-text">inf</span>
        </button>
        <button
          class="level-btn-icon-text debug"
          class:active={selectedLevels.includes('DEBUG')}
          on:click={() => handleLevelToggle('DEBUG')}
        >
          <span class="level-icon">●</span><span class="level-text">dbg</span>
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

    <div class="filter-group">
      <label for="time-range-filter">time range:</label>
      <select id="time-range-filter" value={timeRange} on:change={handleTimeRangeChange}>
        <option value="">all time</option>
        <option value="1h">last hour</option>
        <option value="6h">last 6 hours</option>
        <option value="24h">last 24 hours</option>
        <option value="7d">last 7 days</option>
        <option value="30d">last 30 days</option>
      </select>
    </div>

    <div class="filter-actions">
      <button class="btn-small" on:click={handleClearFilters}>clear filters</button>
      <label class="auto-scroll-toggle">
        <input type="checkbox" bind:checked={autoScroll} />
        auto-scroll
      </label>
      <div class="export-buttons">
        <button class="btn-small" on:click={() => exportLogs('json')}>export json</button>
        <button class="btn-small" on:click={() => exportLogs('csv')}>export csv</button>
      </div>
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
            <th class="metadata-col">metadata</th>
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
              <td class="metadata-cell">
                {#if log.metadata}
                  <details>
                    <summary>view</summary>
                    <pre>{typeof log.metadata === 'string' ? log.metadata : JSON.stringify(log.metadata, null, 2)}</pre>
                  </details>
                {:else}
                  <span class="no-data">-</span>
                {/if}
              </td>
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
    gap: 0.75rem;
    margin-bottom: 1rem;
    padding: 0.5rem;
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
    font-size: 0.8rem;
    color: #aaa;
    white-space: nowrap;
  }

  .filter-group select,
  .filter-group input[type="text"] {
    background-color: #2a2a2a;
    border: 1px solid #444;
    color: #fff;
    padding: 0.3rem 0.5rem;
    font-size: 0.8rem;
    border-radius: 3px;
  }

  .filter-group select {
    min-width: 120px;
  }

  .search-group input[type="text"] {
    min-width: 200px;
  }

  .component-filters {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .component-filter-mode {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .mode-toggle {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.8rem;
    color: #aaa;
    cursor: pointer;
  }

  .mode-toggle input[type="radio"] {
    cursor: pointer;
  }

  .mode-toggle input[type="radio"]:checked + span {
    color: #51cf66;
  }

  .component-checkboxes {
    width: 100%;
  }

  .component-checkbox-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    max-height: 120px;
    overflow-y: auto;
    padding: 0.4rem;
    background-color: #2a2a2a;
    border: 1px solid #444;
    border-radius: 3px;
  }

  .component-checkbox {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
    color: #aaa;
    cursor: pointer;
    padding: 0.2rem 0.4rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 3px;
    white-space: nowrap;
  }

  .component-checkbox:hover {
    background-color: #2a2a2a;
    border-color: #555;
  }

  .component-checkbox input[type="checkbox"] {
    cursor: pointer;
  }

  .component-checkbox input[type="checkbox"]:checked + span {
    color: #ff6b6b;
    font-weight: 500;
  }

  .level-toggles {
    display: flex;
    gap: 0.15rem;
    align-items: center;
  }

  .level-btn {
    padding: 0.15rem 0.3rem !important;
    font-size: 0.65rem !important;
    border: 1px solid #444 !important;
    background-color: #2a2a2a !important;
    color: #888 !important;
    cursor: pointer;
    border-radius: 3px !important;
    text-transform: uppercase !important;
    font-weight: 500 !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    line-height: 1 !important;
    box-sizing: border-box !important;
    text-align: center !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
    flex-shrink: 0 !important;
    margin: 0 !important;
  }

  .level-btn:hover {
    background-color: #333 !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn.active {
    border-color: currentColor !important;
    background-color: rgba(255, 255, 255, 0.1) !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn.error.active {
    color: #ff6b6b !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn.warn.active {
    color: #ffd93d !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn.info.active {
    color: #51cf66 !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn.debug.active {
    color: #888 !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  /* Style Demo Section */
  .style-demo-section {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 1rem;
    background-color: #1a1a1a;
    border: 1px solid #444;
    border-radius: 3px;
    margin-bottom: 0.75rem;
  }

  .style-demo-container {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    width: 100%;
  }

  .style-demo-item {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .style-demo-label {
    font-size: 0.75rem;
    color: #888;
    font-weight: 500;
  }

  /* Option 1: Icon-only buttons */
  .style-option-1 {
    gap: 0.25rem;
  }

  .level-btn-icon-only {
    width: 20px !important;
    height: 20px !important;
    min-width: 20px !important;
    max-width: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    padding: 0 !important;
    border: 1px solid #444 !important;
    background-color: #2a2a2a !important;
    cursor: pointer;
    border-radius: 50% !important;
    font-size: 0.65rem !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    color: #666 !important;
    transition: background-color 0.2s;
    box-sizing: border-box !important;
    flex-shrink: 0 !important;
    margin: 0 !important;
  }

  .level-btn-icon-only:hover {
    background-color: #333 !important;
    width: 20px !important;
    height: 20px !important;
    min-width: 20px !important;
    max-width: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
  }

  .level-btn-icon-only.error {
    border-color: #ff6b6b;
    color: #ff6b6b;
  }

  .level-btn-icon-only.warn {
    border-color: #ffd93d;
    color: #ffd93d;
  }

  .level-btn-icon-only.info {
    border-color: #51cf66;
    color: #51cf66;
  }

  .level-btn-icon-only.debug {
    border-color: #888;
    color: #888;
  }

  .level-btn-icon-only.active {
    background-color: rgba(255, 255, 255, 0.15) !important;
    box-shadow: 0 0 4px currentColor !important;
    width: 20px !important;
    height: 20px !important;
    min-width: 20px !important;
    max-width: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
  }

  /* Option 2: Compact badges */
  .style-option-2 {
    gap: 0.15rem;
  }

  .level-btn-compact {
    padding: 0.15rem 0.3rem !important;
    font-size: 0.65rem !important;
    border: 1px solid #444 !important;
    background-color: #2a2a2a !important;
    color: #888 !important;
    cursor: pointer;
    border-radius: 2px !important;
    text-transform: uppercase !important;
    font-weight: 500 !important;
    white-space: nowrap !important;
    transition: background-color 0.2s, border-color 0.2s, color 0.2s;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    line-height: 1 !important;
    box-sizing: border-box !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
    flex-shrink: 0 !important;
    margin: 0 !important;
  }

  .level-btn-compact:hover {
    background-color: #333 !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn-compact.active {
    border-color: currentColor !important;
    background-color: rgba(255, 255, 255, 0.1) !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn-compact.error.active {
    color: #ff6b6b !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn-compact.warn.active {
    color: #ffd93d !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn-compact.info.active {
    color: #51cf66 !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn-compact.debug.active {
    color: #888 !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  /* Option 4: Segmented control */
  .style-option-4 {
    gap: 0;
    border: 1px solid #444;
    border-radius: 3px;
    display: inline-flex;
    overflow: hidden;
  }

  .level-btn-segmented {
    padding: 0.15rem 0.3rem !important;
    font-size: 0.65rem !important;
    border: none !important;
    border-right: 1px solid #444 !important;
    background-color: #2a2a2a !important;
    color: #888 !important;
    cursor: pointer;
    text-transform: uppercase !important;
    font-weight: 500 !important;
    white-space: nowrap !important;
    transition: background-color 0.2s, color 0.2s;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    line-height: 1 !important;
    box-sizing: border-box !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
    flex-shrink: 0 !important;
    margin: 0 !important;
  }

  .level-btn-segmented:last-child {
    border-right: none;
  }

  .level-btn-segmented:hover {
    background-color: #333 !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn-segmented.active {
    background-color: rgba(255, 255, 255, 0.1) !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn-segmented.error.active {
    color: #ff6b6b !important;
    background-color: rgba(255, 107, 107, 0.15) !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn-segmented.warn.active {
    color: #ffd93d !important;
    background-color: rgba(255, 217, 61, 0.15) !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn-segmented.info.active {
    color: #51cf66 !important;
    background-color: rgba(81, 207, 102, 0.15) !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn-segmented.debug.active {
    color: #888 !important;
    background-color: rgba(136, 136, 136, 0.15) !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  /* Option 5: Minimal pills */
  .style-option-5 {
    gap: 0.15rem;
  }

  .level-btn-minimal {
    padding: 0.15rem 0.3rem !important;
    font-size: 0.65rem !important;
    border: 1px solid #444 !important;
    background-color: #2a2a2a !important;
    color: #888 !important;
    cursor: pointer;
    border-radius: 8px !important;
    text-transform: uppercase !important;
    font-weight: 500 !important;
    white-space: nowrap !important;
    transition: background-color 0.2s, border-color 0.2s, color 0.2s;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    line-height: 1 !important;
    box-sizing: border-box !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
    flex-shrink: 0 !important;
    margin: 0 !important;
  }

  .level-btn-minimal:hover {
    background-color: #333 !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn-minimal.active {
    border-color: currentColor !important;
    background-color: rgba(255, 255, 255, 0.1) !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn-minimal.error.active {
    color: #ff6b6b !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn-minimal.warn.active {
    color: #ffd93d !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn-minimal.info.active {
    color: #51cf66 !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  .level-btn-minimal.debug.active {
    color: #888 !important;
    height: 20px !important;
    min-height: 20px !important;
    max-height: 20px !important;
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
  }

  /* Option 6: Icon + text compact */
  .style-option-6 {
    gap: 0.15rem;
  }

  .level-btn-icon-text {
    padding: 0.2rem 0.4rem !important;
    font-size: 0.7rem !important;
    border: 1px solid #444 !important;
    background-color: #2a2a2a !important;
    color: #888 !important;
    cursor: pointer;
    border-radius: 3px !important;
    font-weight: 500 !important;
    white-space: nowrap !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 0.25rem !important;
    transition: background-color 0.2s, border-color 0.2s, color 0.2s;
    height: 24px !important;
    min-height: 24px !important;
    max-height: 24px !important;
    line-height: 1 !important;
    box-sizing: border-box !important;
    width: 44px !important;
    min-width: 44px !important;
    max-width: 44px !important;
    flex-shrink: 0 !important;
    margin: 0 !important;
  }

  .level-btn-icon-text:hover {
    background-color: #333 !important;
    height: 24px !important;
    min-height: 24px !important;
    max-height: 24px !important;
    width: 44px !important;
    min-width: 44px !important;
    max-width: 44px !important;
  }

  .level-btn-icon-text .level-icon {
    font-size: 0.6rem !important;
    line-height: 1 !important;
    display: flex !important;
    align-items: center !important;
  }

  .level-btn-icon-text .level-text {
    text-transform: lowercase !important;
    font-size: 0.65rem !important;
    line-height: 1 !important;
  }

  .level-btn-icon-text.active {
    border-color: currentColor !important;
    background-color: rgba(255, 255, 255, 0.1) !important;
    height: 24px !important;
    min-height: 24px !important;
    max-height: 24px !important;
    width: 44px !important;
    min-width: 44px !important;
    max-width: 44px !important;
  }

  .level-btn-icon-text.error.active {
    color: #ff6b6b !important;
    height: 24px !important;
    min-height: 24px !important;
    max-height: 24px !important;
    width: 44px !important;
    min-width: 44px !important;
    max-width: 44px !important;
  }

  .level-btn-icon-text.warn.active {
    color: #ffd93d !important;
    height: 24px !important;
    min-height: 24px !important;
    max-height: 24px !important;
    width: 44px !important;
    min-width: 44px !important;
    max-width: 44px !important;
  }

  .level-btn-icon-text.info.active {
    color: #51cf66 !important;
    height: 24px !important;
    min-height: 24px !important;
    max-height: 24px !important;
    width: 44px !important;
    min-width: 44px !important;
    max-width: 44px !important;
  }

  .level-btn-icon-text.debug.active {
    color: #888 !important;
    height: 24px !important;
    min-height: 24px !important;
    max-height: 24px !important;
    width: 44px !important;
    min-width: 44px !important;
    max-width: 44px !important;
  }

  .btn-small {
    padding: 0.3rem 0.6rem;
    font-size: 0.75rem;
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
    font-size: 0.8rem;
    color: #aaa;
    cursor: pointer;
  }

  .export-buttons {
    display: flex;
    gap: 0.5rem;
  }

  .metadata-col {
    width: 100px;
  }

  .metadata-cell {
    font-size: 0.8rem;
  }

  .metadata-cell details {
    cursor: pointer;
  }

  .metadata-cell summary {
    color: #51cf66;
    user-select: none;
  }

  .metadata-cell summary:hover {
    color: #6de380;
  }

  .metadata-cell pre {
    margin-top: 0.5rem;
    padding: 0.5rem;
    background-color: #0d0d0d;
    border: 1px solid #333;
    border-radius: 3px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-wrap: break-word;
    max-width: 400px;
    font-size: 0.75rem;
  }

  .metadata-cell .no-data {
    color: #555;
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

  .level-cell {
    padding: 0.3rem 0.3rem !important;
    text-align: left;
  }

  .level-badge {
    display: inline-block;
    padding: 0.05rem 0.2rem;
    border-radius: 2px;
    font-size: 0.65rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    line-height: 1.2;
  }

  .level-badge.error {
    background-color: rgba(255, 107, 107, 0.2);
    color: #ff6b6b;
    padding: 0.02rem 0.15rem !important;
    font-size: 0.6rem !important;
    line-height: 1.1 !important;
    border-radius: 2px;
    font-weight: 500;
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
    text-align: left;
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
    .filter-group input[type="text"] {
      width: 100%;
      min-height: 44px;
    }
    
    .filter-group button {
      min-height: 44px;
    }

    .filter-actions {
      margin-left: 0;
      width: 100%;
    }
    
    .filter-actions button {
      width: 100%;
      min-height: 44px;
    }
    
    .table-container {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    
    table {
      min-width: 800px;
    }
    
    th,
    td {
      font-size: 0.75rem;
      padding: 0.5rem 0.25rem;
    }
    
    .pagination {
      flex-direction: column;
      gap: 0.75rem;
      align-items: stretch;
    }
    
    .pagination-controls {
      width: 100%;
    }
    
    .pagination-controls button {
      flex: 1;
      min-height: 44px;
    }

    table {
      font-size: 0.75rem;
    }

    .timestamp-col {
      width: 120px;
    }
  }
</style>

