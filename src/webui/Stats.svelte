<script>
  import { onMount } from 'svelte';
  import { fetchStats } from './api.js';

  let stats = null;
  let loading = true;
  let error = null;

  async function loadStats() {
    loading = true;
    error = null;
    try {
      stats = await fetchStats();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    loadStats();
    const interval = setInterval(loadStats, 30000);
    return () => clearInterval(interval);
  });
</script>

<section class="stats">
  <h2>Statistics</h2>
  {#if loading && !stats}
    <div class="loading">Loading...</div>
  {:else if error}
    <div class="error">Error: {error}</div>
    <button on:click={loadStats}>Retry</button>
  {:else if stats}
    <dl>
      <div class="stat-item">
        <dt>Total GIFs</dt>
        <dd>{stats.total_gifs?.toLocaleString() || '0'}</dd>
      </div>
      <div class="stat-item">
        <dt>Disk Usage</dt>
        <dd>{stats.disk_usage_formatted || '0.00 MB'}</dd>
      </div>
      <div class="stat-item">
        <dt>Storage Path</dt>
        <dd class="path">{stats.storage_path || 'N/A'}</dd>
      </div>
    </dl>
  {/if}
</section>

<style>
  section {
    padding: 0.5rem;
    border: 1px solid #333;
    background-color: #222;
  }

  h2 {
    margin: 0 0 0.375rem 0;
    font-size: 1.25rem;
    font-weight: 500;
    color: #fff;
    border-bottom: 1px solid #333;
    padding-bottom: 0.25rem;
  }

  dl {
    margin: 0;
    padding: 0;
  }

  .stat-item {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 0.25rem 0;
    border-bottom: 1px solid #2a2a2a;
  }

  .stat-item:last-child {
    border-bottom: none;
  }

  dt {
    font-size: 0.9rem;
    color: #aaa;
    font-weight: 400;
  }

  dd {
    margin: 0;
    font-size: 1rem;
    color: #fff;
    font-weight: 500;
  }

  .path {
    font-family: 'Courier New', monospace;
    font-size: 0.85rem;
    word-break: break-all;
    text-align: right;
    max-width: 60%;
  }

  .loading {
    color: #888;
    padding: 1rem 0;
  }

  .error {
    color: #ff6b6b;
    padding: 1rem 0;
    margin-bottom: 1rem;
  }

  button {
    background-color: #444;
    color: #fff;
    border: 1px solid #555;
    padding: 0.5rem 1rem;
    cursor: pointer;
    font-size: 0.9rem;
    border-radius: 3px;
  }

  button:hover {
    background-color: #555;
  }

  button:active {
    background-color: #333;
  }
</style>

