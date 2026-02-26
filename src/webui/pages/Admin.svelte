<script>
  import { onMount } from 'svelte';
  import { Archive, Bot, RefreshCw } from 'lucide-svelte';

  // Active section
  let activeSection = 'cleanup';

  // === Bot control state ===
  let botStatus = 'online';
  let botActivity = '';
  let statusUpdating = false;
  let statusFeedback = null;
  let showRestartConfirm = false;
  let restarting = false;

  // === File list state ===
  let files = [];
  let selectedKeys = new Set();
  let maxAgeDays = 3;
  let filesLoading = true;
  let filesError = null;

  // === Cleanup state ===
  let cleanupInProgress = false;
  let cleanupResult = null;
  let cleanupError = null;
  let lastCleanup = null;
  let showConfirmation = false;

  // === Derived values ===
  $: allSelected = files.length > 0 && selectedKeys.size === files.length;
  $: selectedFiles = files.filter(f => selectedKeys.has(f.key));
  $: selectedSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);
  $: selectedSizeFormatted = formatBytes(selectedSize);
  $: totalSize = files.reduce((sum, f) => sum + f.size, 0);
  $: totalSizeFormatted = formatBytes(totalSize);

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  function formatAge(isoDate) {
    const diff = Date.now() - new Date(isoDate).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return 'today';
    if (days === 1) return '1 day ago';
    return `${days} days ago`;
  }

  async function fetchFiles() {
    filesLoading = true;
    filesError = null;
    files = [];
    selectedKeys = new Set();
    showConfirmation = false;
    try {
      const response = await fetch(`/api/management/admin-uploads/files?maxAgeDays=${maxAgeDays}`);
      if (!response.ok) throw new Error('failed to fetch files');
      const data = await response.json();
      if (data.success) {
        files = data.files;
        // Select all by default
        selectedKeys = new Set(files.map(f => f.key));
      } else {
        throw new Error(data.message || 'failed to fetch files');
      }
    } catch (err) {
      filesError = err.message;
    } finally {
      filesLoading = false;
    }
  }

  function toggleAll() {
    if (allSelected) {
      selectedKeys = new Set();
    } else {
      selectedKeys = new Set(files.map(f => f.key));
    }
  }

  function toggleKey(key) {
    const next = new Set(selectedKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    selectedKeys = next;
  }

  function handleCleanupClick() {
    if (selectedKeys.size === 0) return;
    showConfirmation = true;
  }

  function cancelCleanup() {
    showConfirmation = false;
  }

  async function confirmCleanup() {
    if (cleanupInProgress) return;
    showConfirmation = false;
    cleanupInProgress = true;
    cleanupResult = null;
    cleanupError = null;

    try {
      const response = await fetch('/api/management/admin-uploads/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxAgeDays,
          keys: [...selectedKeys],
        }),
      });

      if (!response.ok) throw new Error('cleanup request failed');

      const data = await response.json();
      if (data.success) {
        cleanupResult = data.result;
        lastCleanup = new Date().toLocaleString();
        await fetchFiles();
      } else {
        throw new Error(data.message || 'cleanup failed');
      }
    } catch (err) {
      cleanupError = err.message;
    } finally {
      cleanupInProgress = false;
    }
  }

  async function updateBotStatus() {
    if (statusUpdating) return;
    statusUpdating = true;
    statusFeedback = null;
    try {
      const response = await fetch('/api/management/bot/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: botStatus,
          activity: botActivity || undefined,
        }),
      });
      const data = await response.json();
      if (data.success) {
        statusFeedback = { type: 'success', message: 'presence updated' };
      } else {
        throw new Error(data.message || data.error || 'update failed');
      }
    } catch (err) {
      statusFeedback = { type: 'error', message: err.message };
    } finally {
      statusUpdating = false;
    }
  }

  async function confirmRestart() {
    if (restarting) return;
    showRestartConfirm = false;
    restarting = true;
    try {
      await fetch('/api/management/bot/restart', { method: 'POST' });
    } catch {
      // Expected — the server exits, so the request may fail
    }
  }

  onMount(() => {
    fetchFiles();
  });
</script>

