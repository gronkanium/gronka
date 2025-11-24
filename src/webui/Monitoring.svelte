<script>
  import { onMount } from 'svelte';
  import { Cpu, HardDrive, Disc, Clock, Activity, AlertTriangle, AlertCircle, TrendingUp, TrendingDown, ChevronDown, ChevronUp, Wifi, WifiOff } from 'lucide-svelte';
  import { systemMetrics as wsSystemMetrics, operations as wsOperations, connected as wsConnected } from './websocket-store.js';
  import { fetchStats } from './api.js';

  let systemMetrics = null;
  let errorMetrics = null;
  let storageStats = null;
  let loading = true;
  let error = null;
  let showDetails = {
    components: false,
    levels: false
  };

  // Cache keys for localStorage
  const CACHE_KEYS = {
    errorMetrics: 'monitoring_error_metrics',
    storageStats: 'monitoring_storage_stats',
  };
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // Reactive operations count from WebSocket
  $: operations = $wsOperations || [];
  $: activeOperations = operations.filter(op => op.status === 'running' || op.status === 'pending').length;
  $: completedOperations = operations.filter(op => op.status === 'success' || op.status === 'error').length;

  // Load cached data from localStorage
  function loadCachedData() {
    try {
      // Load error metrics
      const cachedErrorMetrics = localStorage.getItem(CACHE_KEYS.errorMetrics);
      if (cachedErrorMetrics) {
        const parsed = JSON.parse(cachedErrorMetrics);
        if (parsed.data && parsed.timestamp && (Date.now() - parsed.timestamp) < CACHE_TTL) {
          errorMetrics = parsed.data;
          console.log('[Monitoring] Loaded cached error metrics:', parsed.data);
        } else {
          // Clear stale cache
          localStorage.removeItem(CACHE_KEYS.errorMetrics);
        }
      }

      // Load storage stats
      const cachedStorageStats = localStorage.getItem(CACHE_KEYS.storageStats);
      if (cachedStorageStats) {
        const parsed = JSON.parse(cachedStorageStats);
        if (parsed.data && parsed.timestamp && (Date.now() - parsed.timestamp) < CACHE_TTL) {
          storageStats = parsed.data;
        } else {
          // Clear stale cache
          localStorage.removeItem(CACHE_KEYS.storageStats);
        }
      }
    } catch (err) {
      console.warn('Failed to load cached data:', err);
      // Clear corrupted cache
      try {
        localStorage.removeItem(CACHE_KEYS.errorMetrics);
        localStorage.removeItem(CACHE_KEYS.storageStats);
      } catch (clearErr) {
        // Ignore errors when clearing cache
      }
    }
  }

  // Save data to localStorage cache
  function saveToCache(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify({
        data,
        timestamp: Date.now(),
      }));
    } catch (err) {
      console.warn('Failed to save to cache:', err);
    }
  }

  async function fetchErrorMetrics() {
    try {
      const response = await fetch('/api/metrics/errors');
      if (!response.ok) throw new Error('failed to fetch error metrics');
      const data = await response.json();
      console.log('Error metrics API response:', data);
      console.log('Error counts:', {
        errorCount1h: data.errorCount1h,
        errorCount24h: data.errorCount24h,
        warnCount1h: data.warnCount1h,
        warnCount24h: data.warnCount24h,
        total: data.total,
        byLevel: data.byLevel
      });
      errorMetrics = data;
      saveToCache(CACHE_KEYS.errorMetrics, data);
    } catch (err) {
      console.error('Failed to fetch error metrics:', err);
      // If fetch fails and we have no cached data, keep existing or set to null
      if (!errorMetrics) {
        errorMetrics = null;
      }
    }
  }

  async function fetchStorageStats() {
    try {
      const data = await fetchStats();
      storageStats = data;
      saveToCache(CACHE_KEYS.storageStats, data);
    } catch (err) {
      console.error('Failed to fetch storage stats:', err);
      // If fetch fails and we have no cached data, keep existing or set to null
      if (!storageStats) {
        storageStats = null;
      }
    }
  }

  async function fetchMetrics() {
    loading = true;
    error = null;
    try {
      await Promise.all([fetchErrorMetrics(), fetchStorageStats()]);
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
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

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function getHealthStatus(percentage) {
    if (percentage === null || percentage === undefined) return 'unknown';
    if (percentage < 70) return 'good';
    if (percentage < 85) return 'warning';
    return 'critical';
  }

  function getHealthColor(percentage) {
    if (percentage === null || percentage === undefined) return '#888';
    if (percentage < 70) return '#51cf66';
    if (percentage < 85) return '#ffd93d';
    return '#ff6b6b';
  }

  function getOverallHealth() {
    if (!systemMetrics) return 'unknown';
    const cpu = systemMetrics.cpuUsage || 0;
    const memory = systemMetrics.metadata?.memoryPercentage || 0;
    const disk = systemMetrics.metadata?.diskPercentage || 0;
    const max = Math.max(cpu, memory, disk);
    return getHealthStatus(max);
  }

  function toggleDetails(section) {
    showDetails[section] = !showDetails[section];
    showDetails = { ...showDetails };
  }

  // Reactive statement to log error metrics when they change (for debugging)
  $: if (errorMetrics) {
    console.log('[Monitoring] Error metrics updated:', {
      errorCount1h: errorMetrics.errorCount1h,
      errorCount24h: errorMetrics.errorCount24h,
      warnCount1h: errorMetrics.warnCount1h,
      warnCount24h: errorMetrics.warnCount24h,
      total: errorMetrics.total,
      byLevel: errorMetrics.byLevel
    });
  }

  onMount(() => {
    // Load cached data immediately for instant display
    loadCachedData();
    
    // If we have cached data, we can show it immediately
    if (errorMetrics || storageStats) {
      loading = false;
    }
    
    // Fetch fresh data in the background
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 30000); // Refresh every 30s
    
    // Subscribe to WebSocket system metrics updates
    const unsubscribe = wsSystemMetrics.subscribe(metrics => {
      if (metrics) {
        systemMetrics = metrics;
        loading = false;
      }
    });
    
    return () => {
      clearInterval(interval);
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
    <!-- System Status Bar - Compact Horizontal -->
    <section class="status-bar">
      <div class="status-item cpu" class:good={getHealthStatus(systemMetrics?.cpuUsage) === 'good'} class:warning={getHealthStatus(systemMetrics?.cpuUsage) === 'warning'} class:critical={getHealthStatus(systemMetrics?.cpuUsage) === 'critical'}>
        <div class="status-icon"><Cpu size={16} /></div>
        <div class="status-content">
          <div class="status-label">cpu</div>
          <div class="status-value">{formatPercentage(systemMetrics?.cpuUsage)}</div>
        </div>
        <div class="status-bar-mini">
          <div class="status-bar-fill" style="width: {systemMetrics?.cpuUsage || 0}%; background-color: {getHealthColor(systemMetrics?.cpuUsage)}"></div>
        </div>
      </div>

      <div class="status-item memory" class:good={getHealthStatus(systemMetrics?.metadata?.memoryPercentage) === 'good'} class:warning={getHealthStatus(systemMetrics?.metadata?.memoryPercentage) === 'warning'} class:critical={getHealthStatus(systemMetrics?.metadata?.memoryPercentage) === 'critical'}>
        <div class="status-icon"><HardDrive size={16} /></div>
        <div class="status-content">
          <div class="status-label">memory</div>
          <div class="status-value">{formatPercentage(systemMetrics?.metadata?.memoryPercentage)}</div>
        </div>
        <div class="status-bar-mini">
          <div class="status-bar-fill" style="width: {systemMetrics?.metadata?.memoryPercentage || 0}%; background-color: {getHealthColor(systemMetrics?.metadata?.memoryPercentage)}"></div>
        </div>
      </div>

      <div class="status-item disk" class:good={getHealthStatus(systemMetrics?.metadata?.diskPercentage) === 'good'} class:warning={getHealthStatus(systemMetrics?.metadata?.diskPercentage) === 'warning'} class:critical={getHealthStatus(systemMetrics?.metadata?.diskPercentage) === 'critical'}>
        <div class="status-icon"><Disc size={16} /></div>
        <div class="status-content">
          <div class="status-label">disk</div>
          <div class="status-value">{formatPercentage(systemMetrics?.metadata?.diskPercentage)}</div>
        </div>
        <div class="status-bar-mini">
          <div class="status-bar-fill" style="width: {systemMetrics?.metadata?.diskPercentage || 0}%; background-color: {getHealthColor(systemMetrics?.metadata?.diskPercentage)}"></div>
        </div>
      </div>

      <div class="status-item uptime">
        <div class="status-icon"><Clock size={16} /></div>
        <div class="status-content">
          <div class="status-label">uptime</div>
          <div class="status-value">{formatUptime(systemMetrics?.processUptime)}</div>
        </div>
      </div>

      <div class="status-item connection" class:connected={$wsConnected} class:disconnected={!$wsConnected}>
        <div class="status-icon">
          {#if $wsConnected}
            <Wifi size={16} />
          {:else}
            <WifiOff size={16} />
          {/if}
        </div>
        <div class="status-content">
          <div class="status-label">ws</div>
          <div class="status-value">{$wsConnected ? 'connected' : 'disconnected'}</div>
        </div>
      </div>
    </section>

    <!-- Key Metrics Grid -->
    <section class="metrics-grid">
      <div class="metric-card operations">
        <div class="metric-header">
          <Activity size={18} />
          <span>operations</span>
        </div>
        <div class="metric-body">
          <div class="metric-value">{activeOperations}</div>
          <div class="metric-label">active</div>
          <div class="metric-secondary">{completedOperations} completed</div>
        </div>
      </div>

      <div class="metric-card errors">
        <div class="metric-header">
          <AlertCircle size={18} />
          <span>errors</span>
        </div>
        <div class="metric-body">
          <div class="metric-value error">{errorMetrics?.errorCount1h ?? 0}</div>
          <div class="metric-label">last hour</div>
          <div class="metric-secondary">{errorMetrics?.errorCount24h ?? 0} (24h)</div>
        </div>
      </div>

      <div class="metric-card warnings">
        <div class="metric-header">
          <AlertTriangle size={18} />
          <span>warnings</span>
        </div>
        <div class="metric-body">
          <div class="metric-value warning">{errorMetrics?.warnCount1h ?? 0}</div>
          <div class="metric-label">last hour</div>
          <div class="metric-secondary">{errorMetrics?.warnCount24h ?? 0} (24h)</div>
        </div>
      </div>

      <div class="metric-card health">
        <div class="metric-header">
          <span>system health</span>
        </div>
        <div class="metric-body">
          <div class="metric-value status-{getOverallHealth()}">{getOverallHealth()}</div>
          <div class="metric-label">overall status</div>
          <div class="metric-secondary">
            cpu: {formatPercentage(systemMetrics?.cpuUsage)} | 
            mem: {formatPercentage(systemMetrics?.metadata?.memoryPercentage)} | 
            disk: {formatPercentage(systemMetrics?.metadata?.diskPercentage)}
          </div>
        </div>
      </div>

      {#if storageStats}
        <div class="metric-card storage">
          <div class="metric-header">
            <HardDrive size={18} />
            <span>storage</span>
          </div>
          <div class="metric-body">
            <div class="metric-value">{storageStats.disk_usage_formatted || 'N/A'}</div>
            <div class="metric-label">total usage</div>
            <div class="metric-secondary">
              {((storageStats.total_gifs || 0) + (storageStats.total_videos || 0) + (storageStats.total_images || 0)).toLocaleString()} files
            </div>
          </div>
        </div>
      {/if}

      <div class="metric-card logs">
        <div class="metric-header">
          <span>log activity</span>
        </div>
        <div class="metric-body">
          <div class="metric-value">{errorMetrics?.total?.toLocaleString() || 0}</div>
          <div class="metric-label">total logs</div>
          <div class="metric-secondary">all time</div>
        </div>
      </div>
    </section>

    <!-- Activity Summary - Collapsible -->
    {#if errorMetrics?.byComponent && Object.keys(errorMetrics.byComponent).length > 0}
      <section class="activity-section">
        <button class="activity-header" on:click={() => toggleDetails('components')}>
          <span>errors by component</span>
          {#if showDetails.components}
            <ChevronUp size={16} />
          {:else}
            <ChevronDown size={16} />
          {/if}
        </button>
        {#if showDetails.components}
          <div class="activity-content">
            {#each Object.entries(errorMetrics.byComponent).sort((a, b) => b[1] - a[1]).slice(0, 5) as [component, count]}
              <div class="activity-item">
                <span class="activity-name">{component}</span>
                <span class="activity-count">{count}</span>
                <div class="activity-bar">
                  <div class="activity-bar-fill" style="width: {(count / Math.max(...Object.values(errorMetrics.byComponent))) * 100}%"></div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}

    {#if errorMetrics?.byLevel && Object.keys(errorMetrics.byLevel).length > 0}
      <section class="activity-section">
        <button class="activity-header" on:click={() => toggleDetails('levels')}>
          <span>logs by level</span>
          {#if showDetails.levels}
            <ChevronUp size={16} />
          {:else}
            <ChevronDown size={16} />
          {/if}
        </button>
        {#if showDetails.levels}
          <div class="activity-content levels">
            {#each Object.entries(errorMetrics.byLevel).sort((a, b) => b[1] - a[1]) as [level, count]}
              <div class="level-badge level-{level.toLowerCase()}">
                <span class="level-name">{level}</span>
                <span class="level-count">{count.toLocaleString()}</span>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<style>
  .monitoring-container {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* System Status Bar - Horizontal Compact */
  .status-bar {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 0.75rem;
    padding: 0.75rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 4px;
  }

  .status-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    background-color: #222;
    border-radius: 3px;
    border-left: 3px solid #444;
  }

  .status-item.good {
    border-left-color: #51cf66;
  }

  .status-item.warning {
    border-left-color: #ffd93d;
  }

  .status-item.critical {
    border-left-color: #ff6b6b;
  }

  .status-item.connected {
    border-left-color: #51cf66;
  }

  .status-item.disconnected {
    border-left-color: #ff6b6b;
  }

  .status-icon {
    color: #888;
    flex-shrink: 0;
  }

  .status-content {
    flex: 1;
    min-width: 0;
  }

  .status-label {
    font-size: 0.7rem;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .status-value {
    font-size: 0.9rem;
    font-weight: 600;
    color: #fff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status-bar-mini {
    width: 40px;
    height: 4px;
    background-color: #0d0d0d;
    border-radius: 2px;
    overflow: hidden;
    flex-shrink: 0;
  }

  .status-bar-fill {
    height: 100%;
    transition: width 0.3s ease;
  }

  /* Key Metrics Grid */
  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.75rem;
  }

  .metric-card {
    padding: 0.75rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .metric-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: #aaa;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .metric-body {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .metric-value {
    font-size: 1.75rem;
    font-weight: 600;
    color: #fff;
    line-height: 1.2;
    display: block;
    margin: 0;
    padding: 0;
    text-align: left;
    box-sizing: border-box;
    width: auto;
    height: auto;
  }

  .metric-card.errors .metric-value.error,
  .metric-value.error {
    font-size: 1.75rem;
    font-weight: 600;
    color: #ff6b6b;
    line-height: 1.2;
    display: block;
    margin: 0;
    padding: 0;
    text-align: left;
    box-sizing: border-box;
    width: auto;
    height: auto;
  }

  .metric-card.warnings .metric-value.warning,
  .metric-value.warning {
    font-size: 1.75rem;
    font-weight: 600;
    color: #ffd93d;
    line-height: 1.2;
    display: block;
    margin: 0;
    padding: 0;
    text-align: left;
    box-sizing: border-box;
    width: auto;
    height: auto;
  }

  .metric-value.status-good {
    color: #51cf66;
  }

  .metric-value.status-warning {
    color: #ffd93d;
  }

  .metric-value.status-critical {
    color: #ff6b6b;
  }

  .metric-label {
    font-size: 0.7rem;
    color: #888;
  }

  .metric-secondary {
    font-size: 0.65rem;
    color: #666;
    font-family: monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Activity Summary */
  .activity-section {
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 4px;
    overflow: hidden;
  }

  .activity-header {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem;
    background-color: transparent;
    border: none;
    color: #fff;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    text-align: left;
  }

  .activity-header:hover {
    background-color: #222;
  }

  .activity-content {
    padding: 0.75rem;
    padding-top: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .activity-content.levels {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .activity-item {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-rows: auto auto;
    gap: 0.25rem;
    align-items: center;
  }

  .activity-name {
    color: #e0e0e0;
    font-size: 0.8rem;
  }

  .activity-count {
    color: #fff;
    font-weight: 500;
    font-size: 0.9rem;
  }

  .activity-bar {
    grid-column: 1 / -1;
    height: 4px;
    background-color: #0d0d0d;
    border-radius: 2px;
    overflow: hidden;
  }

  .activity-bar-fill {
    height: 100%;
    background-color: #51cf66;
    transition: width 0.3s ease;
  }

  .level-badge {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.75rem;
    background-color: #222;
    border-radius: 3px;
    border-left: 3px solid #444;
  }

  .level-badge.level-error {
    border-left-color: #ff6b6b;
  }

  .level-badge.level-warn {
    border-left-color: #ffd93d;
  }

  .level-badge.level-info {
    border-left-color: #51cf66;
  }

  .level-badge.level-debug {
    border-left-color: #888;
  }

  .level-name {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    color: #aaa;
  }

  .level-count {
    color: #fff;
    font-weight: 500;
    font-size: 0.85rem;
  }

  .loading,
  .error {
    padding: 2rem;
    text-align: center;
    color: #888;
  }

  .error {
    color: #ff6b6b;
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

  @media (max-width: 768px) {
    .status-bar {
      grid-template-columns: repeat(2, 1fr);
    }

    .metrics-grid {
      grid-template-columns: repeat(2, 1fr);
    }

    .activity-content.levels {
      flex-direction: column;
    }
  }

  @media (max-width: 480px) {
    .status-bar {
      grid-template-columns: 1fr;
    }

    .metrics-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
