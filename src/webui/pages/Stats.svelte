<script>
  import { onMount } from 'svelte';
  import { fetchStats } from '../utils/api.js';
  import RequestsChart from '../components/RequestsChart.svelte';

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
  <h2>statistics</h2>
  {#if loading && !stats}
    <div class="loading">loading...</div>
  {:else if error}
    <div class="state-error">error: {error}</div>
    <button on:click={loadStats}>retry</button>
  {:else if stats}
    <dl>
      <div class="stat-item">
        <dt>gifs</dt>
        <dd>
          {stats.total_gifs?.toLocaleString() || '0'} ({stats.gifs_disk_usage_formatted ||
            '0.00 MB'})
        </dd>
      </div>
      <div class="stat-item">
        <dt>videos</dt>
        <dd>
          {stats.total_videos?.toLocaleString() || '0'} ({stats.videos_disk_usage_formatted ||
            '0.00 MB'})
        </dd>
      </div>
      <div class="stat-item">
        <dt>images</dt>
        <dd>
          {stats.total_images?.toLocaleString() || '0'} ({stats.images_disk_usage_formatted ||
            '0.00 MB'})
        </dd>
      </div>
      <div class="stat-item">
        <dt>total</dt>
        <dd>
          {(
            (stats.total_gifs || 0) +
            (stats.total_videos || 0) +
            (stats.total_images || 0)
          ).toLocaleString()} ({stats.disk_usage_formatted || '0.00 MB'})
        </dd>
      </div>
      {#if stats.ever_active_users != null}
        <div class="stat-item">
          <dt>bot users</dt>
          <dd>
            {stats.ever_active_users.toLocaleString()}
          </dd>
        </div>
      {/if}
      {#if stats.active_users_7d != null}
        <div class="stat-item">
          <dt>active (7d / 30d)</dt>
          <dd>
            {stats.active_users_7d.toLocaleString()} / {stats.active_users_30d.toLocaleString()}
          </dd>
        </div>
      {/if}
    </dl>
    {#if stats.daily_requests?.length}
      <RequestsChart data={stats.daily_requests} />
    {/if}
  {/if}
</section>

<style>
  section {
    padding: 1rem;
    border: 1px solid var(--border);
    background-color: var(--surface);
    max-width: 100%;
    width: 100%;
  }

  @media (min-width: 1024px) {
    section {
      max-width: 1400px;
    }
  }

  h2 {
    margin: 0 0 0.75rem 0;
    font-size: 1.25rem;
    font-weight: 500;
    color: var(--text-bright);
    border-bottom: 1px solid var(--border);
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
    border-bottom: 1px solid var(--surface-2);
    min-width: 0;
  }

  .stat-item:last-child {
    border-bottom: none;
  }

  dt {
    font-size: 0.9rem;
    color: var(--text-muted);
    font-weight: 400;
  }

  dd {
    margin: 0;
    font-size: 1rem;
    color: var(--text-bright);
    font-weight: 500;
  }

  .loading {
    color: var(--text-dim);
    padding: 1rem 0;
  }

  .state-error {
    color: var(--danger);
    padding: 1rem 0;
    margin-bottom: 1rem;
  }

  button {
    background-color: var(--surface-3);
    color: var(--text-bright);
    border: 1px solid var(--border-2);
    padding: 0.5rem 1rem;
    cursor: pointer;
    font-size: 0.9rem;
    border-radius: var(--radius);
  }

  button:hover {
    background-color: var(--border-2);
  }

  button:active {
    background-color: var(--border);
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
