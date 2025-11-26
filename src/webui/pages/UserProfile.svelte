<script>
  import { onMount } from 'svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { userMetrics as wsUserMetrics, operations as wsOperations, connected as wsConnected } from '../stores/websocket-store.js';

  let user = null;
  let metrics = null;
  let operations = [];
  let operationsTotal = 0;
  let operationsLimit = 7;
  let operationsOffset = 0;
  let operationsLoading = false;
  let operationsError = null;
  let activity = [];
  let media = [];
  let mediaTotal = 0;
  let mediaLimit = 25;
  let mediaOffset = 0;
  let mediaLoading = false;
  let mediaError = null;
  let loading = true;
  let error = null;
  let selectedOperationId = null;
  let operationTrace = null;
  let traceLoading = false;

  $: userId = $currentRoute.params.userId;

  async function fetchUserProfile() {
    if (!userId) return;

    loading = true;
    error = null;
    try {
      // Fetch user profile
      const profileResponse = await fetch(`/api/users/${userId}`);
      if (!profileResponse.ok) throw new Error('failed to fetch user profile');
      const profileData = await profileResponse.json();
      user = profileData.user;
      metrics = profileData.metrics;

      // Fetch user operations
      await fetchUserOperations();

      // Fetch user activity (limited to 10 most recent)
      const activityResponse = await fetch(`/api/users/${userId}/activity?limit=10`);
      if (!activityResponse.ok) throw new Error('failed to fetch activity');
      const activityData = await activityResponse.json();
      activity = (activityData.activity || []).slice(0, 10);

      // Fetch user media
      await fetchUserMedia();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  async function fetchUserOperations() {
    if (!userId) return;

    operationsLoading = true;
    operationsError = null;
    try {
      const response = await fetch(`/api/users/${userId}/operations?limit=${operationsLimit}&offset=${operationsOffset}`);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `failed to fetch user operations: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      operations = data.operations || [];
      operationsTotal = data.total || 0;
    } catch (err) {
      console.error('Failed to fetch user operations:', err);
      operationsError = err.message || 'failed to fetch user operations';
      operations = [];
      operationsTotal = 0;
    } finally {
      operationsLoading = false;
    }
  }

  async function fetchUserMedia() {
    if (!userId) return;

    mediaLoading = true;
    mediaError = null;
    try {
      const response = await fetch(`/api/users/${userId}/media?limit=${mediaLimit}&offset=${mediaOffset}`);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `failed to fetch user media: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      media = data.media || [];
      mediaTotal = data.total || 0;
    } catch (err) {
      console.error('Failed to fetch user media:', err);
      mediaError = err.message || 'failed to fetch user media';
      media = [];
      mediaTotal = 0;
    } finally {
      mediaLoading = false;
    }
  }

  function handleMediaPrevPage() {
    if (mediaOffset > 0) {
      mediaOffset = Math.max(0, mediaOffset - mediaLimit);
      fetchUserMedia();
    }
  }

  function handleMediaNextPage() {
    if (mediaOffset + mediaLimit < mediaTotal) {
      mediaOffset += mediaLimit;
      fetchUserMedia();
    }
  }

  function handleOperationsPrevPage() {
    if (operationsOffset > 0) {
      operationsOffset = Math.max(0, operationsOffset - operationsLimit);
      fetchUserOperations();
    }
  }

  function handleOperationsNextPage() {
    if (operationsOffset + operationsLimit < operationsTotal) {
      operationsOffset += operationsLimit;
      fetchUserOperations();
    }
  }

  function truncateUrl(url) {
    if (!url) return 'N/A';
    if (url.length <= 40) return url;
    return url.substring(0, 37) + '...';
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  function formatTimestamp(timestamp) {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    return date.toLocaleString();
  }

  function formatRelativeTime(timestamp) {
    if (!timestamp) return 'N/A';
    const now = Date.now();
    // Convert timestamp to milliseconds if it's in seconds (timestamp < year 2000 in ms)
    const timestampMs = timestamp < 946684800000 ? timestamp * 1000 : timestamp;
    const diff = now - timestampMs;
    
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
    return formatTimestamp(timestampMs);
  }

  function calculateSuccessRate() {
    if (!metrics || !metrics.total_commands) return 0;
    return ((metrics.successful_commands / metrics.total_commands) * 100).toFixed(1);
  }

  function goBack() {
    navigate('users');
  }

  async function fetchOperationTrace(operationId) {
    if (selectedOperationId === operationId && operationTrace) {
      // Already loaded, just toggle
      selectedOperationId = null;
      operationTrace = null;
      return;
    }

    selectedOperationId = operationId;
    traceLoading = true;
    try {
      const response = await fetch(`/api/operations/${operationId}`);
      if (!response.ok) throw new Error('failed to fetch operation trace');
      const data = await response.json();
      console.log('Operation trace API response:', {
        operationId,
        hasTrace: !!data.trace,
        traceLogsCount: data.trace?.logs?.length || 0,
        executionStepsCount: data.trace?.logs?.filter(log => log.step !== 'created' && log.step !== 'status_update' && log.step !== 'error').length || 0,
        trace: data.trace,
      });
      operationTrace = data.trace;
    } catch (err) {
      console.error('Failed to fetch operation trace:', err);
      operationTrace = null;
    } finally {
      traceLoading = false;
    }
  }

  function formatMetadata(metadata) {
    if (!metadata) return null;
    return JSON.stringify(metadata, null, 2);
  }

  onMount(() => {
    fetchUserProfile();
    
    // Subscribe to WebSocket user metrics (connection managed by App.svelte)
    const unsubscribeMetrics = wsUserMetrics.subscribe(metricsMap => {
      if (userId && metricsMap.has(userId)) {
        const updatedMetrics = metricsMap.get(userId);
        if (updatedMetrics) {
          metrics = updatedMetrics;
        }
      }
    });
    
    // Subscribe to WebSocket operations (filtered by current userId)
    const unsubscribeOperations = wsOperations.subscribe(wsOps => {
      if (userId) {
        // Filter operations for this user
        const userOps = wsOps.filter(op => op.userId === userId);
        if (userOps.length > 0) {
          // Refresh current page when new operations arrive via WebSocket
          // This ensures pagination stays in sync with real-time updates
          fetchUserOperations();
        }
      }
    });
    
    return () => {
      unsubscribeMetrics();
      unsubscribeOperations();
    };
  });

  $: if (userId) {
    fetchUserProfile();
    // Reset pagination when userId changes
    mediaOffset = 0;
    operationsOffset = 0;
  }
</script>

{#if loading}
  <div class="loading">loading user profile...</div>
{:else if error}
  <div class="error">error: {error}</div>
  <button on:click={fetchUserProfile}>retry</button>
{:else if !user && !metrics}
  <div class="empty">user not found</div>
  <button on:click={goBack}>back to users</button>
{:else}
  <div class="profile-container">
    <div class="profile-header-section">
      <div class="profile-header">
        <button class="back-btn" on:click={goBack}>← back to users</button>
        <div class="header-info">
          <h2>{metrics?.username || user?.username || 'unknown user'}</h2>
          <div class="user-id">user id: {userId}</div>
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">total commands</div>
          <div class="stat-value">{metrics?.total_commands || 0}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">successful</div>
          <div class="stat-value success">{metrics?.successful_commands || 0}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">failed</div>
          <div class="stat-value error">{metrics?.failed_commands || 0}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">success rate</div>
          <div class="stat-value">{calculateSuccessRate()}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">data processed</div>
          <div class="stat-value">{formatBytes(metrics?.total_file_size || 0)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">last active</div>
          <div class="stat-value">{formatRelativeTime(metrics?.last_command_at)}</div>
        </div>
      </div>

      <div class="commands-breakdown">
        <div class="breakdown-grid">
          <div class="breakdown-item">
            <span class="label">convert</span>
            <span class="value">{metrics?.total_convert || 0}</span>
          </div>
          <div class="breakdown-item">
            <span class="label">download</span>
            <span class="value">{metrics?.total_download || 0}</span>
          </div>
          <div class="breakdown-item">
            <span class="label">optimize</span>
            <span class="value">{metrics?.total_optimize || 0}</span>
          </div>
          <div class="breakdown-item">
            <span class="label">info</span>
            <span class="value">{metrics?.total_info || 0}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="operations-section">
      <h3>recent operations</h3>
      {#if operationsLoading}
        <div class="loading-inline">loading operations...</div>
      {:else if operationsError}
        <div class="error-inline">error: {operationsError}</div>
        <button class="retry-btn" on:click={fetchUserOperations}>retry</button>
      {:else if operations.length > 0}
        <div class="operations-table-container">
          <table class="operations-table">
            <thead>
              <tr>
                <th class="col-type">type</th>
                <th class="col-status">status</th>
                <th class="col-time">time</th>
                <th class="col-size">file size</th>
                <th class="col-error">error</th>
                <th class="col-actions">actions</th>
              </tr>
            </thead>
            <tbody>
              {#each operations as operation}
                <tr class:error={operation.status === 'error'} class:selected={selectedOperationId === operation.id}>
                  <td class="op-type">{operation.type}</td>
                  <td class="op-status">
                    <span class="operation-status status-{operation.status}">{operation.status}</span>
                  </td>
                  <td class="op-time">{formatRelativeTime(operation.timestamp)}</td>
                  <td class="op-size">{operation.fileSize ? formatBytes(operation.fileSize) : '—'}</td>
                  <td class="op-error" class:has-error={operation.error}>{operation.error || '—'}</td>
                  <td class="op-actions">
                    <button 
                      class="trace-btn" 
                      on:click={() => fetchOperationTrace(operation.id)}
                      title="view detailed trace"
                    >
                      {selectedOperationId === operation.id ? 'hide trace' : 'view trace'}
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if operationsTotal > operationsLimit}
          <div class="operations-pagination">
            <div class="pagination-info">
              showing {operationsOffset + 1}-{Math.min(operationsOffset + operationsLimit, operationsTotal)} of {operationsTotal}
            </div>
            <div class="pagination-controls">
              <button on:click={handleOperationsPrevPage} disabled={operationsOffset === 0}>
                previous
              </button>
              <button on:click={handleOperationsNextPage} disabled={operationsOffset + operationsLimit >= operationsTotal}>
                next
              </button>
            </div>
          </div>
        {/if}
      {:else}
        <div class="empty-state">no operations found</div>
      {/if}
    </div>

    {#if selectedOperationId && operationTrace}
      <div class="trace-section">
        <h3>operation trace: {selectedOperationId}</h3>
        {#if traceLoading}
          <div class="loading">loading trace...</div>
        {:else if operationTrace}
          <div class="trace-container">
            <div class="trace-context">
              <h4>context</h4>
              <div class="context-grid">
                <div class="context-item highlight">
                  <span class="context-label">command source:</span>
                  <span class="context-value">
                    {#if operationTrace.context.commandSource === 'slash'}
                      <span class="badge badge-slash">slash command</span>
                    {:else if operationTrace.context.commandSource === 'context-menu'}
                      <span class="badge badge-context">context menu</span>
                    {:else}
                      <span class="badge badge-unknown">unknown</span>
                    {/if}
                  </span>
                </div>
                <div class="context-item highlight">
                  <span class="context-label">input type:</span>
                  <span class="context-value">
                    {#if operationTrace.context.inputType === 'url'}
                      <span class="badge badge-url">url</span>
                    {:else if operationTrace.context.inputType === 'file'}
                      <span class="badge badge-file">file</span>
                    {:else}
                      <span class="badge badge-unknown">unknown</span>
                    {/if}
                  </span>
                </div>
                {#if operationTrace.context.originalUrl}
                  <div class="context-item">
                    <span class="context-label">original url:</span>
                    <span class="context-value">
                      <a href={operationTrace.context.originalUrl} target="_blank" rel="noopener noreferrer">
                        {truncateUrl(operationTrace.context.originalUrl)}
                      </a>
                    </span>
                  </div>
                {/if}
                {#if operationTrace.context.attachment}
                  <div class="context-item">
                    <span class="context-label">attachment:</span>
                    <span class="context-value">
                      {operationTrace.context.attachment.name || 'N/A'} 
                      {operationTrace.context.attachment.size ? `(${formatBytes(operationTrace.context.attachment.size)})` : ''}
                    </span>
                  </div>
                  {#if operationTrace.context.attachment.contentType}
                    <div class="context-item">
                      <span class="context-label">content type:</span>
                      <span class="context-value">{operationTrace.context.attachment.contentType}</span>
                    </div>
                  {/if}
                {/if}
                {#if operationTrace.context.commandOptions}
                  <div class="context-item">
                    <span class="context-label">command options:</span>
                    <span class="context-value">{formatMetadata(operationTrace.context.commandOptions)}</span>
                  </div>
                {/if}
                <div class="context-item">
                  <span class="context-label">operation type:</span>
                  <span class="context-value">{operationTrace.context.operationType || 'N/A'}</span>
                </div>
              </div>
            </div>

            <div class="trace-steps">
              {#if operationTrace.logs}
                {@const executionSteps = operationTrace.logs.filter(log => log.step !== 'created' && log.step !== 'status_update' && log.step !== 'error')}
                <h4>execution steps ({executionSteps.length})</h4>
                {#if executionSteps.length > 0}
                  <div class="steps-list">
                    {#each executionSteps as log}
                    <div class="trace-step" class:error={log.status === 'error'}>
                      <div class="step-header">
                        <span class="step-name">{log.step}</span>
                        <span class="step-status status-{log.status}">{log.status}</span>
                        <span class="step-time">{formatRelativeTime(log.timestamp)}</span>
                      </div>
                      {#if log.message}
                        <div class="step-message">{log.message}</div>
                      {/if}
                      {#if log.metadata}
                        <details class="step-metadata">
                          <summary>metadata</summary>
                          <pre class="metadata-content">{formatMetadata(log.metadata)}</pre>
                        </details>
                      {/if}
                      {#if log.stack_trace}
                        <details class="step-stack">
                          <summary>stack trace</summary>
                          <pre class="stack-content">{log.stack_trace}</pre>
                        </details>
                      {/if}
                      {#if log.file_path}
                        <div class="step-file">file: {log.file_path}</div>
                      {/if}
                    </div>
                    {/each}
                  </div>
                {:else}
                  <div class="empty-state">no execution steps available for this operation</div>
                {/if}
              {:else}
                <h4>execution steps (0)</h4>
                <div class="empty-state">no execution steps available for this operation</div>
              {/if}
            </div>

            {#if operationTrace.errorSteps.length > 0}
              <div class="trace-errors">
                <h4>errors ({operationTrace.errorSteps.length})</h4>
                {#each operationTrace.errorSteps as errorLog}
                  <div class="error-item">
                    <div class="error-step">{errorLog.step}</div>
                    <div class="error-message">{errorLog.message}</div>
                    {#if errorLog.metadata}
                      <details class="error-metadata">
                        <summary>error details</summary>
                        <pre class="metadata-content">{formatMetadata(errorLog.metadata)}</pre>
                      </details>
                    {/if}
                    {#if errorLog.stack_trace}
                      <details class="error-stack">
                        <summary>stack trace</summary>
                        <pre class="stack-content">{errorLog.stack_trace}</pre>
                      </details>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <div class="media-section">
      <h3>user media</h3>
      {#if mediaLoading}
        <div class="loading-inline">loading media...</div>
      {:else if mediaError}
        <div class="error-inline">error: {mediaError}</div>
        <button class="retry-btn" on:click={fetchUserMedia}>retry</button>
      {:else if media.length > 0}
        <div class="media-table-container">
          <table class="media-table">
            <thead>
              <tr>
                <th>url</th>
                <th>file type</th>
                <th>date</th>
                <th>size</th>
              </tr>
            </thead>
            <tbody>
              {#each media as item}
                <tr>
                  <td class="url-cell">
                    <a href={item.file_url} target="_blank" rel="noopener noreferrer" title={item.file_url}>
                      {truncateUrl(item.file_url)}
                    </a>
                  </td>
                  <td class="type-cell">{item.file_type || 'N/A'}</td>
                  <td class="date-cell">{formatTimestamp(item.processed_at)}</td>
                  <td class="size-cell">{item.file_size ? formatBytes(item.file_size) : 'N/A'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if mediaTotal > mediaLimit}
          <div class="media-pagination">
            <div class="pagination-info">
              showing {mediaOffset + 1}-{Math.min(mediaOffset + mediaLimit, mediaTotal)} of {mediaTotal}
            </div>
            <div class="pagination-controls">
              <button on:click={handleMediaPrevPage} disabled={mediaOffset === 0}>
                previous
              </button>
              <button on:click={handleMediaNextPage} disabled={mediaOffset + mediaLimit >= mediaTotal}>
                next
              </button>
            </div>
          </div>
        {/if}
      {:else}
        <div class="empty-state">no media found</div>
      {/if}
    </div>

    {#if activity.length > 0}
      <div class="activity-section">
        <h3>activity timeline</h3>
        <div class="activity-table-container">
          <table class="activity-table">
            <thead>
              <tr>
                <th>time</th>
                <th>level</th>
                <th>message</th>
              </tr>
            </thead>
            <tbody>
              {#each activity as log}
                <tr>
                  <td class="activity-time">{formatRelativeTime(log.timestamp)}</td>
                  <td><span class="activity-level level-{log.level.toLowerCase()}">{log.level}</span></td>
                  <td class="activity-message">{log.message}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .profile-container {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .profile-header-section {
    padding: 1rem;
    background-color: #222;
    border: 1px solid #333;
    border-radius: 4px;
  }

  .profile-header {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .header-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .back-btn {
    align-self: flex-start;
    background: none;
    border: 1px solid #444;
    color: #aaa;
    padding: 0.5rem 1rem;
    cursor: pointer;
    font-size: 0.9rem;
    border-radius: 3px;
  }

  .back-btn:hover {
    background-color: #2a2a2a;
    color: #fff;
  }

  .profile-header h2 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 500;
    color: #fff;
  }

  .user-id {
    font-size: 0.85rem;
    color: #888;
    font-family: monospace;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .stat-card {
    display: flex;
    flex-direction: column;
    padding: 0.5rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 3px;
    position: relative;
  }

  .stat-label {
    font-size: 0.8rem;
    color: #aaa;
    align-self: flex-start;
    margin-bottom: auto;
  }

  .stat-value {
    font-size: 1.5rem;
    font-weight: 600;
    color: #51cf66;
    flex-grow: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
  }

  .stat-value.success {
    color: #51cf66;
  }

  .stat-value.error {
    color: #ff6b6b;
  }

  .commands-breakdown {
    margin-top: 0.5rem;
  }

  .breakdown-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.5rem;
  }

  .breakdown-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem;
    background-color: #1a1a1a;
    border-radius: 3px;
  }

  .breakdown-item .label {
    color: #aaa;
    font-size: 0.8rem;
  }

  .breakdown-item .value {
    color: #fff;
    font-weight: 500;
    font-size: 0.95rem;
  }

  .operations-section,
  .activity-section,
  .media-section {
    padding: 1rem;
    background-color: #222;
    border: 1px solid #333;
    border-radius: 4px;
  }

  .operations-section h3,
  .activity-section h3,
  .media-section h3 {
    margin: 0 0 0.75rem 0;
    font-size: 1rem;
    font-weight: 500;
    color: #fff;
  }

  .operations-table-container {
    overflow-x: auto;
  }

  .operations-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
    table-layout: fixed;
  }

  .operations-table thead {
    background-color: #2a2a2a;
  }

  .operations-table th {
    padding: 0.5rem;
    text-align: left;
    font-weight: 500;
    color: #aaa;
    border-bottom: 1px solid #333;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    vertical-align: middle;
  }

  .operations-table th.col-type {
    width: 10%;
  }

  .operations-table th.col-status {
    width: 12%;
  }

  .operations-table th.col-time {
    width: 10%;
  }

  .operations-table th.col-size {
    width: 12%;
  }

  .operations-table th.col-error {
    width: 36%;
    padding: 0.5rem;
    padding-left: 0.5rem;
    padding-right: 0.5rem;
    text-align: left !important;
    margin: 0;
  }

  .operations-table th.col-actions {
    width: 20%;
  }

  .operations-table tbody tr {
    border-bottom: 1px solid #2a2a2a;
  }

  .operations-table tbody tr:hover {
    background-color: #2a2a2a;
  }

  .operations-table tbody tr.error {
    background-color: rgba(255, 107, 107, 0.05);
  }

  .operations-table tbody tr.error td {
    text-align: left;
  }

  .operations-table td {
    padding: 0.5rem;
    color: #e0e0e0;
    vertical-align: middle;
    text-align: left;
    margin: 0;
    border: none;
    box-sizing: border-box;
  }

  .operations-table td > * {
    vertical-align: middle;
  }

  .op-type {
    font-weight: 500;
    text-transform: capitalize;
    text-align: left;
  }

  .op-status {
    text-align: left;
  }

  .op-time {
    color: #888;
    font-size: 0.8rem;
    text-align: left;
  }

  .op-size {
    color: #aaa;
    font-size: 0.8rem;
    text-align: left;
  }

  .operations-table td.op-error {
    text-align: left !important;
    padding: 0.5rem;
    padding-left: 0.5rem;
    padding-right: 0.5rem;
    margin: 0;
    color: #aaa;
    font-size: 0.8rem;
    font-family: monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.4;
    text-indent: 0;
  }

  .operations-table td.op-error.has-error {
    color: #ff6b6b;
  }

  .operation-status {
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
    display: inline-block;
    vertical-align: middle;
    line-height: 1.4;
  }

  .status-pending {
    background-color: rgba(136, 136, 136, 0.2);
    color: #888;
  }

  .status-running {
    background-color: rgba(81, 207, 102, 0.2);
    color: #51cf66;
  }

  .status-success {
    background-color: rgba(81, 207, 102, 0.2);
    color: #51cf66;
  }

  .status-error {
    background-color: rgba(255, 107, 107, 0.2);
    color: #ff6b6b;
  }

  .activity-table-container {
    overflow-x: auto;
  }

  .activity-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  .activity-table thead {
    background-color: #2a2a2a;
  }

  .activity-table th {
    padding: 0.5rem;
    text-align: left;
    font-weight: 500;
    color: #aaa;
    border-bottom: 1px solid #333;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .activity-table tbody tr {
    border-bottom: 1px solid #2a2a2a;
  }

  .activity-table tbody tr:hover {
    background-color: #2a2a2a;
  }

  .activity-table td {
    padding: 0.5rem;
    color: #e0e0e0;
  }

  .activity-time {
    color: #888;
    font-size: 0.8rem;
    font-family: monospace;
    white-space: nowrap;
  }

  .activity-level {
    padding: 0.15rem 0.4rem;
    border-radius: 3px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    display: inline-block;
  }

  .level-error {
    background-color: rgba(255, 107, 107, 0.2);
    color: #ff6b6b;
  }

  .level-warn {
    background-color: rgba(255, 217, 61, 0.2);
    color: #ffd93d;
  }

  .level-info {
    background-color: rgba(81, 207, 102, 0.2);
    color: #51cf66;
  }

  .level-debug {
    background-color: rgba(136, 136, 136, 0.2);
    color: #888;
  }

  .activity-message {
    color: #e0e0e0;
    font-size: 0.8rem;
    font-family: monospace;
    max-width: 500px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .media-table-container {
    overflow-x: auto;
    margin-bottom: 1rem;
  }

  .media-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }

  .media-table thead {
    background-color: #2a2a2a;
  }

  .media-table th {
    padding: 0.5rem;
    text-align: left;
    font-weight: 500;
    color: #aaa;
    border-bottom: 1px solid #333;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .media-table tbody tr {
    border-bottom: 1px solid #2a2a2a;
  }

  .media-table tbody tr:hover {
    background-color: #2a2a2a;
  }

  .media-table td {
    padding: 0.5rem;
    color: #e0e0e0;
    font-size: 0.85rem;
  }

  .url-cell {
    max-width: 300px;
  }

  .url-cell a {
    color: #51cf66;
    text-decoration: none;
    word-break: break-all;
  }

  .url-cell a:hover {
    text-decoration: underline;
    color: #69db7c;
  }

  .type-cell {
    text-transform: capitalize;
    color: #aaa;
  }

  .date-cell {
    color: #888;
    font-size: 0.8rem;
  }

  .size-cell {
    color: #888;
    font-size: 0.8rem;
  }

  .media-pagination,
  .operations-pagination {
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

  .loading,
  .error {
    padding: 2rem;
    text-align: center;
  }

  .loading {
    color: #888;
  }

  .error {
    color: #ff6b6b;
  }

  .loading-inline {
    color: #888;
    font-size: 0.85rem;
    padding: 0.5rem 0;
  }

  .empty-state {
    color: #888;
    font-size: 0.85rem;
    padding: 1rem 0;
    text-align: center;
  }

  .error-inline {
    color: #ff6b6b;
    font-size: 0.85rem;
    padding: 0.5rem 0;
  }

  .retry-btn {
    margin-top: 0.5rem;
    padding: 0.4rem 0.8rem;
    font-size: 0.85rem;
    background-color: #444;
    color: #fff;
    border: 1px solid #555;
    cursor: pointer;
    border-radius: 3px;
  }

  .retry-btn:hover {
    background-color: #555;
  }

  @media (max-width: 768px) {
    .stats-grid {
      grid-template-columns: repeat(2, 1fr);
    }

    .breakdown-grid {
      grid-template-columns: repeat(2, 1fr);
    }

    .operations-table,
    .activity-table,
    .media-table {
      font-size: 0.75rem;
    }

    .operations-table th,
    .operations-table td,
    .activity-table th,
    .activity-table td,
    .media-table th,
    .media-table td {
      padding: 0.4rem 0.25rem;
    }

    .url-cell {
      max-width: 150px;
    }

    .op-error,
    .activity-message {
      max-width: 200px;
    }

    .media-pagination,
    .operations-pagination {
      flex-direction: column;
      gap: 0.5rem;
      align-items: flex-start;
    }
  }
  .trace-section {
    padding: 1rem;
    background-color: #222;
    border: 1px solid #333;
    border-radius: 4px;
  }

  .trace-section h3 {
    margin: 0 0 1rem 0;
    font-size: 1.2rem;
    font-weight: 500;
    color: #fff;
  }

  .trace-container {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .trace-context {
    padding: 1rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 3px;
  }

  .trace-context h4 {
    margin: 0 0 0.75rem 0;
    font-size: 1rem;
    font-weight: 500;
    color: #fff;
  }

  .context-grid {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .context-item {
    display: flex;
    gap: 0.5rem;
    font-size: 0.9rem;
  }

  .context-label {
    color: #888;
    min-width: 120px;
  }

  .context-value {
    color: #ccc;
    word-break: break-all;
  }

  .context-value a {
    color: #51cf66;
    text-decoration: none;
  }

  .context-value a:hover {
    text-decoration: underline;
  }

  .context-item.highlight {
    background-color: #2a2a2a;
    padding: 0.75rem;
    border-radius: 3px;
    border-left: 3px solid #51cf66;
  }

  .badge {
    display: inline-block;
    padding: 0.25rem 0.5rem;
    border-radius: 3px;
    font-size: 0.85rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .badge-slash {
    background-color: rgba(81, 207, 102, 0.2);
    color: #51cf66;
  }

  .badge-context {
    background-color: rgba(116, 192, 252, 0.2);
    color: #74c0fc;
  }

  .badge-url {
    background-color: rgba(255, 217, 61, 0.2);
    color: #ffd93d;
  }

  .badge-file {
    background-color: rgba(255, 107, 107, 0.2);
    color: #ff6b6b;
  }

  .badge-unknown {
    background-color: rgba(136, 136, 136, 0.2);
    color: #888;
  }

  .trace-steps {
    padding: 1rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 3px;
  }

  .trace-steps h4 {
    margin: 0 0 0.75rem 0;
    font-size: 1rem;
    font-weight: 500;
    color: #fff;
  }

  .steps-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .trace-step {
    padding: 0.75rem;
    background-color: #111;
    border: 1px solid #333;
    border-radius: 3px;
    border-left: 3px solid #51cf66;
  }

  .trace-step.error {
    border-left-color: #ff6b6b;
  }

  .step-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }

  .step-name {
    font-weight: 500;
    color: #fff;
    font-family: monospace;
    font-size: 0.9rem;
  }

  .step-status {
    padding: 0.2rem 0.5rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .step-status.status-success {
    background-color: #2d5016;
    color: #51cf66;
  }

  .step-status.status-error {
    background-color: #5a1a1a;
    color: #ff6b6b;
  }

  .step-status.status-running {
    background-color: #2d3a50;
    color: #74c0fc;
  }

  .step-time {
    margin-left: auto;
    font-size: 0.8rem;
    color: #888;
  }

  .step-message {
    margin-top: 0.5rem;
    color: #ccc;
    font-size: 0.9rem;
  }

  .step-file {
    margin-top: 0.5rem;
    font-size: 0.85rem;
    color: #888;
    font-family: monospace;
  }

  .step-metadata,
  .step-stack {
    margin-top: 0.5rem;
  }

  .step-metadata summary,
  .step-stack summary {
    cursor: pointer;
    color: #74c0fc;
    font-size: 0.85rem;
    user-select: none;
  }

  .step-metadata summary:hover,
  .step-stack summary:hover {
    color: #99d9ff;
  }

  .metadata-content,
  .stack-content {
    margin-top: 0.5rem;
    padding: 0.75rem;
    background-color: #000;
    border: 1px solid #333;
    border-radius: 3px;
    font-size: 0.8rem;
    color: #ccc;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .trace-errors {
    padding: 1rem;
    background-color: #2a1a1a;
    border: 1px solid #5a3333;
    border-radius: 3px;
  }

  .trace-errors h4 {
    margin: 0 0 0.75rem 0;
    font-size: 1rem;
    font-weight: 500;
    color: #ff6b6b;
  }

  .error-item {
    padding: 0.75rem;
    margin-bottom: 0.5rem;
    background-color: #1a0a0a;
    border: 1px solid #5a3333;
    border-radius: 3px;
  }

  .error-step {
    font-weight: 500;
    color: #ff6b6b;
    font-family: monospace;
    font-size: 0.9rem;
    margin-bottom: 0.25rem;
  }

  .error-message {
    color: #ffaaaa;
    font-size: 0.9rem;
    margin-bottom: 0.5rem;
  }

  .error-metadata,
  .error-stack {
    margin-top: 0.5rem;
  }

  .error-metadata summary,
  .error-stack summary {
    cursor: pointer;
    color: #ff6b6b;
    font-size: 0.85rem;
    user-select: none;
  }

  .error-metadata summary:hover,
  .error-stack summary:hover {
    color: #ff8888;
  }

  .op-actions {
    text-align: center;
    vertical-align: middle;
  }

  .op-actions .trace-btn {
    vertical-align: middle;
  }

  .trace-btn {
    background-color: #2d3a50;
    border: 1px solid #444;
    color: #74c0fc;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    font-size: 0.8rem;
    border-radius: 3px;
  }

  .trace-btn:hover {
    background-color: #3d4a60;
    color: #99d9ff;
  }

  tr.selected {
    background-color: #2a2a2a;
  }
</style>

