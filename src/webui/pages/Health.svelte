<script>
  import { onMount } from 'svelte';
  import { fetchHealth, formatUptime } from '../utils/api.js';

  let health = null;
  let loading = true;
  let error = null;

  async function loadHealth() {
    loading = true;
    error = null;
    try {
      health = await fetchHealth();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    loadHealth();
    const healthInterval = setInterval(loadHealth, 10000);
    return () => clearInterval(healthInterval);
  });
</script>

<section class="health">
  <h2>health status</h2>
  {#if loading && !health}
    <div class="loading">loading...</div>
  {:else if error}
    <div class="state-error">error: {error}</div>
    <button on:click={loadHealth}>retry</button>
  {:else if health}
    <dl>
      <div class="stat-item">
        <dt>status</dt>
        <dd class="status">
          {#if health.status === 'ok'}
            <span class="status-ok">OK</span> <span class="status-code">200</span>
          {:else}
            {health.status || 'unknown'}
          {/if}
        </dd>
      </div>
      <div class="stat-item">
        <dt>uptime</dt>
        <dd>{formatUptime(health.uptime || 0)}</dd>
      </div>
    </dl>
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

  .status {
    text-transform: uppercase;
    font-size: 0.9rem;
  }

  .status-ok {
    color: var(--success);
  }

  .status-code {
    color: var(--text-bright);
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
