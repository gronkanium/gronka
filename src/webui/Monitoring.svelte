<script>
  import { onMount } from 'svelte';
  import { Cpu, HardDrive, Disc, Clock } from 'lucide-svelte';
  import { systemMetrics as wsSystemMetrics, connected as wsConnected } from './websocket-store.js';

  let systemMetrics = null;
  let errorMetrics = null;
  let loading = true;
  let error = null;

  async function fetchSystemMetrics() {
    try {
      const response = await fetch('/api/metrics/system/current');
      if (!response.ok) throw new Error('failed to fetch system metrics');
      systemMetrics = await response.json();
    } catch (err) {
      console.error('Failed to fetch system metrics:', err);
    }
  }

  async function fetchErrorMetrics() {
    try {
      const response = await fetch('/api/metrics/errors');
      if (!response.ok) throw new Error('failed to fetch error metrics');
      errorMetrics = await response.json();
    } catch (err) {
      console.error('Failed to fetch error metrics:', err);
    }
  }

  async function fetchMetrics() {
    loading = true;
    error = null;
    try {
      await Promise.all([fetchSystemMetrics(), fetchErrorMetrics()]);
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  function formatPercentage(value) {
    if (value === null || value === undefined) return 'N/A';
    return `${value.toFixed(1)}%`;
  }

  function formatUptime(seconds) {
    if (!seconds) return 'N/A';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function getHealthStatus(percentage) {
    if (percentage === null || percentage === undefined) return 'unknown';
    if (percentage < 70) return 'good';
    if (percentage < 85) return 'warning';
    return 'critical';
  }

  onMount(() => {
    // Initial fetch for historical data
    fetchMetrics();
    
    // Subscribe to WebSocket system metrics updates (connection managed by App.svelte)
    const unsubscribe = wsSystemMetrics.subscribe(metrics => {
      if (metrics) {
        systemMetrics = metrics;
        loading = false;
      }
    });
    
    return () => {
      unsubscribe();
    };
  });
</script>

<div class="monitoring-container">
  {#if loading && !systemMetrics && !errorMetrics}
    <div class="loading">loading metrics...</div>
  {:else if error}
    <div class="error">error: {error}</div>
    <button on:click={fetchMetrics}>retry</button>
  {:else}
    <!-- System Health -->
    <section class="metrics-section">
      <h3>system health</h3>
      <div class="health-grid">
        <div class="health-card cpu {getHealthStatus(systemMetrics?.cpuUsage)}">
          <div class="health-icon"><Cpu size={32} /></div>
          <div class="health-label">cpu usage</div>
          <div class="health-value">{formatPercentage(systemMetrics?.cpuUsage)}</div>
          <div class="health-bar">
            <div class="health-bar-fill" style="width: {systemMetrics?.cpuUsage || 0}%"></div>
          </div>
        </div>

        <div class="health-card memory {getHealthStatus(systemMetrics?.metadata?.memoryPercentage)}">
          <div class="health-icon"><HardDrive size={32} /></div>
          <div class="health-label">memory usage</div>
          <div class="health-value">{formatPercentage(systemMetrics?.metadata?.memoryPercentage)}</div>
          <div class="health-detail">{formatBytes(systemMetrics?.memoryUsage)} / {formatBytes(systemMetrics?.memoryTotal)}</div>
          <div class="health-bar">
            <div class="health-bar-fill" style="width: {systemMetrics?.metadata?.memoryPercentage || 0}%"></div>
          </div>
        </div>

        <div class="health-card disk {getHealthStatus(systemMetrics?.metadata?.diskPercentage)}">
          <div class="health-icon"><Disc size={32} /></div>
          <div class="health-label">disk usage</div>
          <div class="health-value">{formatPercentage(systemMetrics?.metadata?.diskPercentage)}</div>
          <div class="health-detail">{formatBytes(systemMetrics?.diskUsage)} / {formatBytes(systemMetrics?.diskTotal)}</div>
          <div class="health-bar">
            <div class="health-bar-fill" style="width: {systemMetrics?.metadata?.diskPercentage || 0}%"></div>
          </div>
        </div>

        <div class="health-card uptime good">
          <div class="health-icon"><Clock size={32} /></div>
          <div class="health-label">process uptime</div>
          <div class="health-value">{formatUptime(systemMetrics?.processUptime)}</div>
          <div class="health-detail">memory: {formatBytes(systemMetrics?.processMemory)}</div>
        </div>
      </div>
    </section>

    <!-- Error Metrics -->
    <section class="metrics-section">
      <h3>error metrics (last 24h)</h3>
      <div class="error-stats-grid">
        <div class="stat-card">
          <div class="stat-value error">{errorMetrics?.errorCount24h || 0}</div>
          <div class="stat-label">total errors</div>
        </div>
        <div class="stat-card">
          <div class="stat-value error">{errorMetrics?.errorCount1h || 0}</div>
          <div class="stat-label">errors (last hour)</div>
        </div>
        <div class="stat-card">
          <div class="stat-value warning">{errorMetrics?.warnCount24h || 0}</div>
          <div class="stat-label">total warnings</div>
        </div>
        <div class="stat-card">
          <div class="stat-value warning">{errorMetrics?.warnCount1h || 0}</div>
          <div class="stat-label">warnings (last hour)</div>
        </div>
      </div>
    </section>

    <!-- Errors by Component -->
    {#if errorMetrics?.byComponent && Object.keys(errorMetrics.byComponent).length > 0}
      <section class="metrics-section">
        <h3>errors by component</h3>
        <div class="component-errors">
          {#each Object.entries(errorMetrics.byComponent).sort((a, b) => b[1] - a[1]) as [component, count]}
            <div class="component-item">
              <span class="component-name">{component}</span>
              <span class="component-count">{count}</span>
              <div class="component-bar">
                <div class="component-bar-fill" style="width: {(count / Math.max(...Object.values(errorMetrics.byComponent))) * 100}%"></div>
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Errors by Level -->
    {#if errorMetrics?.byLevel && Object.keys(errorMetrics.byLevel).length > 0}
      <section class="metrics-section">
        <h3>logs by level</h3>
        <div class="level-stats">
          {#each Object.entries(errorMetrics.byLevel).sort((a, b) => b[1] - a[1]) as [level, count]}
            <div class="level-item level-{level.toLowerCase()}">
              <span class="level-badge">{level}</span>
              <span class="level-count">{count.toLocaleString()}</span>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Quick Stats Summary -->
    <section class="metrics-section">
      <h3>summary</h3>
      <div class="summary-grid">
        <div class="summary-item">
          <div class="summary-label">total logs</div>
          <div class="summary-value">{errorMetrics?.total?.toLocaleString() || 0}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">system status</div>
          <div class="summary-value status-{getHealthStatus(Math.max(systemMetrics?.cpuUsage || 0, systemMetrics?.metadata?.memoryPercentage || 0, systemMetrics?.metadata?.diskPercentage || 0))}">
            {getHealthStatus(Math.max(systemMetrics?.cpuUsage || 0, systemMetrics?.metadata?.memoryPercentage || 0, systemMetrics?.metadata?.diskPercentage || 0))}
          </div>
        </div>
      </div>
    </section>
  {/if}
</div>

<style>
  .monitoring-container {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .metrics-section {
    padding: 1.5rem;
    background-color: #222;
    border: 1px solid #333;
    border-radius: 4px;
  }

  .metrics-section h3 {
    margin: 0 0 1.5rem 0;
    font-size: 1.1rem;
    font-weight: 500;
    color: #fff;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .health-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 1rem;
  }

  .health-card {
    padding: 1.5rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .health-card.good {
    border-left: 3px solid #51cf66;
  }

  .health-card.warning {
    border-left: 3px solid #ffd93d;
  }

  .health-card.critical {
    border-left: 3px solid #ff6b6b;
  }

  .health-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: #51cf66;
  }

  .health-label {
    font-size: 0.85rem;
    color: #aaa;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .health-value {
    font-size: 2rem;
    font-weight: 600;
    color: #fff;
  }

  .health-detail {
    font-size: 0.8rem;
    color: #888;
    font-family: monospace;
  }

  .health-bar {
    height: 8px;
    background-color: #0d0d0d;
    border-radius: 4px;
    overflow: hidden;
  }

  .health-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, #51cf66 0%, #ffd93d 70%, #ff6b6b 100%);
    transition: width 0.3s ease;
  }

  .error-stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
  }

  .stat-card {
    padding: 1.5rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 4px;
  }

  .stat-value {
    font-size: 2rem;
    font-weight: 600;
    color: #51cf66;
    margin-bottom: 0.5rem;
  }

  .stat-value.error {
    color: #ff6b6b;
  }

  .stat-value.warning {
    color: #ffd93d;
  }

  .stat-label {
    font-size: 0.85rem;
    color: #aaa;
  }

  .component-errors {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .component-item {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-rows: auto auto;
    gap: 0.5rem;
    align-items: center;
  }

  .component-name {
    color: #e0e0e0;
    font-size: 0.9rem;
  }

  .component-count {
    color: #fff;
    font-weight: 500;
    font-size: 1.1rem;
  }

  .component-bar {
    grid-column: 1 / -1;
    height: 8px;
    background-color: #0d0d0d;
    border-radius: 4px;
    overflow: hidden;
  }

  .component-bar-fill {
    height: 100%;
    background-color: #51cf66;
    transition: width 0.3s ease;
  }

  .level-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .level-item {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem 1.5rem;
    background-color: #1a1a1a;
    border-radius: 4px;
    min-width: 150px;
  }

  .level-item.level-error {
    border-left: 3px solid #ff6b6b;
  }

  .level-item.level-warn {
    border-left: 3px solid #ffd93d;
  }

  .level-item.level-info {
    border-left: 3px solid #51cf66;
  }

  .level-item.level-debug {
    border-left: 3px solid #888;
  }

  .level-badge {
    padding: 0.3rem 0.6rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .level-error .level-badge {
    background-color: rgba(255, 107, 107, 0.2);
    color: #ff6b6b;
  }

  .level-warn .level-badge {
    background-color: rgba(255, 217, 61, 0.2);
    color: #ffd93d;
  }

  .level-info .level-badge {
    background-color: rgba(81, 207, 102, 0.2);
    color: #51cf66;
  }

  .level-debug .level-badge {
    background-color: rgba(136, 136, 136, 0.2);
    color: #888;
  }

  .level-count {
    color: #fff;
    font-weight: 500;
    font-size: 1.25rem;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
  }

  .summary-item {
    padding: 1.5rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 4px;
  }

  .summary-label {
    font-size: 0.85rem;
    color: #aaa;
    margin-bottom: 0.5rem;
  }

  .summary-value {
    font-size: 1.5rem;
    font-weight: 600;
    color: #fff;
    text-transform: capitalize;
  }

  .summary-value.status-good {
    color: #51cf66;
  }

  .summary-value.status-warning {
    color: #ffd93d;
  }

  .summary-value.status-critical {
    color: #ff6b6b;
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

  @media (max-width: 768px) {
    .health-grid {
      grid-template-columns: 1fr;
    }

    .error-stats-grid {
      grid-template-columns: repeat(2, 1fr);
    }

    .summary-grid {
      grid-template-columns: 1fr;
    }
  }
</style>

