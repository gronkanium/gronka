<script>
  import { onMount } from 'svelte';
  import { ChevronDown, ChevronRight } from 'lucide-svelte';
  import { operations as wsOperations } from '../stores/websocket-store.js';
  import ResponsiveFilterPanel from '../components/ResponsiveFilterPanel.svelte';
  import ResponsiveSearchBar from '../components/ResponsiveSearchBar.svelte';

  let requests = [];
  let error = null;
  let loading = true;
  let expandedRequests = new Set();

  // Search
  let searchOperationId = '';

  // Filters
  let selectedStatuses = new Set(['pending', 'running', 'success', 'error']);
  let selectedTypes = new Set(['convert', 'download', 'optimize', 'info']);
  let searchUserId = '';
  let searchUsername = '';
  let urlPattern = '';
  let failedOnly = false;
  let earlyFailureOnly = false;
  let dateFrom = '';
  let dateTo = '';
  let minDuration = '';
  let maxDuration = '';
  let minFileSize = '';
  let maxFileSize = '';
  let filtersOpen = true;

  // Sorting
  let sort = 'newest';

  // Pagination
  let limit = 50;
  let offset = 0;
  let total = 0;

  // Trace cache for expanded rows
  let traces = new Map();
  let traceLoading = new Set();

  // Debounced fetching for free-text/numeric inputs (avoids one query per keystroke)
  let debounceTimer = null;
  function debouncedFetch() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      offset = 0;
      fetchRequests();
    }, 300);
  }

  function applyFilters() {
    offset = 0;
    fetchRequests();
  }

  const ALL_STATUSES = ['pending', 'running', 'success', 'error'];
  const ALL_TYPES = ['convert', 'download', 'optimize', 'info'];

  // Filter state lives in the hash query string so reloads and back/forward
  // keep the search. replaceState avoids triggering the hash router.
  function readStateFromUrl() {
    const hash = window.location.hash.slice(1) || '/';
    const queryString = hash.split('?')[1];
    if (!queryString) return;
    const q = new URLSearchParams(queryString);

    searchOperationId = q.get('operationId') || '';
    if (q.get('status')) selectedStatuses = new Set(q.get('status').split(','));
    if (q.get('type')) selectedTypes = new Set(q.get('type').split(','));
    searchUserId = q.get('userId') || '';
    searchUsername = q.get('username') || '';
    urlPattern = q.get('url') || '';
    failedOnly = q.get('failedOnly') === 'true';
    earlyFailureOnly = q.get('earlyFailureOnly') === 'true';
    dateFrom = q.get('dateFrom') || '';
    dateTo = q.get('dateTo') || '';
    minDuration = q.get('minDuration') || '';
    maxDuration = q.get('maxDuration') || '';
    minFileSize = q.get('minFileSize') || '';
    maxFileSize = q.get('maxFileSize') || '';
    sort = q.get('sort') || 'newest';
    offset = parseInt(q.get('offset'), 10) || 0;
  }

  function writeStateToUrl() {
    const q = new URLSearchParams();
    if (searchOperationId) q.set('operationId', searchOperationId);
    if (selectedStatuses.size > 0 && selectedStatuses.size < ALL_STATUSES.length) {
      q.set('status', Array.from(selectedStatuses).join(','));
    }
    if (selectedTypes.size > 0 && selectedTypes.size < ALL_TYPES.length) {
      q.set('type', Array.from(selectedTypes).join(','));
    }
    if (searchUserId) q.set('userId', searchUserId);
    if (searchUsername) q.set('username', searchUsername);
    if (urlPattern) q.set('url', urlPattern);
    if (failedOnly) q.set('failedOnly', 'true');
    if (earlyFailureOnly) q.set('earlyFailureOnly', 'true');
    if (dateFrom) q.set('dateFrom', dateFrom);
    if (dateTo) q.set('dateTo', dateTo);
    if (minDuration) q.set('minDuration', minDuration);
    if (maxDuration) q.set('maxDuration', maxDuration);
    if (minFileSize) q.set('minFileSize', minFileSize);
    if (maxFileSize) q.set('maxFileSize', maxFileSize);
    if (sort !== 'newest') q.set('sort', sort);
    if (offset > 0) q.set('offset', String(offset));
    const qs = q.toString();
    history.replaceState(null, '', qs ? `#/requests?${qs}` : '#/requests');
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

  function toggleExpanded(requestId) {
    if (expandedRequests.has(requestId)) {
      expandedRequests.delete(requestId);
    } else {
      expandedRequests.add(requestId);
      loadTrace(requestId);
    }
    expandedRequests = new Set(expandedRequests);
  }

  async function loadTrace(requestId) {
    if (traces.has(requestId) || traceLoading.has(requestId)) return;
    traceLoading.add(requestId);
    traceLoading = new Set(traceLoading);
    try {
      const response = await fetch(`/api/operations/${requestId}/trace`);
      if (response.ok) {
        const data = await response.json();
        traces.set(requestId, data.trace || null);
      } else {
        traces.set(requestId, null);
      }
    } catch (err) {
      console.error('Failed to load trace:', err);
      traces.set(requestId, null);
    }
    traces = new Map(traces);
    traceLoading.delete(requestId);
    traceLoading = new Set(traceLoading);
  }

  function getErrorTypeLabel(errorType) {
    if (!errorType) return 'N/A';
    return errorType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  function formatDuration(ms) {
    if (!ms) return 'N/A';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(2)}m`;
  }

  function formatFileSize(bytes) {
    if (bytes === null || bytes === undefined) return 'N/A';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function truncateUrl(url, maxLength = 50) {
    if (!url) return 'N/A';
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength - 3) + '...';
  }

  async function fetchRequests(background = false) {
    if (!background) {
      loading = true;
    }
    error = null;
    writeStateToUrl();

    try {
      const params = new URLSearchParams({
        limit: limit.toString(),
        offset: offset.toString(),
      });

      if (searchOperationId) {
        params.append('operationId', searchOperationId);
      }

      if (selectedStatuses.size > 0 && selectedStatuses.size < ALL_STATUSES.length) {
        Array.from(selectedStatuses).forEach(s => params.append('status', s));
      }

      if (selectedTypes.size > 0 && selectedTypes.size < ALL_TYPES.length) {
        Array.from(selectedTypes).forEach(t => params.append('type', t));
      }

      if (searchUserId) {
        params.append('userId', searchUserId);
      }

      if (searchUsername) {
        params.append('username', searchUsername);
      }

      if (urlPattern) {
        params.append('urlPattern', urlPattern);
      }

      if (failedOnly) {
        params.append('failedOnly', 'true');
      }

      if (earlyFailureOnly) {
        params.append('earlyFailureOnly', 'true');
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

      if (sort !== 'newest') {
        params.append('sort', sort);
      }

      const response = await fetch(`/api/requests?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch requests: ${response.statusText}`);
      }

      const data = await response.json();
      requests = data.requests || [];
      total = data.total || 0;
    } catch (err) {
      error = err.message;
      console.error('Error fetching requests:', err);
    } finally {
      loading = false;
    }
  }

  function handlePrevPage() {
    if (offset > 0) {
      offset = Math.max(0, offset - limit);
      fetchRequests();
    }
  }

  function handleNextPage() {
    if (offset + limit < total) {
      offset += limit;
      fetchRequests();
    }
  }

  function toggleStatus(status) {
    if (selectedStatuses.has(status)) {
      selectedStatuses.delete(status);
    } else {
      selectedStatuses.add(status);
    }
    selectedStatuses = new Set(selectedStatuses);
    applyFilters();
  }

  function toggleType(type) {
    if (selectedTypes.has(type)) {
      selectedTypes.delete(type);
    } else {
      selectedTypes.add(type);
    }
    selectedTypes = new Set(selectedTypes);
    applyFilters();
  }

  function clearFilters() {
    searchOperationId = '';
    selectedStatuses = new Set(ALL_STATUSES);
    selectedTypes = new Set(ALL_TYPES);
    searchUserId = '';
    searchUsername = '';
    urlPattern = '';
    failedOnly = false;
    earlyFailureOnly = false;
    dateFrom = '';
    dateTo = '';
    minDuration = '';
    maxDuration = '';
    minFileSize = '';
    maxFileSize = '';
    sort = 'newest';
    applyFilters();
  }

  onMount(() => {
    readStateFromUrl();
    fetchRequests();

    // Live refresh: when the websocket pushes new operations while viewing the
    // first page, silently refetch (throttled) so the list stays current.
    let skippedInitial = false;
    let liveRefreshTimer = null;
    const unsubscribe = wsOperations.subscribe(() => {
      if (!skippedInitial) {
        skippedInitial = true;
        return;
      }
      if (offset !== 0 || liveRefreshTimer) return;
      liveRefreshTimer = setTimeout(() => {
        liveRefreshTimer = null;
        fetchRequests(true);
      }, 2000);
    });

    return () => {
      unsubscribe();
      clearTimeout(liveRefreshTimer);
      clearTimeout(debounceTimer);
    };
  });
</script>

<section class="requests">
  <div class="header-row">
    <h2>all user requests</h2>
  </div>

  <div class="search-section">
    <ResponsiveSearchBar
      placeholder="search by operation ID..."
      bind:value={searchOperationId}
      onSearch={applyFilters}
    />
    <select class="sort-select" bind:value={sort} on:change={applyFilters}>
      <option value="newest">newest first</option>
      <option value="oldest">oldest first</option>
      <option value="slowest">slowest first</option>
      <option value="fastest">fastest first</option>
    </select>
  </div>

  <ResponsiveFilterPanel
    title="filters"
    defaultOpen={filtersOpen}
  >
    <div class="filters-header-actions">
      <button class="clear-btn" on:click={clearFilters}>clear all</button>
    </div>

    <div class="filters-grid">
      <div class="filter-group">
        <!-- svelte-ignore a11y-label-has-associated-control -->
        <label>status</label>
        <div class="checkbox-group">
          {#each ALL_STATUSES as status}
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
          {#each ALL_TYPES as type}
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
        <label>url contains</label>
        <input
          type="text"
          placeholder="filter by URL..."
          bind:value={urlPattern}
          on:input={debouncedFetch}
        />
      </div>

      <div class="filter-group">
        <!-- svelte-ignore a11y-label-has-associated-control -->
        <label>user id</label>
        <input
          type="text"
          placeholder="filter by user ID..."
          bind:value={searchUserId}
          on:input={debouncedFetch}
        />
      </div>

      <div class="filter-group">
        <!-- svelte-ignore a11y-label-has-associated-control -->
        <label>username</label>
        <input
          type="text"
          placeholder="filter by username..."
          bind:value={searchUsername}
          on:input={debouncedFetch}
        />
      </div>

      <div class="filter-group">
        <label>
          <input
            type="checkbox"
            bind:checked={failedOnly}
            on:change={applyFilters}
          />
          <span>failed operations only</span>
        </label>
      </div>

      <div class="filter-group">
        <label>
          <input
            type="checkbox"
            bind:checked={earlyFailureOnly}
            on:change={applyFilters}
          />
          <span>early failures only</span>
        </label>
      </div>

      <div class="filter-group">
        <!-- svelte-ignore a11y-label-has-associated-control -->
        <label>date from</label>
        <input
          type="date"
          bind:value={dateFrom}
          on:change={applyFilters}
        />
      </div>

      <div class="filter-group">
        <!-- svelte-ignore a11y-label-has-associated-control -->
        <label>date to</label>
        <input
          type="date"
          bind:value={dateTo}
          on:change={applyFilters}
        />
      </div>

      <div class="filter-group">
        <!-- svelte-ignore a11y-label-has-associated-control -->
        <label>min duration (ms)</label>
        <input
          type="number"
          placeholder="min duration..."
          bind:value={minDuration}
          on:input={debouncedFetch}
        />
      </div>

      <div class="filter-group">
        <!-- svelte-ignore a11y-label-has-associated-control -->
        <label>max duration (ms)</label>
        <input
          type="number"
          placeholder="max duration..."
          bind:value={maxDuration}
          on:input={debouncedFetch}
        />
      </div>

      <div class="filter-group">
        <!-- svelte-ignore a11y-label-has-associated-control -->
        <label>min file size (bytes)</label>
        <input
          type="number"
          placeholder="min file size..."
          bind:value={minFileSize}
          on:input={debouncedFetch}
        />
      </div>

      <div class="filter-group">
        <!-- svelte-ignore a11y-label-has-associated-control -->
        <label>max file size (bytes)</label>
        <input
          type="number"
          placeholder="max file size..."
          bind:value={maxFileSize}
          on:input={debouncedFetch}
        />
      </div>
    </div>
  </ResponsiveFilterPanel>

  {#if loading}
    <div class="loading">loading operations...</div>
  {:else if error}
    <div class="state-error">error: {error}</div>
  {:else if requests.length === 0}
    <div class="empty">no operations found</div>
  {:else}
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Expand</th>
            <th>Status</th>
            <th>Type</th>
            <th>URL</th>
            <th>Username</th>
            <th>User ID</th>
            <th>Error Type</th>
            <th>Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {#each requests as request (request.id)}
            <tr class="request-row" class:expanded={expandedRequests.has(request.id)} class:early-failure={request.earlyFailure}>
              <td class="expand-cell">
                <button class="expand-btn" on:click={() => toggleExpanded(request.id)}>
                  {#if expandedRequests.has(request.id)}
                    <ChevronDown size={16} />
                  {:else}
                    <ChevronRight size={16} />
                  {/if}
                </button>
              </td>
              <td class="status-cell">
                {#if request.status === 'pending' || request.status === 'running'}
                  <div class="spinner"></div>
                {:else if request.status === 'success'}
                  <span class="status-icon success">✓</span>
                {:else if request.status === 'error'}
                  <span class="status-icon error">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="var(--danger)" stroke="var(--text-bright)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2z"/>
                      <path d="M15 9l-6 6M9 9l6 6" stroke="var(--text-bright)" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                  </span>
                {:else}
                  <span class="status-icon unknown">?</span>
                {/if}
              </td>
              <td class="type-cell">{request.type || 'N/A'}</td>
              <td class="url-cell">
                {#if request.originalUrl}
                  <a href={request.originalUrl} target="_blank" rel="noopener noreferrer" class="url-link" title={request.originalUrl}>
                    {truncateUrl(request.originalUrl)}
                  </a>
                {:else}
                  N/A
                {/if}
              </td>
              <td class="username-cell">{request.username || 'N/A'}</td>
              <td class="userid-cell">{request.userId || 'N/A'}</td>
              <td class="error-type-cell">
                {#if request.errorType}
                  <span class="error-type-badge">{getErrorTypeLabel(request.errorType)}</span>
                {:else}
                  N/A
                {/if}
              </td>
              <td class="timestamp-cell">{formatTimestamp(request.timestamp)}</td>
            </tr>
            {#if expandedRequests.has(request.id)}
              <tr class="details-row">
                <td colspan="8" class="details-cell">
                  <div class="operation-details">
                    <div class="details-section">
                      <h4>operation info</h4>
                      <div class="info-grid">
                        <div class="info-item">
                          <span class="label">id:</span>
                          <span class="value monospace">{request.id}</span>
                        </div>
                        <div class="info-item">
                          <span class="label">status:</span>
                          <span class="value status-{request.status}">{request.status}</span>
                        </div>
                        {#if request.originalUrl}
                          <div class="info-item url-info-item">
                            <span class="label">url:</span>
                            <span class="value">
                              <a href={request.originalUrl} target="_blank" rel="noopener noreferrer" class="url-link-full monospace" title={request.originalUrl}>
                                {request.originalUrl}
                              </a>
                            </span>
                          </div>
                        {/if}
                        {#if request.performanceMetrics?.duration}
                          <div class="info-item">
                            <span class="label">duration:</span>
                            <span class="value">{formatDuration(request.performanceMetrics.duration)}</span>
                          </div>
                        {/if}
                        {#if request.earlyFailure}
                          <div class="info-item">
                            <span class="label">early failure:</span>
                            <span class="value">yes</span>
                          </div>
                          {#if request.errorType}
                            <div class="info-item">
                              <span class="label">error type:</span>
                              <span class="value">{getErrorTypeLabel(request.errorType)}</span>
                            </div>
                          {/if}
                        {/if}
                      </div>
                    </div>

                    {#if request.error}
                      <div class="details-section error-section">
                        <h4>error</h4>
                        <div class="error-message monospace">{request.error}</div>
                      </div>
                    {/if}

                    {#if request.filePaths && request.filePaths.length > 0}
                      <div class="details-section">
                        <h4>file paths</h4>
                        <ul class="file-paths-list">
                          {#each request.filePaths as filePath}
                            <li class="monospace">{filePath}</li>
                          {/each}
                        </ul>
                      </div>
                    {/if}

                    {#if request.fileSize}
                      <div class="details-section">
                        <h4>file size</h4>
                        <p>{formatFileSize(request.fileSize)}</p>
                      </div>
                    {/if}

                    {#if request.performanceMetrics?.steps && request.performanceMetrics.steps.length > 0}
                      <div class="details-section">
                        <h4>performance steps</h4>
                        <div class="steps-list">
                          {#each request.performanceMetrics.steps as step}
                            <div class="step-item">
                              <span class="step-name">{step.step}</span>
                              <span class="step-status status-{step.status}">{step.status}</span>
                              {#if step.duration}
                                <span class="step-duration">{formatDuration(step.duration)}</span>
                              {/if}
                            </div>
                          {/each}
                        </div>
                      </div>
                    {/if}

                    <div class="details-section">
                      <h4>full trace</h4>
                      {#if traceLoading.has(request.id)}
                        <p class="trace-empty">loading trace...</p>
                      {:else if traces.get(request.id)?.logs?.length}
                        <div class="trace-timeline">
                          {#each traces.get(request.id).logs as log}
                            <div class="trace-entry" class:error={log.status === 'error'}>
                              <span class="trace-time">{new Date(log.timestamp).toLocaleTimeString()}</span>
                              <span class="trace-step">{log.step}</span>
                              <span class="trace-status status-{log.status}">{log.status}</span>
                              {#if log.message}
                                <span class="trace-message">{log.message}</span>
                              {/if}
                            </div>
                          {/each}
                        </div>
                      {:else}
                        <p class="trace-empty">no trace data available</p>
                      {/if}
                    </div>
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
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
    </div>
  {/if}
</section>

<style>
  section {
    padding: 1rem;
    border: 1px solid var(--border);
    background-color: var(--surface);
    grid-column: 1 / -1;
    margin-top: 0;
    max-width: 1400px;
    margin-left: auto;
    margin-right: auto;
  }

  .header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  }

  h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 500;
    color: var(--text-bright);
  }

  .search-section {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
    align-items: center;
  }

  .sort-select {
    padding: 0.5rem;
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-bright);
    font-size: 0.85rem;
    cursor: pointer;
    flex-shrink: 0;
  }

  .filters-header-actions {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 1rem;
  }

  .clear-btn {
    padding: 0.25rem 0.75rem;
    background-color: var(--surface-3);
    color: var(--text-bright);
    border: 1px solid var(--border-2);
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 0.85rem;
  }

  .clear-btn:hover {
    background-color: var(--border-2);
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
    color: var(--text-muted);
    font-size: 0.85rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .filter-group input[type="text"],
  .filter-group input[type="number"],
  .filter-group input[type="date"] {
    padding: 0.5rem;
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-bright);
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

  .table-container {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }

  thead {
    background-color: var(--surface-2);
  }

  th {
    padding: 0.75rem 0.5rem;
    text-align: left;
    font-weight: 500;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  tbody tr {
    border-bottom: 1px solid var(--surface-2);
  }

  tbody tr:hover {
    background-color: var(--surface-2);
  }

  td {
    padding: 0.75rem 0.5rem;
    color: var(--text);
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
    font-size: 0.875rem;
    font-weight: bold;
    vertical-align: middle;
  }

  .status-icon.success {
    background-color: var(--success);
    color: #000;
  }

  .status-icon.error {
    background-color: transparent;
    color: var(--text-bright);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .status-icon.error svg {
    display: block;
    fill: var(--danger);
    width: 20px;
    height: 20px;
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--surface-3);
    border-top-color: var(--success);
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
    color: var(--text-bright);
    font-weight: 500;
  }

  .url-cell {
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .url-link {
    color: var(--success);
    text-decoration: none;
    font-family: monospace;
    font-size: 0.85rem;
    word-break: break-all;
  }

  .url-link:hover {
    text-decoration: underline;
    color: var(--success);
  }

  .url-link-full {
    color: var(--success);
    text-decoration: none;
    word-break: break-all;
    display: inline-block;
    max-width: 100%;
  }

  .url-link-full:hover {
    text-decoration: underline;
    color: var(--success);
  }

  .url-info-item {
    grid-column: 1 / -1;
  }

  .username-cell {
    color: var(--text);
  }

  .userid-cell {
    color: var(--text-dim);
    font-family: monospace;
    font-size: 0.85rem;
  }

  .error-type-cell {
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .timestamp-cell {
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .loading {
    color: var(--text-dim);
    padding: 1rem 0;
  }

  .state-error {
    color: var(--danger);
    padding: 1rem 0;
  }

  .empty {
    color: var(--text-dim);
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
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.9rem;
    padding: 0.25rem;
  }

  .expand-btn:hover {
    color: var(--text-bright);
  }

  .request-row.expanded {
    background-color: var(--surface-2);
  }

  .details-row {
    background-color: var(--bg);
  }

  .details-cell {
    padding: 0 !important;
  }

  .operation-details {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    max-width: 100%;
    overflow-x: auto;
  }

  .details-section {
    border: 1px solid var(--border);
    padding: 1rem;
    border-radius: var(--radius);
    background-color: var(--surface);
  }

  .details-section h4 {
    margin: 0 0 0.75rem 0;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--success);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .info-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 0.75rem;
    max-width: 100%;
  }

  .info-item {
    display: flex;
    gap: 0.5rem;
  }

  .info-item .label {
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .info-item .value {
    color: var(--text-bright);
    font-size: 0.85rem;
    font-weight: 500;
  }

  .monospace {
    font-family: monospace;
    font-size: 0.85rem;
  }

  .status-pending {
    color: var(--text-dim);
  }

  .status-running {
    color: var(--success);
  }

  .status-success {
    color: var(--success);
  }

  .status-error {
    color: var(--danger);
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
    background-color: var(--bg);
    border-left: 2px solid var(--success);
    color: var(--text-muted);
  }

  .error-section {
    background-color: rgba(255, 107, 107, 0.1);
    border-color: var(--danger);
  }

  .error-message {
    padding: 0.75rem;
    background-color: rgba(0, 0, 0, 0.3);
    border-radius: var(--radius);
    color: var(--danger);
  }

  .steps-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .step-item {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem;
    background-color: var(--bg);
    border-radius: var(--radius);
  }

  .step-name {
    flex: 1;
    color: var(--text);
    font-size: 0.85rem;
  }

  .step-status {
    padding: 0.2rem 0.5rem;
    border-radius: var(--radius);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .step-duration {
    color: var(--text-muted);
    font-size: 0.85rem;
    font-family: monospace;
  }

  .trace-timeline {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-height: 320px;
    overflow-y: auto;
  }

  .trace-entry {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0.4rem 0.6rem;
    background-color: var(--bg);
    border-radius: var(--radius);
    font-size: 0.8rem;
  }

  .trace-entry.error {
    border-left: 2px solid var(--danger);
  }

  .trace-time {
    color: var(--text-dim);
    font-family: monospace;
    flex-shrink: 0;
  }

  .trace-step {
    color: var(--text-bright);
    font-family: monospace;
    flex-shrink: 0;
  }

  .trace-status {
    text-transform: uppercase;
    font-size: 0.7rem;
    font-weight: 600;
    flex-shrink: 0;
  }

  .trace-message {
    color: var(--text-muted);
    word-break: break-word;
  }

  .trace-empty {
    color: var(--text-dim);
    font-size: 0.85rem;
    margin: 0;
  }

  .pagination {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0;
    margin-top: 0.75rem;
    border-top: 1px solid var(--border);
  }

  .pagination-info {
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .pagination-controls {
    display: flex;
    gap: 0.5rem;
  }

  .pagination-controls button {
    padding: 0.4rem 0.8rem;
    font-size: 0.85rem;
    background-color: var(--surface-3);
    color: var(--text-bright);
    border: 1px solid var(--border-2);
    cursor: pointer;
    border-radius: var(--radius);
  }

  .pagination-controls button:hover:not(:disabled) {
    background-color: var(--border-2);
  }

  .pagination-controls button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (max-width: 768px) {
    section {
      padding: 0.75rem;
    }

    .header-row {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.5rem;
    }

    .header-row h2 {
      font-size: 1rem;
    }

    .search-section {
      flex-direction: column;
      align-items: stretch;
    }

    .sort-select {
      min-height: 44px;
    }

    .table-container {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }

    table {
      font-size: 0.8rem;
      min-width: 800px;
    }

    th,
    td {
      padding: 0.5rem 0.25rem;
      font-size: 0.75rem;
    }

    .status-cell {
      width: 50px;
    }

    .expand-cell {
      width: 35px;
    }

    .expand-btn {
      min-width: 44px;
      min-height: 44px;
    }

    .operation-details {
      padding: 1rem;
      gap: 1rem;
    }

    .details-section {
      padding: 0.75rem;
    }

    .details-section h4 {
      font-size: 0.85rem;
    }

    .info-grid {
      grid-template-columns: 1fr;
      gap: 0.5rem;
    }

    .step-item {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.5rem;
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
  }
</style>
