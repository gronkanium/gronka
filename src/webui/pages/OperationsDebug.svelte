<script>
  import { onMount } from 'svelte';
  import { ChevronDown, ChevronRight, Search, Filter, X, Download, Calendar, Clock, FileText } from 'lucide-svelte';
  import { operations as wsOperations, connected as wsConnected } from '../stores/websocket-store.js';
  import { navigate } from '../utils/router.js';

  let operations = [];
  let filteredOperations = [];
  let error = null;
  let loading = false;
  let expandedOperations = new Set();
  let operationTraces = new Map(); // Cache for operation traces
  
  // Search and filters
  let searchOperationId = '';
  let selectedStatuses = new Set(['pending', 'running', 'success', 'error']);
  let selectedTypes = new Set(['convert', 'download', 'optimize', 'info']);
  let searchUserId = '';
  let searchUsername = '';
  let failedOnly = false;
  let dateFrom = '';
  let dateTo = '';
  let minDuration = '';
  let maxDuration = '';
  let minFileSize = '';
  let maxFileSize = '';
  let filtersOpen = true;
  
  // Pagination
  let limit = 20;
  let offset = 0;
  
  // Error analysis
  let errorAnalysis = null;
  let errorAnalysisLoading = false;

  async function applyFilters() {
    if (loading) return; // Prevent concurrent calls
    loading = true;
    try {
      const params = new URLSearchParams();
      
      if (searchOperationId) {
        params.append('operationId', searchOperationId);
      }
      
      if (selectedStatuses.size > 0 && selectedStatuses.size < 4) {
        Array.from(selectedStatuses).forEach(s => params.append('status', s));
      }
      
      if (selectedTypes.size > 0 && selectedTypes.size < 4) {
        Array.from(selectedTypes).forEach(t => params.append('type', t));
      }
      
      if (searchUserId) {
        params.append('userId', searchUserId);
      }
      
      if (searchUsername) {
        params.append('username', searchUsername);
      }
      
      if (failedOnly) {
        params.append('failedOnly', 'true');
      }
      
      if (dateFrom) {
        params.append('dateFrom', new Date(dateFrom).getTime().toString());
      }
      
      if (dateTo) {
        params.append('dateTo', new Date(dateTo).getTime().toString());
      }
      
      if (minDuration) {
        params.append('minDuration', minDuration);
      }
      
      if (maxDuration) {
        params.append('maxDuration', maxDuration);
      }
      
      if (minFileSize) {
        params.append('minFileSize', minFileSize);
      }
      
      if (maxFileSize) {
        params.append('maxFileSize', maxFileSize);
      }
      
      params.append('limit', limit.toString());
      params.append('offset', offset.toString());

      const response = await fetch(`/api/operations/search?${params.toString()}`);
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Search endpoint not found - server may need restart');
        }
        throw new Error(`Failed to search operations: ${response.status}`);
      }
      
      const data = await response.json();
      filteredOperations = data.operations || [];
      error = null;
    } catch (err) {
      error = err.message;
      filteredOperations = [];
      console.error('Error applying filters:', err);
    } finally {
      loading = false;
    }
  }

  async function loadOperationTrace(operationId) {
    if (operationTraces.has(operationId)) {
      return Promise.resolve(operationTraces.get(operationId));
    }
    
    try {
      const response = await fetch(`/api/operations/${operationId}/trace`);
      if (!response.ok) {
        throw new Error('Failed to load trace');
      }
      const data = await response.json();
      const trace = data.trace;
      operationTraces.set(operationId, trace);
      return trace;
    } catch (err) {
      console.error('Failed to load trace:', err);
      return null;
    }
  }

  async function loadErrorAnalysis() {
    errorAnalysisLoading = true;
    try {
      const response = await fetch('/api/operations/errors/analysis');
      if (!response.ok) {
        throw new Error('Failed to load error analysis');
      }
      errorAnalysis = await response.json();
    } catch (err) {
      console.error('Failed to load error analysis:', err);
      errorAnalysis = null;
    } finally {
      errorAnalysisLoading = false;
    }
  }

  function toggleExpanded(operationId) {
    if (expandedOperations.has(operationId)) {
      expandedOperations.delete(operationId);
    } else {
      expandedOperations.add(operationId);
      // Load trace when expanding
      loadOperationTrace(operationId);
    }
    expandedOperations = new Set(expandedOperations);
  }

  function toggleStatus(status) {
    if (selectedStatuses.has(status)) {
      selectedStatuses.delete(status);
    } else {
      selectedStatuses.add(status);
    }
    selectedStatuses = new Set(selectedStatuses);
    offset = 0; // Reset pagination
    applyFilters();
  }

  function toggleType(type) {
    if (selectedTypes.has(type)) {
      selectedTypes.delete(type);
    } else {
      selectedTypes.add(type);
    }
    selectedTypes = new Set(selectedTypes);
    offset = 0; // Reset pagination
    applyFilters();
  }

  function clearFilters() {
    searchOperationId = '';
    selectedStatuses = new Set(['pending', 'running', 'success', 'error']);
    selectedTypes = new Set(['convert', 'download', 'optimize', 'info']);
    searchUserId = '';
    searchUsername = '';
    failedOnly = false;
    dateFrom = '';
    dateTo = '';
    minDuration = '';
    maxDuration = '';
    minFileSize = '';
    maxFileSize = '';
    offset = 0;
    applyFilters();
  }

  function exportOperation(operation) {
    const dataStr = JSON.stringify(operation, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `operation-${operation.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function formatFileSize(bytes) {
    if (bytes === null || bytes === undefined) return 'N/A';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function formatTimestamp(timestamp) {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 0) {
      return 'just now';
    }
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 1) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleString();
  }

  function formatDuration(ms) {
    if (!ms) return 'N/A';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(2)}m`;
  }

  function formatDateInput(date) {
    if (!date) return '';
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function handlePrevPage() {
    if (offset > 0) {
      offset = Math.max(0, offset - limit);
    }
  }

  function handleNextPage() {
    if (offset + limit < filteredOperations.length) {
      offset += limit;
    }
  }

  $: paginatedOperations = filteredOperations.slice(offset, offset + limit);
  $: total = filteredOperations.length;

  onMount(() => {
    // Subscribe to WebSocket operations for real-time updates
    const unsubscribe = wsOperations.subscribe(wsOps => {
      operations = wsOps || [];
    });
    
    // Initial load
    applyFilters();
    loadErrorAnalysis();
    
    return () => {
      unsubscribe();
    };
  });
</script>

<section class="operations-debug">
  <div class="header-row">
    <h2>Operations Debug & Tracing</h2>
    <button class="back-btn" on:click={() => navigate('operations')}>
      ← back to operations
    </button>
  </div>

  <div class="search-section">
    <div class="search-bar">
      <Search size={18} />
      <input
        type="text"
        placeholder="Search by operation ID..."
        bind:value={searchOperationId}
        on:input={() => { offset = 0; lastFilterKey = ''; }}
      />
    </div>
    <button class="filter-toggle" on:click={() => filtersOpen = !filtersOpen}>
      <Filter size={18} />
      <span>filters</span>
    </button>
  </div>

  {#if filtersOpen}
    <div class="filters-panel">
      <div class="filters-header">
        <h3>filters</h3>
        <button class="clear-btn" on:click={clearFilters}>clear all</button>
      </div>
      
      <div class="filters-grid">
        <div class="filter-group">
          <!-- svelte-ignore a11y-label-has-associated-control -->
          <label>status</label>
          <div class="checkbox-group">
            {#each ['pending', 'running', 'success', 'error'] as status}
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  checked={selectedStatuses.has(status)}
                  on:change={() => toggleStatus(status)}
                />
                <span>{status}</span>
              </label>
            {/each}
          </div>
        </div>

        <div class="filter-group">
          <!-- svelte-ignore a11y-label-has-associated-control -->
          <label>type</label>
          <div class="checkbox-group">
            {#each ['convert', 'download', 'optimize', 'info'] as type}
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  checked={selectedTypes.has(type)}
                  on:change={() => toggleType(type)}
                />
                <span>{type}</span>
              </label>
            {/each}
          </div>
        </div>

        <div class="filter-group">
          <!-- svelte-ignore a11y-label-has-associated-control -->
          <label>user id</label>
          <input
            type="text"
            placeholder="Filter by user ID..."
            bind:value={searchUserId}
            on:input={() => { offset = 0; applyFilters(); }}
          />
        </div>

        <div class="filter-group">
          <!-- svelte-ignore a11y-label-has-associated-control -->
          <label>username</label>
          <input
            type="text"
            placeholder="Filter by username..."
            bind:value={searchUsername}
            on:input={() => { offset = 0; applyFilters(); }}
          />
        </div>

        <div class="filter-group">
          <label>
            <input
              type="checkbox"
              bind:checked={failedOnly}
              on:change={() => { offset = 0; applyFilters(); }}
            />
            <span>failed operations only</span>
          </label>
        </div>

        <div class="filter-group">
          <!-- svelte-ignore a11y-label-has-associated-control -->
          <label>date from</label>
          <input
            type="date"
            bind:value={dateFrom}
            on:change={() => { offset = 0; applyFilters(); }}
          />
        </div>

        <div class="filter-group">
          <!-- svelte-ignore a11y-label-has-associated-control -->
          <label>date to</label>
          <input
            type="date"
            bind:value={dateTo}
            on:change={() => { offset = 0; applyFilters(); }}
          />
        </div>

        <div class="filter-group">
          <!-- svelte-ignore a11y-label-has-associated-control -->
          <label>min duration (ms)</label>
          <input
            type="number"
            placeholder="Min duration..."
            bind:value={minDuration}
            on:input={() => { offset = 0; applyFilters(); }}
          />
        </div>

        <div class="filter-group">
          <!-- svelte-ignore a11y-label-has-associated-control -->
          <label>max duration (ms)</label>
          <input
            type="number"
            placeholder="Max duration..."
            bind:value={maxDuration}
            on:input={() => { offset = 0; applyFilters(); }}
          />
        </div>

        <div class="filter-group">
          <!-- svelte-ignore a11y-label-has-associated-control -->
          <label>min file size (bytes)</label>
          <input
            type="number"
            placeholder="Min file size..."
            bind:value={minFileSize}
            on:input={() => { offset = 0; applyFilters(); }}
          />
        </div>

        <div class="filter-group">
          <!-- svelte-ignore a11y-label-has-associated-control -->
          <label>max file size (bytes)</label>
          <input
            type="number"
            placeholder="Max file size..."
            bind:value={maxFileSize}
            on:input={() => { offset = 0; applyFilters(); }}
          />
        </div>
      </div>
    </div>
  {/if}

  {#if errorAnalysis && !errorAnalysisLoading}
    <div class="error-analysis-section">
      <h3>error analysis</h3>
      <div class="error-groups">
        {#each errorAnalysis.groups || [] as group}
          <div class="error-group">
            <div class="error-pattern">{group.pattern}</div>
            <div class="error-count">count: {group.count}</div>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if loading}
    <div class="loading">Loading operations...</div>
  {:else if error}
    <div class="error">Error: {error}</div>
  {:else if filteredOperations.length === 0}
    <div class="empty">No operations found</div>
  {:else}
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Expand</th>
            <th>Status</th>
            <th>Type</th>
            <th>Username</th>
            <th>User ID</th>
            <th>File Size</th>
            <th>Duration</th>
            <th>Timestamp</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each paginatedOperations as operation (operation.id)}
            <tr class="operation-row" class:expanded={expandedOperations.has(operation.id)}>
              <td class="expand-cell">
                <button class="expand-btn" on:click={() => toggleExpanded(operation.id)}>
                  {#if expandedOperations.has(operation.id)}
                    <ChevronDown size={16} />
                  {:else}
                    <ChevronRight size={16} />
                  {/if}
                </button>
              </td>
              <td class="status-cell">
                {#if operation.status === 'pending' || operation.status === 'running'}
                  <div class="spinner"></div>
                {:else if operation.status === 'success'}
                  <span class="status-icon success">✓</span>
                {:else if operation.status === 'error'}
                  <span class="status-icon error">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="#ff6b6b" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2z"/>
                      <path d="M15 9l-6 6M9 9l6 6" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                  </span>
                {:else}
                  <span class="status-icon">?</span>
                {/if}
              </td>
              <td class="type-cell">{operation.type || 'unknown'}</td>
              <td class="username-cell">{operation.username || 'unknown'}</td>
              <td class="userid-cell">{operation.userId || 'N/A'}</td>
              <td class="size-cell">{formatFileSize(operation.fileSize)}</td>
              <td class="duration-cell">{formatDuration(operation.performanceMetrics?.duration)}</td>
              <td class="timestamp-cell">{formatTimestamp(operation.timestamp)}</td>
              <td class="actions-cell">
                <button class="action-btn" on:click={() => exportOperation(operation)} title="Export JSON">
                  <Download size={14} />
                </button>
              </td>
            </tr>
            {#if expandedOperations.has(operation.id)}
              <tr class="details-row">
                <td colspan="9" class="details-cell">
                  <div class="operation-details">
                    {#await loadOperationTrace(operation.id) then trace}
                      {#if trace}
                        <div class="details-section">
                          <h4>full trace</h4>
                          <div class="trace-timeline">
                            {#each trace.logs || [] as log}
                              <div class="trace-entry" class:error={log.status === 'error'}>
                                <div class="trace-time">{formatTimestamp(log.timestamp)}</div>
                                <div class="trace-step">{log.step}</div>
                                <div class="trace-status status-{log.status}">{log.status}</div>
                                {#if log.message}
                                  <div class="trace-message">{log.message}</div>
                                {/if}
                                {#if log.metadata}
                                  <div class="trace-metadata">
                                    <pre>{JSON.stringify(log.metadata, null, 2)}</pre>
                                  </div>
                                {/if}
                              </div>
                            {/each}
                          </div>
                        </div>

                        <div class="details-section">
                          <h4>timeline visualization<span class="hover-hint">hover bars for step details</span></h4>
                          <div class="timeline-viz">
                            {#each trace.logs || [] as log, i}
                              {@const nextLog = trace.logs[i + 1]}
                              {@const duration = nextLog ? nextLog.timestamp - log.timestamp : (trace.logs[trace.logs.length - 1]?.timestamp - log.timestamp)}
                              {@const totalDuration = trace.logs[trace.logs.length - 1]?.timestamp - trace.logs[0]?.timestamp || 1}
                              {@const width = totalDuration > 0 ? Math.max((duration / totalDuration) * 100, 2) : 2}
                              <div class="timeline-bar" class:error={log.status === 'error'} style="width: {width}%">
                                <div class="timeline-label">{log.step}</div>
                                <div class="timeline-duration">{formatDuration(duration)}</div>
                                <div class="timeline-tooltip">
                                  <div class="tooltip-step">{log.step}</div>
                                  <div class="tooltip-duration">{formatDuration(duration)}</div>
                                </div>
                              </div>
                            {/each}
                          </div>
                        </div>
                      {:else}
                        <div class="details-section">
                          <p>No trace data available</p>
                        </div>
                      {/if}
                    {:catch err}
                      <div class="details-section error-section">
                        <p>Failed to load trace: {err.message}</p>
                      </div>
                    {/await}

                    <div class="details-section">
                      <h4>operation info</h4>
                      <div class="info-grid">
                        <div class="info-item">
                          <span class="label">id:</span>
                          <span class="value monospace">{operation.id}</span>
                        </div>
                        <div class="info-item">
                          <span class="label">status:</span>
                          <span class="value status-{operation.status}">{operation.status}</span>
                        </div>
                        {#if operation.performanceMetrics?.duration}
                          <div class="info-item">
                            <span class="label">duration:</span>
                            <span class="value">{formatDuration(operation.performanceMetrics.duration)}</span>
                          </div>
                        {/if}
                      </div>
                    </div>

                    {#if operation.filePaths && operation.filePaths.length > 0}
                      <div class="details-section">
                        <h4>file paths</h4>
                        <ul class="file-paths-list">
                          {#each operation.filePaths as filePath}
                            <li class="monospace">{filePath}</li>
                          {/each}
                        </ul>
                      </div>
                    {/if}

                    {#if operation.error}
                      <div class="details-section error-section">
                        <h4>error</h4>
                        <div class="error-message monospace">{operation.error}</div>
                      </div>
                    {/if}

                    {#if operation.stackTrace}
                      <div class="details-section">
                        <h4>stack trace</h4>
                        <pre class="stack-trace">{operation.stackTrace}</pre>
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
    {#if total > limit}
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
  {/if}
  <img src="/assets/anime-girl-peek.png" alt="Anime girl peek" class="fixed-corner-image fixed-corner-image-right" />
  <img src="/assets/left-anime-girl-peek.png" alt="Anime girl peek left" class="fixed-corner-image fixed-corner-image-left" />
</section>

<style>
  :global(html),
  :global(body),
  :global(.page-content) {
    scrollbar-width: none; /* Firefox */
    -ms-overflow-style: none; /* IE and Edge */
  }

  :global(html)::-webkit-scrollbar,
  :global(body)::-webkit-scrollbar,
  :global(.page-content)::-webkit-scrollbar {
    display: none; /* Chrome, Safari, Opera */
  }

  section {
    padding: 1rem;
    border: 1px solid #333;
    background-color: #222;
    grid-column: 1 / -1;
    margin-top: 0;
    max-width: 1400px;
    margin-left: auto;
    margin-right: auto;
    scrollbar-width: none; /* Firefox */
    -ms-overflow-style: none; /* IE and Edge */
  }

  section::-webkit-scrollbar {
    display: none; /* Chrome, Safari, Opera */
  }

  .header-row {
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

  .back-btn {
    padding: 0.5rem 1rem;
    background-color: #444;
    color: #fff;
    border: 1px solid #555;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85rem;
    transition: background-color 0.2s;
  }

  .back-btn:hover {
    background-color: #555;
  }

  .search-section {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .search-bar {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 3px;
  }

  .search-bar input {
    flex: 1;
    background: none;
    border: none;
    color: #fff;
    font-size: 0.9rem;
    outline: none;
  }

  .filter-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background-color: #444;
    color: #fff;
    border: 1px solid #555;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85rem;
  }

  .filter-toggle:hover {
    background-color: #555;
  }

  .filters-panel {
    padding: 1rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 3px;
    margin-bottom: 1rem;
  }

  .filters-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .filters-header h3 {
    margin: 0;
    font-size: 1rem;
    color: #fff;
  }

  .clear-btn {
    padding: 0.25rem 0.75rem;
    background-color: #444;
    color: #fff;
    border: 1px solid #555;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85rem;
  }

  .clear-btn:hover {
    background-color: #555;
  }

  .filters-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
  }

  .filter-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .filter-group label {
    color: #aaa;
    font-size: 0.85rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .filter-group input[type="text"],
  .filter-group input[type="number"],
  .filter-group input[type="date"] {
    padding: 0.5rem;
    background-color: #222;
    border: 1px solid #333;
    border-radius: 3px;
    color: #fff;
    font-size: 0.85rem;
  }

  .checkbox-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }

  .error-analysis-section {
    padding: 1rem;
    background-color: #1a1a1a;
    border: 1px solid #ff6b6b;
    border-radius: 3px;
    margin-bottom: 1rem;
  }

  .error-analysis-section h3 {
    margin: 0 0 0.75rem 0;
    font-size: 0.9rem;
    color: #ff6b6b;
    text-transform: uppercase;
  }

  .error-groups {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .error-group {
    padding: 0.75rem;
    background-color: #222;
    border-radius: 3px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .error-pattern {
    color: #fff;
    font-size: 0.85rem;
    font-family: monospace;
  }

  .error-count {
    color: #ff6b6b;
    font-size: 0.85rem;
    font-weight: 600;
  }

  .table-container {
    overflow-x: auto;
    scrollbar-width: none; /* Firefox */
    -ms-overflow-style: none; /* IE and Edge */
  }

  .table-container::-webkit-scrollbar {
    display: none; /* Chrome, Safari, Opera */
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }

  thead {
    background-color: #2a2a2a;
  }

  th {
    padding: 0.75rem 0.5rem;
    text-align: left;
    font-weight: 500;
    color: #aaa;
    border-bottom: 1px solid #333;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  tbody tr {
    border-bottom: 1px solid #2a2a2a;
  }

  tbody tr:hover {
    background-color: #2a2a2a;
  }

  td {
    padding: 0.75rem 0.5rem;
    color: #e0e0e0;
  }

  .status-cell {
    text-align: center;
    width: 60px;
    vertical-align: middle;
  }

  .status-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    line-height: 1;
    text-align: center;
    border-radius: 50%;
    font-size: 14px;
    font-weight: bold;
    vertical-align: middle;
  }

  .status-icon.success {
    background-color: #51cf66;
    color: #000;
  }

  .status-icon.error {
    background-color: transparent;
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .status-icon.error svg {
    display: block;
    fill: #ff6b6b;
    width: 20px;
    height: 20px;
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid #444;
    border-top-color: #51cf66;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin: 0 auto;
    display: inline-block;
    vertical-align: middle;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .type-cell {
    text-transform: capitalize;
    color: #fff;
    font-weight: 500;
  }

  .username-cell {
    color: #e0e0e0;
  }

  .userid-cell {
    color: #888;
    font-family: monospace;
    font-size: 0.85rem;
  }

  .size-cell {
    color: #aaa;
  }

  .duration-cell {
    color: #aaa;
    font-family: monospace;
    font-size: 0.85rem;
  }

  .timestamp-cell {
    color: #aaa;
    font-size: 0.85rem;
  }

  .actions-cell {
    text-align: center;
  }

  .action-btn {
    background: none;
    border: none;
    color: #aaa;
    cursor: pointer;
    padding: 0.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .action-btn:hover {
    color: #fff;
  }

  .loading {
    color: #888;
    padding: 1rem 0;
    text-align: center;
  }

  .error {
    color: #ff6b6b;
    padding: 1rem 0;
    text-align: center;
  }

  .empty {
    color: #888;
    padding: 1rem 0;
    text-align: center;
  }

  .expand-cell {
    width: 40px;
    text-align: center;
  }

  .expand-btn {
    background: none;
    border: none;
    color: #aaa;
    cursor: pointer;
    font-size: 0.9rem;
    padding: 0.25rem;
  }

  .expand-btn:hover {
    color: #fff;
  }

  .operation-row.expanded {
    background-color: #2a2a2a;
  }

  .details-row {
    background-color: #1a1a1a;
  }

  .details-cell {
    padding: 0 !important;
    max-width: 0;
    width: 100%;
    overflow: hidden;
  }

  .operation-details {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    width: 100%;
    max-width: 100%;
    overflow-wrap: break-word;
    word-wrap: break-word;
    box-sizing: border-box;
    overflow: hidden;
  }

  .operation-details * {
    max-width: 100%;
    overflow-wrap: break-word;
    word-wrap: break-word;
    box-sizing: border-box;
  }

  .details-section {
    border: 1px solid #333;
    padding: 1rem;
    border-radius: 3px;
    background-color: #222;
    max-width: 100%;
    overflow-wrap: break-word;
    word-wrap: break-word;
    overflow: visible;
    position: relative;
  }

  .details-section h4 {
    margin: 0 0 0.75rem 0;
    font-size: 0.9rem;
    font-weight: 500;
    color: #51cf66;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .hover-hint {
    font-size: 0.7rem;
    font-weight: 400;
    color: #666;
    text-transform: none;
    letter-spacing: normal;
    font-style: italic;
  }

  .trace-timeline {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .trace-entry {
    padding: 0.75rem;
    background-color: #1a1a1a;
    border-radius: 3px;
    border-left: 2px solid #51cf66;
    text-align: left;
  }

  .trace-entry.error {
    border-left-color: #ff6b6b;
    background-color: rgba(255, 107, 107, 0.1);
  }

  .trace-time {
    color: #888;
    font-size: 0.75rem;
    font-family: monospace;
    margin-bottom: 0.25rem;
    text-align: left;
  }

  .trace-step {
    color: #fff;
    font-size: 0.85rem;
    font-weight: 500;
    margin-bottom: 0.25rem;
    text-align: left;
  }

  .trace-status {
    display: inline-block;
    padding: 0.2rem 0.5rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    margin-bottom: 0.25rem;
  }

  .trace-message {
    color: #aaa;
    font-size: 0.85rem;
    margin-top: 0.5rem;
    text-align: left;
  }

  .trace-metadata {
    margin-top: 0.5rem;
  }

  .trace-metadata pre {
    margin: 0;
    padding: 0.5rem;
    background-color: #0d0d0d;
    border-radius: 3px;
    color: #e0e0e0;
    font-size: 0.75rem;
    overflow-x: auto;
    text-align: left;
    overflow-wrap: break-word;
    word-wrap: break-word;
    max-width: 100%;
  }

  .timeline-viz {
    display: flex;
    gap: 2px;
    height: 40px;
    background-color: #1a1a1a;
    border-radius: 3px;
    overflow: visible;
    max-width: 100%;
    position: relative;
  }

  .timeline-bar {
    background-color: #51cf66;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-width: 30px;
    position: relative;
    transition: background-color 0.2s;
    border-right: 1px solid #1a1a1a;
  }

  .timeline-bar:hover {
    background-color: #69db7c;
  }

  .timeline-bar.error {
    background-color: #ff6b6b;
  }

  .timeline-bar.error:hover {
    background-color: #ff8787;
  }

  .timeline-label {
    font-size: 0.7rem;
    color: #000;
    font-weight: 600;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .timeline-duration {
    font-size: 0.65rem;
    color: #000;
    font-family: monospace;
  }

  .timeline-tooltip {
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-bottom: 8px;
    padding: 0.5rem 0.75rem;
    background-color: #0d0d0d;
    border: 1px solid #333;
    border-radius: 4px;
    color: #fff;
    font-size: 0.75rem;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
    z-index: 1000;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
    width: max-content;
    min-width: max-content;
    max-width: none;
  }

  .timeline-tooltip::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 5px solid transparent;
    border-top-color: #0d0d0d;
  }

  .timeline-bar:hover .timeline-tooltip {
    opacity: 1;
  }

  .tooltip-step {
    font-weight: 600;
    margin-bottom: 0.25rem;
    color: #fff;
  }

  .tooltip-duration {
    font-family: monospace;
    color: #aaa;
    font-size: 0.7rem;
  }

  .related-ops {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .related-op-item {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem;
    background-color: #1a1a1a;
    border-radius: 3px;
    max-width: 100%;
    overflow-wrap: break-word;
    word-wrap: break-word;
  }

  .related-op-id {
    font-family: monospace;
    font-size: 0.85rem;
    color: #aaa;
    overflow-wrap: break-word;
    word-wrap: break-word;
    max-width: 100%;
    min-width: 0;
  }

  .related-op-type {
    text-transform: capitalize;
    color: #fff;
    font-weight: 500;
  }

  .related-op-status {
    padding: 0.2rem 0.5rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .related-op-time {
    color: #888;
    font-size: 0.85rem;
    margin-left: auto;
  }

  .info-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 0.75rem;
  }

  .info-item {
    display: flex;
    gap: 0.5rem;
  }

  .info-item .label {
    color: #aaa;
    font-size: 0.85rem;
  }

  .info-item .value {
    color: #fff;
    font-size: 0.85rem;
    font-weight: 500;
    overflow-wrap: break-word;
    word-wrap: break-word;
    min-width: 0;
  }

  .monospace {
    font-family: monospace;
    font-size: 0.85rem;
  }

  .status-pending {
    color: #888;
  }

  .status-running {
    color: #51cf66;
  }

  .status-success {
    color: #51cf66;
  }

  .status-error {
    color: #ff6b6b;
  }

  .file-paths-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .file-paths-list li {
    padding: 0.5rem;
    background-color: #1a1a1a;
    border-left: 2px solid #51cf66;
    color: #aaa;
  }

  .error-section {
    background-color: rgba(255, 107, 107, 0.1);
    border-color: #ff6b6b;
  }

  .error-message {
    padding: 0.75rem;
    background-color: rgba(0, 0, 0, 0.3);
    border-radius: 3px;
    color: #ff6b6b;
    overflow-wrap: break-word;
    word-wrap: break-word;
    max-width: 100%;
  }

  .stack-trace {
    margin: 0;
    padding: 0.75rem;
    background-color: #0d0d0d;
    border-radius: 3px;
    color: #e0e0e0;
    font-size: 0.75rem;
    overflow-x: auto;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: break-word;
    max-width: 100%;
  }

  .pagination {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0;
    margin-top: 0.75rem;
    border-top: 1px solid #333;
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

  @media (max-width: 768px) {
    .filters-grid {
      grid-template-columns: 1fr;
    }

    table {
      font-size: 0.8rem;
    }

    th,
    td {
      padding: 0.5rem 0.25rem;
    }
  }

  .fixed-corner-image {
    position: fixed;
    bottom: 0;
    z-index: 1000;
    max-width: 200px;
    max-height: 200px;
    pointer-events: none;
  }

  .fixed-corner-image-right {
    right: 0;
    transform: scale(1.6);
    transform-origin: bottom right;
  }

  .fixed-corner-image-left {
    left: -32px;
    transform: scale(1.6);
    transform-origin: bottom left;
  }
</style>

