<script>
  import { onMount, onDestroy } from 'svelte';

  let operations = [];
  let ws = null;
  let connected = false;
  let error = null;

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

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/ws`;

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        connected = true;
        error = null;
      };

      ws.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'operations') {
            // Initial operations list
            operations = message.data || [];
          } else if (message.type === 'operation') {
            // Single operation update
            const updatedOperation = message.data;
            const index = operations.findIndex(op => op.id === updatedOperation.id);
            if (index !== -1) {
              // Update existing operation
              operations[index] = updatedOperation;
              // Trigger reactivity
              operations = [...operations];
            } else {
              // Add new operation at the beginning (newest first)
              operations = [updatedOperation, ...operations];
              // Keep only last 100 operations
              if (operations.length > 100) {
                operations = operations.slice(0, 100);
              }
            }
          }
        } catch (err) {
          console.error('Error parsing websocket message:', err);
        }
      };

      ws.onerror = err => {
        console.error('WebSocket error:', err);
        error = 'connection error';
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
      error = 'failed to connect';
      connected = false;
    }
  }

  onMount(() => {
    connectWebSocket();
  });

  onDestroy(() => {
    if (ws) {
      ws.close();
    }
  });
</script>

<section class="operations">
  <h2>Recent Operations</h2>
  {#if error}
    <div class="error">Error: {error}</div>
  {:else if !connected}
    <div class="loading">Connecting...</div>
  {:else if operations.length === 0}
    <div class="empty">No operations yet</div>
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
          {#each operations as operation (operation.id)}
            <tr>
              <td class="status-cell">
                {#if operation.status === 'pending' || operation.status === 'running'}
                  <div class="spinner"></div>
                {:else if operation.status === 'success'}
                  <span class="status-icon success">✓</span>
                {:else if operation.status === 'error'}
                  <span class="status-icon error">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="#ff6b6b" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
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
              <td class="timestamp-cell">{formatTimestamp(operation.timestamp)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  section {
    padding: 1rem;
    border: 1px solid #333;
    background-color: #222;
    grid-column: 1 / -1;
    margin-top: 0;
  }

  h2 {
    margin: 0 0 0.75rem 0;
    font-size: 1.25rem;
    font-weight: 500;
    color: #fff;
    border-bottom: 1px solid #333;
    padding-bottom: 0.5rem;
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
  }

  .status-icon {
    display: inline-block;
    width: 20px;
    height: 20px;
    line-height: 20px;
    text-align: center;
    border-radius: 50%;
    font-size: 14px;
    font-weight: bold;
  }

  .status-icon.success {
    background-color: #51cf66;
    color: #000;
  }

  .status-icon.error {
    background-color: transparent;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .status-icon.error svg {
    display: block;
    fill: #ff6b6b;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid #444;
    border-top-color: #51cf66;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin: 0 auto;
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

  .timestamp-cell {
    color: #aaa;
    font-size: 0.85rem;
  }

  .loading {
    color: #888;
    padding: 1rem 0;
  }

  .error {
    color: #ff6b6b;
    padding: 1rem 0;
  }

  .empty {
    color: #888;
    padding: 1rem 0;
    text-align: center;
  }

  @media (max-width: 768px) {
    table {
      font-size: 0.8rem;
    }

    th,
    td {
      padding: 0.5rem 0.25rem;
    }

    .userid-cell {
      font-size: 0.75rem;
    }
  }
</style>