<div class="admin-container">
  <div class="section-tabs">
    <button
      class="section-tab"
      class:active={activeSection === 'cleanup'}
      on:click={() => activeSection = 'cleanup'}
    >
      <Archive size={16} />
      <span>admin cleanup</span>
    </button>
    <button
      class="section-tab"
      class:active={activeSection === 'bot'}
      on:click={() => activeSection = 'bot'}
    >
      <Bot size={16} />
      <span>bot control</span>
    </button>
  </div>

  {#if activeSection === 'cleanup'}
    <!-- Admin Uploads Cleanup Section -->
    <div class="section-content">
      <div class="section-header">
        <p class="section-desc">
          Admin uploads are not tracked for automatic expiration.
          Use this tool to archive and clean up old admin uploads.
          Files are downloaded locally before being deleted from R2.
        </p>
      </div>

      <!-- Controls bar -->
      <div class="controls-bar">
        <div class="age-control">
          <label for="maxAgeDays">older than</label>
          <select id="maxAgeDays" bind:value={maxAgeDays} on:change={fetchFiles}>
            <option value={1}>1 day</option>
            <option value={2}>2 days</option>
            <option value={3}>3 days</option>
            <option value={5}>5 days</option>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
          </select>
        </div>
        <button class="btn-icon" on:click={fetchFiles} disabled={filesLoading} title="refresh">
          <RefreshCw size={14} />
        </button>
      </div>

      {#if filesLoading}
        <div class="loading">loading files...</div>
      {:else if filesError}
        <div class="error-box">
          <span class="error-text">error: {filesError}</span>
          <button class="btn-small" on:click={fetchFiles}>retry</button>
        </div>
      {:else if files.length === 0}
        <div class="empty-state">no expired files found (older than {maxAgeDays} days)</div>
      {:else}
        <!-- Summary bar -->
        <div class="summary-bar">
          <span class="summary-count">
            {files.length} expired {files.length === 1 ? 'file' : 'files'} ({totalSizeFormatted})
          </span>
          <span class="summary-selected">
            {selectedKeys.size} selected ({selectedSizeFormatted})
          </span>
        </div>

        <!-- File list -->
        <div class="file-list">
          <div class="file-header">
            <label class="checkbox-cell">
              <input
                type="checkbox"
                checked={allSelected}
                on:change={toggleAll}
              />
            </label>
            <span class="col-name">file</span>
            <span class="col-size">size</span>
            <span class="col-age">age</span>
          </div>

          {#each files as file (file.key)}
            <label class="file-row" class:selected={selectedKeys.has(file.key)}>
              <span class="checkbox-cell">
                <input
                  type="checkbox"
                  checked={selectedKeys.has(file.key)}
                  on:change={() => toggleKey(file.key)}
                />
              </span>
              <span class="col-name" title={file.key}>{file.key}</span>
              <span class="col-size">{file.sizeFormatted}</span>
              <span class="col-age">{formatAge(file.lastModified)}</span>
            </label>
          {/each}
        </div>

        <!-- Actions -->
        <div class="actions">
          {#if showConfirmation}
            <div class="confirm-box">
              <span class="confirm-text">
                archive & delete {selectedKeys.size} {selectedKeys.size === 1 ? 'file' : 'files'} ({selectedSizeFormatted})?
              </span>
              <button class="btn-danger" on:click={confirmCleanup}>confirm</button>
              <button class="btn-secondary" on:click={cancelCleanup}>cancel</button>
            </div>
          {:else}
            <button
              class="btn-primary"
              on:click={handleCleanupClick}
              disabled={cleanupInProgress || selectedKeys.size === 0}
            >
              {#if cleanupInProgress}
                archiving...
              {:else}
                archive & cleanup ({selectedKeys.size})
              {/if}
            </button>
          {/if}
        </div>

        {#if cleanupResult}
          <div class="result-box">
            <h4>cleanup result</h4>
            <div class="result-stats">
              <span>archived: <strong>{cleanupResult.archived}</strong></span>
              <span>deleted: <strong>{cleanupResult.deleted}</strong></span>
              <span>failed: <strong>{cleanupResult.failed}</strong></span>
            </div>
            {#if cleanupResult.downloadUrl}
              <div class="archive-download">
                <a
                  href={cleanupResult.downloadUrl}
                  class="btn-download"
                  download={cleanupResult.archiveFilename}
                >
                  download archive
                </a>
                <span class="archive-filename">{cleanupResult.archiveFilename}</span>
              </div>
            {/if}
            {#if cleanupResult.errors?.length > 0}
              <details class="errors-details">
                <summary>errors ({cleanupResult.errors.length})</summary>
                <ul>
                  {#each cleanupResult.errors as err}
                    <li><code>{err.key}</code>: {err.error} ({err.phase})</li>
                  {/each}
                </ul>
              </details>
            {/if}
          </div>
        {/if}

        {#if lastCleanup}
          <div class="last-cleanup">
            last cleanup: {lastCleanup}
          </div>
        {/if}
      {/if}

      {#if cleanupError}
        <div class="error-box">
          <span class="error-text">error: {cleanupError}</span>
        </div>
      {/if}
    </div>

  {:else if activeSection === 'bot'}
    <!-- Bot Control Section -->
    <div class="section-content">
      <div class="section-header">
        <p class="section-desc">Control the Discord bot's presence and restart the process.</p>
      </div>

      <!-- Presence controls -->
      <div class="bot-control-group">
        <h4 class="control-label">presence</h4>
        <div class="controls-bar">
          <div class="age-control">
            <label for="botStatus">status</label>
            <select id="botStatus" bind:value={botStatus}>
              <option value="online">online</option>
              <option value="idle">idle</option>
              <option value="dnd">dnd</option>
              <option value="invisible">invisible</option>
            </select>
          </div>
          <input
            type="text"
            class="activity-input"
            bind:value={botActivity}
            placeholder="custom activity text"
          />
          <button
            class="btn-primary"
            on:click={updateBotStatus}
            disabled={statusUpdating}
          >
            {statusUpdating ? 'updating...' : 'update'}
          </button>
        </div>
        {#if statusFeedback}
          <div class="feedback" class:feedback-success={statusFeedback.type === 'success'} class:feedback-error={statusFeedback.type === 'error'}>
            {statusFeedback.message}
          </div>
        {/if}
      </div>

      <!-- Restart control -->
      <div class="bot-control-group">
        <h4 class="control-label">restart</h4>
        <div class="actions">
          {#if restarting}
            <button class="btn-primary" disabled>restarting...</button>
          {:else if showRestartConfirm}
            <div class="confirm-box">
              <span class="confirm-text">
                restart the bot? the dashboard will briefly disconnect.
              </span>
              <button class="btn-danger" on:click={confirmRestart}>confirm</button>
              <button class="btn-secondary" on:click={() => showRestartConfirm = false}>cancel</button>
            </div>
          {:else}
            <button class="btn-danger" on:click={() => showRestartConfirm = true}>
              restart bot
            </button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .admin-container {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    max-width: 1400px;
    margin: 0 auto;
  }

  .section-tabs {
    display: flex;
    gap: 0.5rem;
    border-bottom: 1px solid #333;
    padding-bottom: 0.75rem;
  }

  .section-tab {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 1rem;
    background-color: #2a2a2a;
    color: #aaa;
    border: 1px solid #333;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
    transition: all 0.2s;
  }

  .section-tab:hover {
    background-color: #333;
    color: #fff;
  }

  .section-tab.active {
    background-color: #444;
    color: #fff;
    border-color: #51cf66;
  }

  .section-content {
    background-color: #222;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 1.5rem;
  }

  .section-header {
    margin-bottom: 1.5rem;
  }

  .section-desc {
    margin: 0;
    font-size: 0.85rem;
    color: #888;
    line-height: 1.5;
  }

  /* Controls bar */
  .controls-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .age-control {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: #aaa;
  }

  .age-control select {
    padding: 0.4rem 0.6rem;
    font-size: 0.85rem;
    background-color: #2a2a2a;
    color: #fff;
    border: 1px solid #444;
    border-radius: 4px;
    cursor: pointer;
  }

  .btn-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    background-color: #2a2a2a;
    color: #aaa;
    border: 1px solid #444;
    border-radius: 4px;
    cursor: pointer;
  }

  .btn-icon:hover:not(:disabled) {
    background-color: #333;
    color: #fff;
  }

  .btn-icon:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Summary bar */
  .summary-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 0.75rem;
    background-color: #2a2a2a;
    border: 1px solid #333;
    border-radius: 4px;
    margin-bottom: 0.75rem;
    font-size: 0.85rem;
  }

  .summary-count {
    color: #888;
  }

  .summary-selected {
    color: #51cf66;
    font-weight: 500;
  }

  /* File list */
  .file-list {
    border: 1px solid #333;
    border-radius: 4px;
    margin-bottom: 1rem;
    max-height: 400px;
    overflow-y: auto;
  }

  .file-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    background-color: #2a2a2a;
    border-bottom: 1px solid #333;
    font-size: 0.8rem;
    color: #888;
    text-transform: lowercase;
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #2a2a2a;
    font-size: 0.85rem;
    color: #ccc;
    cursor: pointer;
    transition: background-color 0.1s;
  }

  .file-row:hover {
    background-color: #2a2a2a;
  }

  .file-row.selected {
    background-color: rgba(81, 207, 102, 0.05);
  }

  .file-row:last-child {
    border-bottom: none;
  }

  .checkbox-cell {
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .checkbox-cell input[type='checkbox'] {
    cursor: pointer;
    accent-color: #51cf66;
  }

  .col-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: monospace;
    font-size: 0.8rem;
  }

  .col-size {
    flex-shrink: 0;
    width: 80px;
    text-align: right;
    color: #888;
    font-size: 0.8rem;
  }

  .col-age {
    flex-shrink: 0;
    width: 100px;
    text-align: right;
    color: #888;
    font-size: 0.8rem;
  }

  /* Buttons */
  .actions {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .btn-primary {
    padding: 0.6rem 1.2rem;
    font-size: 0.9rem;
    background-color: #51cf66;
    color: #000;
    border: none;
    cursor: pointer;
    border-radius: 4px;
    font-weight: 500;
  }

  .btn-primary:hover:not(:disabled) {
    background-color: #40c057;
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-secondary {
    padding: 0.6rem 1.2rem;
    font-size: 0.9rem;
    background-color: #444;
    color: #fff;
    border: 1px solid #555;
    cursor: pointer;
    border-radius: 4px;
  }

  .btn-secondary:hover {
    background-color: #555;
  }

  .btn-danger {
    padding: 0.6rem 1.2rem;
    font-size: 0.9rem;
    background-color: #ff6b6b;
    color: #fff;
    border: none;
    cursor: pointer;
    border-radius: 4px;
    font-weight: 500;
  }

  .btn-danger:hover {
    background-color: #fa5252;
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

  /* Confirmation */
  .confirm-box {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background-color: rgba(255, 107, 107, 0.1);
    border: 1px solid #ff6b6b;
    border-radius: 4px;
    flex: 1;
  }

  .confirm-text {
    flex: 1;
    font-size: 0.9rem;
    color: #ff6b6b;
  }

  /* Result box */
  .result-box {
    padding: 1rem;
    background-color: #2a2a2a;
    border: 1px solid #51cf66;
    border-radius: 4px;
    margin-bottom: 1rem;
  }

  .result-box h4 {
    margin: 0 0 0.75rem 0;
    font-size: 0.9rem;
    font-weight: 500;
    color: #51cf66;
  }

  .result-stats {
    display: flex;
    gap: 1.5rem;
    font-size: 0.9rem;
    color: #ccc;
  }

  .result-stats strong {
    color: #fff;
  }

  .archive-download {
    margin-top: 0.75rem;
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .btn-download {
    display: inline-block;
    padding: 0.5rem 1rem;
    font-size: 0.85rem;
    background-color: #228be6;
    color: #fff;
    text-decoration: none;
    border-radius: 4px;
    font-weight: 500;
  }

  .btn-download:hover {
    background-color: #1c7ed6;
  }

  .archive-filename {
    font-size: 0.8rem;
    color: #888;
    font-family: monospace;
  }

  .errors-details {
    margin-top: 0.75rem;
  }

  .errors-details summary {
    cursor: pointer;
    font-size: 0.85rem;
    color: #ff6b6b;
  }

  .errors-details ul {
    margin: 0.5rem 0 0 1rem;
    padding: 0;
    list-style: none;
  }

  .errors-details li {
    font-size: 0.8rem;
    color: #aaa;
    margin-bottom: 0.25rem;
  }

  .errors-details code {
    color: #ff6b6b;
  }

  .last-cleanup {
    font-size: 0.8rem;
    color: #666;
  }

  /* Error box */
  .error-box {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem;
    background-color: rgba(255, 107, 107, 0.1);
    border: 1px solid #ff6b6b;
    border-radius: 4px;
  }

  .error-text {
    color: #ff6b6b;
    flex: 1;
  }

  /* States */
  .loading {
    padding: 2rem;
    text-align: center;
    color: #888;
  }

  .empty-state {
    padding: 2rem;
    text-align: center;
    color: #666;
    font-size: 0.9rem;
  }

  /* Bot control */
  .bot-control-group {
    margin-bottom: 1.5rem;
  }

  .control-label {
    margin: 0 0 0.75rem 0;
    font-size: 0.85rem;
    font-weight: 500;
    color: #aaa;
    text-transform: lowercase;
  }

  .activity-input {
    flex: 1;
    padding: 0.4rem 0.6rem;
    font-size: 0.85rem;
    background-color: #2a2a2a;
    color: #fff;
    border: 1px solid #444;
    border-radius: 4px;
  }

  .activity-input::placeholder {
    color: #666;
  }

  .feedback {
    margin-top: 0.5rem;
    font-size: 0.8rem;
    padding: 0.4rem 0.6rem;
    border-radius: 4px;
  }

  .feedback-success {
    color: #51cf66;
  }

  .feedback-error {
    color: #ff6b6b;
  }

  @media (max-width: 768px) {
    .section-tabs {
      flex-wrap: wrap;
    }

    .section-tab {
      flex: 1;
      justify-content: center;
      min-height: 44px;
    }

    .section-content {
      padding: 1rem;
    }

    .summary-bar {
      flex-direction: column;
      gap: 0.25rem;
      align-items: flex-start;
    }

    .actions {
      flex-direction: column;
    }

    .confirm-box {
      flex-direction: column;
      align-items: stretch;
      text-align: center;
    }

    .result-stats {
      flex-direction: column;
      gap: 0.5rem;
    }

    .col-age {
      display: none;
    }
  }
</style>
