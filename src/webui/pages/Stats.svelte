<script>
  import { onMount } from 'svelte';
  import { fetchStats } from '../utils/api.js';

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
        <dt>GIFs</dt>
        <dd>{stats.total_gifs?.toLocaleString() || '0'} ({stats.gifs_disk_usage_formatted || '0.00 MB'})</dd>
      </div>
      <div class="stat-item">
        <dt>Videos</dt>
        <dd>{stats.total_videos?.toLocaleString() || '0'} ({stats.videos_disk_usage_formatted || '0.00 MB'})</dd>
      </div>
      <div class="stat-item">
        <dt>Images</dt>
        <dd>{stats.total_images?.toLocaleString() || '0'} ({stats.images_disk_usage_formatted || '0.00 MB'})</dd>
      </div>
      <div class="stat-item">
        <dt>Total</dt>
        <dd>{((stats.total_gifs || 0) + (stats.total_videos || 0) + (stats.total_images || 0)).toLocaleString()} ({stats.disk_usage_formatted || '0.00 MB'})</dd>
      </div>
    </dl>
  {/if}
</section>

<style>
  section {
    padding: 1rem;
    border: 1px solid #333;
    background-color: #222;
  }

  h2 {
    margin: 0 0 0.75rem 0;
    font-size: 1.25rem;
    font-weight: 500;
    color: #fff;
    border-bottom: 1px solid #333;
    padding-bottom: 0.5rem;
  }

  dl {
    margin: 0;
    padding: 0;
  }

  .stat-item {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 0.5rem 0;
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
  
  @media (max-width: 768px) {
    section {
      padding: 0.75rem;
    }
    
    h2 {
      font-size: 1rem;
    }
    
    .stat-item {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.25rem;
    }
    
    dt {
      font-size: 0.85rem;
    }
    
    dd {
      font-size: 0.9rem;
    }
    
    button {
      width: 100%;
      min-height: 44px;
    }
  }
</style>

