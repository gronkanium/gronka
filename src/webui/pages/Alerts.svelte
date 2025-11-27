<script>
  import { onMount } from 'svelte';
  import { alerts as wsAlerts, connected as wsConnected } from '../stores/websocket-store.js';

  let alerts = [];
  let total = 0;
  let loading = true;
  let error = null;

  let selectedSeverity = '';
  let selectedComponent = '';
  let searchQuery = '';
  let limit = 100;
  let offset = 0;

  let components = [];
  let severities = ['info', 'warning', 'error'];

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

      const response = await fetch(`/api/alerts?${params}`);
      if (!response.ok) throw new Error('failed to fetch alerts');

      const data = await response.json();
      alerts = data.alerts || [];
      total = data.total || 0;

      // Extract unique components
      const componentSet = new Set(alerts.map(a => a.component));
      components = [...componentSet].sort();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  function handleSearch() {
    offset = 0;
    fetchAlerts();
  }

  function handleSeverityChange(event) {
    selectedSeverity = event.target.value;
    offset = 0;
    fetchAlerts();
  }

  function handleComponentChange(event) {
    selectedComponent = event.target.value;
    offset = 0;
    fetchAlerts();
  }

  function handleClearFilters() {
    selectedSeverity = '';
    selectedComponent = '';
    searchQuery = '';
    offset = 0;
    fetchAlerts();
  }

  function handlePrevPage() {
    if (offset > 0) {
      offset = Math.max(0, offset - limit);
      fetchAlerts();
    }
  }

  function handleNextPage() {
    if (offset + limit < total) {
      offset += limit;
      fetchAlerts();
    }
  }

  function formatTimestamp(timestamp) {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    return date.toLocaleString();
  }

  function formatRelativeTime(timestamp) {
    if (!timestamp) return 'N/A';
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return `${seconds}s ago`;
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return formatTimestamp(timestamp);
  }

  function formatDuration(ms) {
    if (!ms || ms === 0) return 'N/A';
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = seconds / 60;
    if (minutes < 60) return `${minutes.toFixed(1)}m`;
    const hours = minutes / 60;
    return `${hours.toFixed(1)}h`;
  }

  function getSeverityClass(severity) {
    return severity ? severity.toLowerCase() : 'unknown';
  }

  function getFormattedMetadata(alert) {
    if (!alert.metadata) return {};
    try {
      const parsed = JSON.parse(alert.metadata);
      return {
        ...parsed,
        duration:
          parsed.duration !== undefined
            ? formatDuration(parsed.duration)
            : parsed.duration,
      };
    } catch (err) {
      return {};
    }
  }

  // Check if alert matches current filters
  function matchesFilters(alert) {
    if (selectedSeverity && alert.severity !== selectedSeverity) {
      return false;
    }
    if (selectedComponent && alert.component !== selectedComponent) {
      return false;
    }
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchesSearch =
        (alert.title && alert.title.toLowerCase().includes(query)) ||
        (alert.message && alert.message.toLowerCase().includes(query)) ||
        (alert.component && alert.component.toLowerCase().includes(query));
      if (!matchesSearch) {
        return false;
      }
    }
    return true;
  }

  // Handle new alert from WebSocket
  function handleNewAlert(newAlert) {
    // Only add if it matches current filters
    if (!matchesFilters(newAlert)) {
      return;
    }

    // If we're on the first page, add to the list
    if (offset === 0) {
      alerts = [newAlert, ...alerts];
      // Keep only limit alerts
      if (alerts.length > limit) {
        alerts = alerts.slice(0, limit);
      }
      total += 1;
    } else {
      // If we're on a later page, just update the total
      total += 1;
    }
  }

  onMount(() => {
    // Initial fetch
    fetchAlerts();
    
    // Subscribe to WebSocket alerts (connection managed by App.svelte)
    const unsubscribe = wsAlerts.subscribe(newAlerts => {
      // Only process new alerts that aren't already in our list
      if (newAlerts.length > 0) {
        const latestAlert = newAlerts[0];
        const exists = alerts.some(alert => alert.id === latestAlert.id || 
          (alert.timestamp === latestAlert.timestamp && alert.title === latestAlert.title));
        
        if (!exists) {
          handleNewAlert(latestAlert);
        }
      }
    });
    
    return () => {
      unsubscribe();
    };
  });
</script>

