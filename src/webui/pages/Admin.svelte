<script>
  import { onMount } from 'svelte';
  import { Archive, Bot } from 'lucide-svelte';

  // Active section
  let activeSection = 'cleanup';

  // === Management State (Admin uploads cleanup) ===
  let cleanupStats = null;
  let cleanupLoading = true;
  let cleanupError = null;
  let cleanupInProgress = false;
  let cleanupResult = null;
  let lastCleanup = null;

  // === Management Functions (Admin uploads cleanup) ===
  async function fetchCleanupStats() {
    cleanupLoading = true;
    cleanupError = null;
    try {
      const response = await fetch('/api/management/admin-uploads/stats');
      if (!response.ok) throw new Error('failed to fetch stats');
      const data = await response.json();
      if (data.success) {
        cleanupStats = data.stats;
      } else {
        throw new Error(data.message || 'failed to fetch stats');
      }
    } catch (err) {
      cleanupError = err.message;
    } finally {
      cleanupLoading = false;
    }
  }

  async function handleCleanup() {
    if (cleanupInProgress) return;

    cleanupInProgress = true;
    cleanupResult = null;
    cleanupError = null;

    try {
      const response = await fetch('/api/management/admin-uploads/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxAgeDays: 3 }),
      });

      if (!response.ok) throw new Error('cleanup request failed');

      const data = await response.json();
      if (data.success) {
        cleanupResult = data.result;
        lastCleanup = new Date().toLocaleString();
        await fetchCleanupStats();
      } else {
        throw new Error(data.message || 'cleanup failed');
      }
    } catch (err) {
      cleanupError = err.message;
    } finally {
      cleanupInProgress = false;
    }
  }

  onMount(() => {
    fetchCleanupStats();
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
          Use this tool to archive and clean up old admin uploads (older than 3 days).
          Files are downloaded locally before being deleted from R2.
        </p>
      </div>

      {#if cleanupLoading}
        <div class="loading">loading stats...</div>
      {:else if cleanupError}
        <div class="error-box">
          <span class="error-text">error: {cleanupError}</span>
          <button class="btn-small" on:click={fetchCleanupStats}>retry</button>
        </div>
      {:else if cleanupStats}
        <div class="stats-grid">
          <div class="stat-item">
            <span class="stat-label">untracked files</span>
            <span class="stat-value">{cleanupStats.totalFiles}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">total size</span>
            <span class="stat-value">{cleanupStats.totalSizeFormatted}</span>
          </div>
          <div class="stat-item highlight">
            <span class="stat-label">expired files (&gt;{cleanupStats.maxAgeDays} days)</span>
            <span class="stat-value">{cleanupStats.expiredFiles}</span>
          </div>
          <div class="stat-item highlight">
            <span class="stat-label">expired size</span>
            <span class="stat-value">{cleanupStats.expiredSizeFormatted}</span>
          </div>
        </div>

        <div class="actions">
          <button
            class="btn-primary"
            on:click={handleCleanup}
            disabled={cleanupInProgress || cleanupStats.expiredFiles === 0}
          >
            {#if cleanupInProgress}
              archiving...
            {:else}
              archive & cleanup
            {/if}
          </button>
          <button class="btn-secondary" on:click={fetchCleanupStats}>
            refresh stats
          </button>
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
    </div>

  {:else if activeSection === 'bot'}
    <!-- Bot Control Section -->
    <div class="section-content">
      <div class="section-header">
        <p class="section-desc">Control the Discord bot process.</p>
      </div>

      <div class="actions">
        <button class="btn-disabled" disabled title="Coming soon">
          restart bot (coming soon)
        </button>
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

  /* Stats grid */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .stat-item {
    background-color: #2a2a2a;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .stat-item.highlight {
    border-color: #51cf66;
    background-color: rgba(81, 207, 102, 0.1);
  }

  .stat-label {
    font-size: 0.8rem;
    color: #888;
    text-transform: lowercase;
  }

  .stat-value {
    font-size: 1.5rem;
    font-weight: 600;
    color: #fff;
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

  .btn-disabled {
    padding: 0.6rem 1.2rem;
    font-size: 0.9rem;
    background-color: #333;
    color: #666;
    border: 1px solid #444;
    cursor: not-allowed;
    border-radius: 4px;
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

    .stats-grid {
      grid-template-columns: 1fr;
    }

    .actions {
      flex-direction: column;
    }

    .result-stats {
      flex-direction: column;
      gap: 0.5rem;
    }
  }
</style>
