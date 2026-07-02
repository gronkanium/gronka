<script>
  import { onMount } from 'svelte';
  import { ChevronDown, ChevronRight, Search } from 'lucide-svelte';
  import { operations as wsOperations, connected as wsConnected } from '../stores/websocket-store.js';
  import { navigate } from '../utils/router.js';

  let operations = [];
  let error = null;
  let expandedOperations = new Set();
  
  // Pagination
  let limit = 7;
  let offset = 0;
  
  // Reactive paginated operations list
  $: total = operations.length;
  $: paginatedOperations = operations.slice(offset, offset + limit);

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
    
    // Handle negative differences (future timestamps or clock skew)
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

  function getStatusIcon(status) {
    if (status === 'pending' || status === 'running') {
      return 'loading';
    }
    if (status === 'success') {
      return 'success';
    }
    if (status === 'error') {
      return 'error';
    }
    return 'unknown';
  }

  function toggleExpanded(operationId) {
    if (expandedOperations.has(operationId)) {
      expandedOperations.delete(operationId);
    } else {
      expandedOperations.add(operationId);
    }
    expandedOperations = new Set(expandedOperations);
  }

  function formatDuration(ms) {
    if (!ms) return 'N/A';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(2)}m`;
  }

  function handlePrevPage() {
    if (offset > 0) {
      offset = Math.max(0, offset - limit);
    }
  }

  function handleNextPage() {
    if (offset + limit < total) {
      offset += limit;
    }
  }

  onMount(() => {
    // Subscribe to WebSocket operations (connection managed by App.svelte)
    const unsubscribe = wsOperations.subscribe(wsOps => {
      operations = wsOps || [];
    });
    
    return () => {
      unsubscribe();
    };
  });
</script>

<section class="operations">
  <div class="header-row">
    <h2>recent operations</h2>
    <button class="advanced-search-btn" on:click={() => navigate('operations-debug')}>
      <Search size={16} />
      <span>advanced search</span>
    </button>
  </div>
  {#if error}
    <div class="error">error: {error}</div>
  {:else if !$wsConnected}
    <div class="loading">connecting...</div>
  {:else if operations.length === 0}
    <div class="empty">no operations yet</div>
  {:else}
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Type</th>
            <th>Username</th>
            <th>User ID</th>
            <th>File Size</th>
            <th>Timestamp</th>
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
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="var(--danger)" stroke="var(--text-bright)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2z"/>
                      <path d="M15 9l-6 6M9 9l6 6" stroke="var(--text-bright)" stroke-width="2" stroke-linecap="round"/>
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
              <td class="timestamp-cell">{formatTimestamp(operation.timestamp)}</td>
            </tr>
            {#if expandedOperations.has(operation.id)}
              <tr class="details-row">
                <td colspan="6" class="details-cell">
                  <div class="operation-details">
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

                    {#if operation.performanceMetrics?.steps && operation.performanceMetrics.steps.length > 0}
                      <div class="details-section">
                        <h4>performance steps</h4>
                        <div class="steps-list">
                          {#each operation.performanceMetrics.steps as step}
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
</section>

<style>
  section {
    padding: 1rem;
    border: 1px solid var(--border);
    background-color: var(--surface);
    grid-column: 1 / -1;
    margin-top: 0;
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

  .advanced-search-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background-color: var(--surface-3);
    color: var(--text-bright);
    border: 1px solid var(--border-2);
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 0.85rem;
    transition: background-color 0.2s;
  }

  .advanced-search-btn:hover {
    background-color: var(--border-2);
  }

  .table-container {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
    table-layout: auto;
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
    white-space: nowrap;
  }

  th:nth-child(1) {
    width: 80px;
    min-width: 80px;
    max-width: 80px;
  }

  th:nth-child(2) {
    min-width: 100px;
    max-width: 150px;
  }

  th:nth-child(3) {
    min-width: 120px;
    max-width: 200px;
  }

  th:nth-child(4) {
    min-width: 100px;
    max-width: 150px;
  }

  th:nth-child(5) {
    min-width: 100px;
    max-width: 150px;
  }

  th:nth-child(6) {
    min-width: 120px;
    max-width: 200px;
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
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .status-cell {
    text-align: center;
    width: 60px;
    min-width: 60px;
    max-width: 60px;
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
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .username-cell {
    color: var(--text);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .userid-cell {
    color: var(--text-dim);
    font-family: monospace;
    font-size: 0.85rem;
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .size-cell {
    color: var(--text-muted);
    max-width: 150px;
  }

  .timestamp-cell {
    color: var(--text-muted);
    font-size: 0.85rem;
    max-width: 200px;
    white-space: nowrap;
  }

  .loading {
    color: var(--text-dim);
    padding: 1rem 0;
  }

  .error {
    color: var(--danger);
    padding: 1rem 0;
  }

  .empty {
    color: var(--text-dim);
    padding: 1rem 0;
    text-align: center;
  }

  .expand-cell {
    width: 70px;
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

  .operation-row.expanded {
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

  .stack-trace {
    margin: 0;
    padding: 0.75rem;
    background-color: var(--bg-deep);
    border-radius: var(--radius);
    color: var(--text);
    font-size: 0.75rem;
    overflow-x: auto;
    white-space: pre-wrap;
    word-wrap: break-word;
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
    
    .advanced-search-btn {
      width: 100%;
      justify-content: center;
      min-height: 44px;
    }
    
    .table-container {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    
    table {
      font-size: 0.8rem;
      min-width: 600px;
    }

    th,
    td {
      padding: 0.5rem 0.25rem;
      font-size: 0.75rem;
    }

    .userid-cell {
      font-size: 0.7rem;
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