<div class="alerts-container">
  <div class="filters">
    <div class="filter-group">
      <label for="severity-filter">severity:</label>
      <select id="severity-filter" value={selectedSeverity} on:change={handleSeverityChange}>
        <option value="">all</option>
        {#each severities as severity}
          <option value={severity}>{severity}</option>
        {/each}
      </select>
    </div>

    <div class="filter-group">
      <label for="component-filter">component:</label>
      <select id="component-filter" value={selectedComponent} on:change={handleComponentChange}>
        <option value="">all</option>
        {#each components as component}
          <option value={component}>{component}</option>
        {/each}
      </select>
    </div>

    <div class="filter-group search-group">
      <label for="search-input">search:</label>
      <input
        id="search-input"
        type="text"
        bind:value={searchQuery}
        on:keydown={e => e.key === 'Enter' && handleSearch()}
        placeholder="search title or message..."
      />
      <button class="btn-small" on:click={handleSearch}>search</button>
    </div>

    <div class="filter-actions">
      <button class="btn-small" on:click={handleClearFilters}>clear filters</button>
    </div>
  </div>

  {#if loading && alerts.length === 0}
    <div class="loading">loading alerts...</div>
  {:else if error}
    <div class="error">error: {error}</div>
    <button on:click={fetchAlerts}>retry</button>
  {:else if alerts.length === 0}
    <div class="empty">no alerts found</div>
  {:else}
    <div class="alerts-list">
      {#each alerts as alert}
        <div class="alert-item severity-{getSeverityClass(alert.severity)}">
          <div class="alert-header">
            <span class="severity-badge severity-{getSeverityClass(alert.severity)}">{alert.severity}</span>
            <span class="component-badge">{alert.component}</span>
            <span class="timestamp">{formatRelativeTime(alert.timestamp)}</span>
          </div>
          <div class="alert-title">{alert.title}</div>
          <div class="alert-message">{alert.message}</div>
          {#if alert.operation_id}
            <div class="alert-meta">operation id: <code>{alert.operation_id}</code></div>
          {/if}
          {#if alert.user_id}
            <div class="alert-meta">user id: <code>{alert.user_id}</code></div>
          {/if}
          {#if alert.metadata}
            {@const parsedMetadata = JSON.parse(alert.metadata)}
            {#if parsedMetadata.duration !== undefined}
              <div class="alert-meta">duration: <code>{formatDuration(parsedMetadata.duration)}</code></div>
            {/if}
            <details class="alert-metadata">
              <summary>metadata</summary>
              <pre>{JSON.stringify(getFormattedMetadata(alert), null, 2)}</pre>
            </details>
          {/if}
        </div>
      {/each}
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
</div>

<style>
  .alerts-container {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    max-width: 1400px;
    margin-left: auto;
    margin-right: auto;
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    padding: 1rem;
    background-color: #222;
    border: 1px solid #333;
    border-radius: 4px;
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
    min-width: 250px;
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

  .filter-actions {
    margin-left: auto;
  }

  .alerts-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .alert-item {
    padding: 1.5rem;
    background-color: #222;
    border: 1px solid #333;
    border-left: 4px solid #888;
    border-radius: 4px;
  }

  .alert-item.severity-info {
    border-left-color: #51cf66;
    background-color: rgba(81, 207, 102, 0.05);
  }

  .alert-item.severity-warning {
    border-left-color: #ffd93d;
    background-color: rgba(255, 217, 61, 0.05);
  }

  .alert-item.severity-error {
    border-left-color: #ff6b6b;
    background-color: rgba(255, 107, 107, 0.05);
  }

  .alert-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .severity-badge {
    padding: 0.3rem 0.7rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .severity-badge.severity-info {
    background-color: rgba(81, 207, 102, 0.2);
    color: #51cf66;
  }

  .severity-badge.severity-warning {
    background-color: rgba(255, 217, 61, 0.2);
    color: #ffd93d;
  }

  .severity-badge.severity-error {
    background-color: rgba(255, 107, 107, 0.2);
    color: #ff6b6b;
  }

  .component-badge {
    padding: 0.3rem 0.7rem;
    background-color: #2a2a2a;
    border-radius: 3px;
    font-size: 0.8rem;
    color: #aaa;
  }

  .timestamp {
    margin-left: auto;
    color: #888;
    font-size: 0.85rem;
  }

  .alert-title {
    font-size: 1.1rem;
    font-weight: 500;
    color: #fff;
    margin-bottom: 0.5rem;
  }

  .alert-message {
    color: #e0e0e0;
    font-size: 0.9rem;
    margin-bottom: 0.75rem;
    line-height: 1.6;
  }

  .alert-meta {
    font-size: 0.85rem;
    color: #888;
    margin-top: 0.5rem;
  }

  .alert-meta code {
    background-color: #2a2a2a;
    padding: 0.2rem 0.4rem;
    border-radius: 3px;
    font-family: monospace;
    color: #51cf66;
  }

  .alert-metadata {
    margin-top: 1rem;
  }

  .alert-metadata summary {
    cursor: pointer;
    color: #aaa;
    font-size: 0.85rem;
    user-select: none;
  }

  .alert-metadata summary:hover {
    color: #fff;
  }

  .alert-metadata pre {
    margin-top: 0.5rem;
    padding: 1rem;
    background-color: #0d0d0d;
    border: 1px solid #333;
    border-radius: 3px;
    overflow-x: auto;
    font-size: 0.8rem;
    color: #e0e0e0;
  }

  .pagination {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem;
    background-color: #222;
    border: 1px solid #333;
    border-radius: 4px;
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
    .table-container {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    
    button {
      min-height: 44px;
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
    .filter-group input[type="text"] {
      width: 100%;
    }

    .filter-actions {
      margin-left: 0;
    }

    .alert-header {
      flex-wrap: wrap;
    }

    .timestamp {
      flex-basis: 100%;
      margin-left: 0;
      margin-top: 0.5rem;
    }
  }
</style>

