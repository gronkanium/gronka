<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { Chart, registerables } from 'chart.js';
  import { operations as wsOperations, connected as wsConnected } from '../stores/websocket-store.js';
  import { fetchStats, fetchHealth, formatUptime, fetchCryptoPrices, formatPrice } from '../utils/api.js';
  import { Film, Image, FileVideo, HardDrive, Activity, Zap, Clock, TrendingUp, Server, Wifi, WifiOff, CheckCircle, AlertTriangle, XCircle } from 'lucide-svelte';

  Chart.register(...registerables);

  // State
  let stats = null;
  let health = null;
  let systemMetrics = null;
  let recentActivity = [];
  let bitcoinPrice = null;
  let ethereumPrice = null;
  let moneroPrice = null;
  let loading = true;
  let error = null;

  // Animation state
  let animatedGifs = 0;
  let animatedVideos = 0;
  let animatedImages = 0;
  let animatedTotal = 0;
  let countersAnimated = false;

  // Chart
  let activityChart = null;
  let activityCanvas;

  // Quick analytics
  let todayOps = 0;
  let successRate = 0;
  let avgDuration = 0;

  const colors = {
    success: '#51cf66',
    error: '#ff6b6b',
    warning: '#ffd93d',
    info: '#4dabf7',
    purple: '#a78bfa',
    pink: '#f472b6',
  };

  // Animate counter
  function animateCounter(target, setter, duration = 1000) {
    const start = 0;
    const startTime = performance.now();

    function update(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easeOut = 1 - Math.pow(1 - progress, 3);
      setter(Math.floor(start + (target - start) * easeOut));

      if (progress < 1) {
        requestAnimationFrame(update);
      }
    }
    requestAnimationFrame(update);
  }

  async function loadData() {
    loading = true;
    error = null;

    try {
      const [statsData, healthData, systemData, analyticsData] = await Promise.all([
        fetchStats(),
        fetchHealth(),
        fetch('/api/metrics/system/current').then(r => r.ok ? r.json() : null),
        fetch('/api/analytics/usage?interval=hourly&startTime=' + (Date.now() - 24 * 60 * 60 * 1000)).then(r => r.ok ? r.json() : null),
      ]);

      stats = statsData;
      health = healthData;
      systemMetrics = systemData;

      // Animate counters on first load
      if (!countersAnimated && stats) {
        countersAnimated = true;
        animateCounter(stats.total_gifs || 0, v => animatedGifs = v);
        animateCounter(stats.total_videos || 0, v => animatedVideos = v);
        animateCounter(stats.total_images || 0, v => animatedImages = v);
        animateCounter((stats.total_gifs || 0) + (stats.total_videos || 0) + (stats.total_images || 0), v => animatedTotal = v);
      } else if (stats) {
        animatedGifs = stats.total_gifs || 0;
        animatedVideos = stats.total_videos || 0;
        animatedImages = stats.total_images || 0;
        animatedTotal = (stats.total_gifs || 0) + (stats.total_videos || 0) + (stats.total_images || 0);
      }

      // Process analytics for quick stats
      if (analyticsData?.intervals) {
        todayOps = analyticsData.summary?.totalOperations || 0;
        const successful = analyticsData.intervals.reduce((sum, i) => sum + (i.operations?.success || 0), 0);
        const total = analyticsData.intervals.reduce((sum, i) => sum + (i.operations?.success || 0) + (i.operations?.error || 0), 0);
        successRate = total > 0 ? Math.round((successful / total) * 100) : 100;

        // Update activity chart
        updateActivityChart(analyticsData.intervals);
      }

      // Fetch performance for avg duration
      const perfData = await fetch('/api/analytics/performance?startTime=' + (Date.now() - 24 * 60 * 60 * 1000)).then(r => r.ok ? r.json() : null);
      if (perfData?.durations?.avg) {
        avgDuration = perfData.durations.avg;
      }

    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  async function loadPrices() {
    try {
      const prices = await fetchCryptoPrices();
      if (prices.bitcoin !== null) bitcoinPrice = prices.bitcoin;
      if (prices.ethereum !== null) ethereumPrice = prices.ethereum;
      if (prices.monero !== null) moneroPrice = prices.monero;
    } catch (err) {
      // Silently handle error - prices will remain at previous values
    }
  }

  function updateActivityChart(intervals) {
    if (!activityCanvas || !intervals) return;

    if (activityChart) activityChart.destroy();

    const labels = intervals.slice(-24).map(i => {
      const d = new Date(i.timestamp);
      return d.getHours() + ':00';
    });

    activityChart = new Chart(activityCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: intervals.slice(-24).map(i => (i.operations?.success || 0) + (i.operations?.error || 0)),
          borderColor: colors.success,
          backgroundColor: colors.success + '20',
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true },
        },
        scales: {
          x: { display: false },
          y: { display: false, beginAtZero: true },
        },
        interaction: {
          intersect: false,
          mode: 'index',
        },
      },
    });
  }

  function formatDuration(ms) {
    if (!ms || ms === 0) return '0s';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  function getStatusColor(status) {
    if (status === 'ok' || status === 'success') return colors.success;
    if (status === 'warning') return colors.warning;
    return colors.error;
  }

  function formatTimestamp(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString();
  }

  // Subscribe to WebSocket operations for live activity
  let unsubscribe;

  onMount(() => {
    loadData();
    loadPrices();

    unsubscribe = wsOperations.subscribe(ops => {
      recentActivity = (ops || []).slice(0, 5);
    });

    const dataInterval = setInterval(loadData, 30000);
    const priceInterval = setInterval(loadPrices, 15000);

    return () => {
      clearInterval(dataInterval);
      clearInterval(priceInterval);
    };
  });

  onDestroy(() => {
    if (unsubscribe) unsubscribe();
    if (activityChart) activityChart.destroy();
  });
</script>

<div class="dashboard">
  {#if loading && !stats}
    <div class="loading-state">
      <div class="spinner"></div>
      <span>Loading dashboard...</span>
    </div>
  {:else if error}
    <div class="error-state">
      <XCircle size={32} />
      <span>Error: {error}</span>
      <button on:click={loadData}>Retry</button>
    </div>
  {:else}
    <!-- Hero Stats -->
    <section class="hero-stats">
      <div class="hero-card gifs">
        <div class="hero-icon">
          <Film size={28} />
        </div>
        <div class="hero-content">
          <div class="hero-value">{animatedGifs.toLocaleString()}</div>
          <div class="hero-label">GIFs</div>
          <div class="hero-sub">{stats?.gifs_disk_usage_formatted || '0 MB'}</div>
        </div>
        <div class="hero-glow"></div>
      </div>

      <div class="hero-card videos">
        <div class="hero-icon">
          <FileVideo size={28} />
        </div>
        <div class="hero-content">
          <div class="hero-value">{animatedVideos.toLocaleString()}</div>
          <div class="hero-label">Videos</div>
          <div class="hero-sub">{stats?.videos_disk_usage_formatted || '0 MB'}</div>
        </div>
        <div class="hero-glow"></div>
      </div>

      <div class="hero-card images">
        <div class="hero-icon">
          <Image size={28} />
        </div>
        <div class="hero-content">
          <div class="hero-value">{animatedImages.toLocaleString()}</div>
          <div class="hero-label">Images</div>
          <div class="hero-sub">{stats?.images_disk_usage_formatted || '0 MB'}</div>
        </div>
        <div class="hero-glow"></div>
      </div>

      <div class="hero-card total">
        <div class="hero-icon">
          <HardDrive size={28} />
        </div>
        <div class="hero-content">
          <div class="hero-value">{animatedTotal.toLocaleString()}</div>
          <div class="hero-label">Total Files</div>
          <div class="hero-sub">{stats?.disk_usage_formatted || '0 MB'}</div>
        </div>
        <div class="hero-glow"></div>
      </div>
    </section>

    <!-- Quick Stats Row -->
    <section class="quick-stats">
      <div class="quick-card">
        <div class="quick-icon" style="color: {colors.info}">
          <Activity size={20} />
        </div>
        <div class="quick-info">
          <div class="quick-value">{todayOps.toLocaleString()}</div>
          <div class="quick-label">ops today</div>
        </div>
      </div>

      <div class="quick-card">
        <div class="quick-icon" style="color: {successRate >= 90 ? colors.success : successRate >= 70 ? colors.warning : colors.error}">
          <Zap size={20} />
        </div>
        <div class="quick-info">
          <div class="quick-value">{successRate}%</div>
          <div class="quick-label">success rate</div>
        </div>
      </div>

      <div class="quick-card">
        <div class="quick-icon" style="color: {colors.purple}">
          <Clock size={20} />
        </div>
        <div class="quick-info">
          <div class="quick-value">{formatDuration(avgDuration)}</div>
          <div class="quick-label">avg duration</div>
        </div>
      </div>

      <div class="quick-card">
        <div class="quick-icon" style="color: {colors.success}">
          <TrendingUp size={20} />
        </div>
        <div class="quick-info">
          <div class="quick-value">{formatUptime(health?.uptime || 0)}</div>
          <div class="quick-label">uptime</div>
        </div>
      </div>
    </section>

    <!-- Main Grid -->
    <div class="main-grid">
      <!-- Activity Chart -->
      <section class="card activity-card">
        <div class="card-header">
          <h3>activity (24h)</h3>
          <div class="live-badge" class:connected={$wsConnected}>
            {#if $wsConnected}
              <Wifi size={12} />
            {:else}
              <WifiOff size={12} />
            {/if}
            <span>{$wsConnected ? 'live' : 'offline'}</span>
          </div>
        </div>
        <div class="chart-container">
          <canvas bind:this={activityCanvas}></canvas>
        </div>
      </section>

      <!-- System Health -->
      <section class="card health-card">
        <div class="card-header">
          <h3>system health</h3>
          <div class="status-badge" style="background: {getStatusColor(health?.status)}20; color: {getStatusColor(health?.status)}">
            {health?.status === 'ok' ? 'healthy' : health?.status || 'unknown'}
          </div>
        </div>
        <div class="health-grid">
          <div class="health-item">
            <div class="health-icon">
              <Server size={16} />
            </div>
            <div class="health-info">
              <span class="health-label">CPU</span>
              <span class="health-value">{systemMetrics?.cpu?.toFixed(1) || '0'}%</span>
            </div>
            <div class="health-bar">
              <div class="health-bar-fill" style="width: {systemMetrics?.cpu || 0}%; background: {(systemMetrics?.cpu || 0) > 80 ? colors.error : (systemMetrics?.cpu || 0) > 50 ? colors.warning : colors.success}"></div>
            </div>
          </div>

          <div class="health-item">
            <div class="health-icon">
              <HardDrive size={16} />
            </div>
            <div class="health-info">
              <span class="health-label">Memory</span>
              <span class="health-value">{systemMetrics?.memoryUsed ? formatBytes(systemMetrics.memoryUsed) : '0 MB'}</span>
            </div>
            <div class="health-bar">
              <div class="health-bar-fill" style="width: {systemMetrics?.memoryPercent || 0}%; background: {(systemMetrics?.memoryPercent || 0) > 80 ? colors.error : (systemMetrics?.memoryPercent || 0) > 50 ? colors.warning : colors.success}"></div>
            </div>
          </div>

          <div class="health-item">
            <div class="health-icon">
              <HardDrive size={16} />
            </div>
            <div class="health-info">
              <span class="health-label">Disk</span>
              <span class="health-value">{systemMetrics?.diskUsed ? formatBytes(systemMetrics.diskUsed) : '0 GB'}</span>
            </div>
            <div class="health-bar">
              <div class="health-bar-fill" style="width: {systemMetrics?.diskPercent || 0}%; background: {(systemMetrics?.diskPercent || 0) > 90 ? colors.error : (systemMetrics?.diskPercent || 0) > 70 ? colors.warning : colors.success}"></div>
            </div>
          </div>
        </div>
      </section>

      <!-- Live Activity Feed -->
      <section class="card feed-card">
        <div class="card-header">
          <h3>recent operations</h3>
        </div>
        <div class="activity-feed">
          {#if recentActivity.length === 0}
            <div class="feed-empty">No recent activity</div>
          {:else}
            {#each recentActivity as op}
              <div class="feed-item">
                <div class="feed-status" class:success={op.status === 'success'} class:error={op.status === 'error'} class:pending={op.status === 'pending' || op.status === 'running'}>
                  {#if op.status === 'success'}
                    <CheckCircle size={14} />
                  {:else if op.status === 'error'}
                    <XCircle size={14} />
                  {:else}
                    <div class="mini-spinner"></div>
                  {/if}
                </div>
                <div class="feed-content">
                  <span class="feed-type">{op.type}</span>
                  <span class="feed-user">{op.username || 'unknown'}</span>
                </div>
                <div class="feed-time">{formatTimestamp(op.timestamp)}</div>
              </div>
            {/each}
          {/if}
        </div>
      </section>

      <!-- Crypto Prices -->
      <section class="card crypto-card">
        <div class="card-header">
          <h3>crypto</h3>
        </div>
        <div class="crypto-grid">
          <div class="crypto-item">
            <div class="crypto-icon btc">
              <svg viewBox="0 0 4091.27 4091.73" xmlns="http://www.w3.org/2000/svg">
                <path fill="#F7931A" d="M4030.06 2540.77c-273.24,1096.01 -1383.32,1763.02 -2479.46,1489.71 -1095.68,-273.24 -1762.69,-1383.39 -1489.33,-2479.31 273.12,-1096.13 1383.2,-1763.19 2479,-1489.95 1096.06,273.24 1763.03,1383.51 1489.76,2479.57l0.02 -0.02z"/>
                <path fill="white" d="M2947.77 1754.38c40.72,-272.26 -166.56,-418.61 -450,-516.24l91.95 -368.8 -224.5 -55.94 -89.51 359.09c-59.02,-14.72 -119.63,-28.59 -179.87,-42.34l90.16 -361.46 -224.36 -55.94 -92 368.68c-48.84,-11.12 -96.81,-22.11 -143.35,-33.69l0.26 -1.16 -309.59 -77.31 -59.72 239.78c0,0 166.56,38.18 163.05,40.53 90.91,22.69 107.35,82.87 104.62,130.57l-104.74 420.15c6.26,1.59 14.38,3.89 23.34,7.49 -7.49,-1.86 -15.46,-3.89 -23.73,-5.87l-146.81 588.57c-11.11,27.62 -39.31,69.07 -102.87,53.33 2.25,3.26 -163.17,-40.72 -163.17,-40.72l-111.46 256.98 292.15 72.83c54.35,13.63 107.61,27.89 160.06,41.3l-92.9 373.03 224.24 55.94 92 -369.07c61.26,16.63 120.71,31.97 178.91,46.43l-91.69 367.33 224.51 55.94 92.89 -372.33c382.82,72.45 670.67,43.24 791.83,-303.02 97.63,-278.78 -4.86,-439.58 -206.26,-544.44 146.69,-33.83 257.18,-130.31 286.64,-329.61l-0.07 -0.05z"/>
              </svg>
            </div>
            <div class="crypto-info">
              <span class="crypto-name">Bitcoin</span>
              <span class="crypto-price">{formatPrice(bitcoinPrice)}</span>
            </div>
          </div>

          <div class="crypto-item">
            <div class="crypto-icon eth">
              <svg viewBox="0 0 784.37 1277.39" xmlns="http://www.w3.org/2000/svg">
                <polygon fill="#627EEA" points="392.07,0 383.5,29.11 383.5,873.74 392.07,882.29 784.13,650.54"/>
                <polygon fill="#627EEA" opacity="0.6" points="392.07,0 -0,650.54 392.07,882.29 392.07,472.33"/>
                <polygon fill="#627EEA" points="392.07,956.52 387.24,962.41 387.24,1263.28 392.07,1277.38 784.37,724.89"/>
                <polygon fill="#627EEA" opacity="0.6" points="392.07,1277.38 392.07,956.52 -0,724.89"/>
              </svg>
            </div>
            <div class="crypto-info">
              <span class="crypto-name">Ethereum</span>
              <span class="crypto-price">{formatPrice(ethereumPrice)}</span>
            </div>
          </div>

          <div class="crypto-item">
            <div class="crypto-icon xmr">
              <svg viewBox="0 0 3756.09 3756.49" xmlns="http://www.w3.org/2000/svg">
                <path d="M4128,2249.81C4128,3287,3287.26,4127.86,2250,4127.86S372,3287,372,2249.81,1212.76,371.75,2250,371.75,4128,1212.54,4128,2249.81Z" transform="translate(-371.96 -371.75)" fill="#fff"/>
                <path d="M2250,371.75c-1036.89,0-1879.12,842.06-1877.8,1878,0.26,207.26,33.31,406.63,95.34,593.12h561.88V1263L2250,2483.57,3470.52,1263v1579.9h562c62.12-186.48,95-385.85,95.37-593.12C4129.66,1212.76,3287,372,2250,372Z" transform="translate(-371.96 -371.75)" fill="#f26822"/>
                <path d="M1969.3,2764.17l-532.67-532.7v994.14H1029.38l-384.29.07c329.63,540.8,925.35,902.56,1604.91,902.56S3525.31,3766.4,3855,3225.6H3063.25V2231.47l-532.7,532.7-280.61,280.61-280.62-280.61h0Z" transform="translate(-371.96 -371.75)" fill="#4d4d4d"/>
              </svg>
            </div>
            <div class="crypto-info">
              <span class="crypto-name">Monero</span>
              <span class="crypto-price">{formatPrice(moneroPrice)}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Storage Breakdown -->
      <section class="card storage-card">
        <div class="card-header">
          <h3>storage breakdown</h3>
        </div>
        <div class="storage-visual">
          <div class="storage-bar-container">
            {#if stats}
              {@const totalSize = (stats.gifs_disk_usage || 0) + (stats.videos_disk_usage || 0) + (stats.images_disk_usage || 0)}
              {@const gifPct = totalSize > 0 ? ((stats.gifs_disk_usage || 0) / totalSize) * 100 : 33}
              {@const videoPct = totalSize > 0 ? ((stats.videos_disk_usage || 0) / totalSize) * 100 : 33}
              {@const imagePct = totalSize > 0 ? ((stats.images_disk_usage || 0) / totalSize) * 100 : 34}
              <div class="storage-segment gif" style="width: {gifPct}%"></div>
              <div class="storage-segment video" style="width: {videoPct}%"></div>
              <div class="storage-segment image" style="width: {imagePct}%"></div>
            {/if}
          </div>
          <div class="storage-legend">
            <div class="legend-item">
              <span class="legend-dot gif"></span>
              <span class="legend-label">GIFs</span>
              <span class="legend-value">{stats?.gifs_disk_usage_formatted || '0 MB'}</span>
            </div>
            <div class="legend-item">
              <span class="legend-dot video"></span>
              <span class="legend-label">Videos</span>
              <span class="legend-value">{stats?.videos_disk_usage_formatted || '0 MB'}</span>
            </div>
            <div class="legend-item">
              <span class="legend-dot image"></span>
              <span class="legend-label">Images</span>
              <span class="legend-value">{stats?.images_disk_usage_formatted || '0 MB'}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  {/if}
</div>

<style>
  .dashboard {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    max-width: 1400px;
    margin: 0 auto;
  }

  /* Loading / Error States */
  .loading-state, .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 4rem;
    color: #888;
  }

  .error-state {
    color: #ff6b6b;
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid #333;
    border-top-color: #51cf66;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Hero Stats */
  .hero-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
  }

  .hero-card {
    position: relative;
    padding: 1.5rem;
    background-color: #222;
    border: 1px solid #333;
    border-radius: 12px;
    display: flex;
    align-items: center;
    gap: 1rem;
    overflow: hidden;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .hero-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  }

  .hero-card.gifs { border-left: 3px solid #51cf66; }
  .hero-card.videos { border-left: 3px solid #4dabf7; }
  .hero-card.images { border-left: 3px solid #ffd93d; }
  .hero-card.total { border-left: 3px solid #a78bfa; }

  .hero-icon {
    width: 56px;
    height: 56px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .hero-card.gifs .hero-icon { background: rgba(81, 207, 102, 0.15); color: #51cf66; }
  .hero-card.videos .hero-icon { background: rgba(77, 171, 247, 0.15); color: #4dabf7; }
  .hero-card.images .hero-icon { background: rgba(255, 217, 61, 0.15); color: #ffd93d; }
  .hero-card.total .hero-icon { background: rgba(167, 139, 250, 0.15); color: #a78bfa; }

  .hero-content {
    flex: 1;
    min-width: 0;
  }

  .hero-value {
    font-size: 2rem;
    font-weight: 700;
    color: #fff;
    line-height: 1.1;
  }

  .hero-label {
    font-size: 0.85rem;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .hero-sub {
    font-size: 0.8rem;
    color: #666;
    margin-top: 0.25rem;
  }

  .hero-glow {
    display: none;
  }

  /* Quick Stats */
  .quick-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
  }

  .quick-card {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem 1.25rem;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 8px;
  }

  .quick-icon {
    width: 40px;
    height: 40px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.05);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .quick-info {
    flex: 1;
  }

  .quick-value {
    font-size: 1.25rem;
    font-weight: 600;
    color: #fff;
  }

  .quick-label {
    font-size: 0.75rem;
    color: #666;
    text-transform: lowercase;
  }

  /* Main Grid */
  .main-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
  }

  .card {
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 1rem;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }

  .card-header h3 {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 500;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* Activity Card */
  .activity-card {
    grid-column: span 2;
  }

  .chart-container {
    height: 120px;
  }

  .live-badge {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.7rem;
    text-transform: uppercase;
    background: rgba(255, 107, 107, 0.15);
    color: #ff6b6b;
  }

  .live-badge.connected {
    background: rgba(81, 207, 102, 0.15);
    color: #51cf66;
  }

  /* Health Card */
  .status-badge {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.7rem;
    text-transform: uppercase;
    font-weight: 500;
  }

  .health-grid {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .health-item {
    display: grid;
    grid-template-columns: 24px 1fr auto;
    gap: 0.75rem;
    align-items: center;
  }

  .health-icon {
    color: #666;
  }

  .health-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .health-label {
    font-size: 0.8rem;
    color: #888;
  }

  .health-value {
    font-size: 0.8rem;
    color: #fff;
    font-weight: 500;
  }

  .health-bar {
    grid-column: span 3;
    height: 4px;
    background: #2a2a2a;
    border-radius: 2px;
    overflow: hidden;
  }

  .health-bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.5s ease;
  }

  /* Feed Card */
  .activity-feed {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .feed-empty {
    text-align: center;
    color: #666;
    font-size: 0.85rem;
    padding: 1rem;
  }

  .feed-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem;
    background: #222;
    border-radius: 6px;
  }

  .feed-status {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .feed-status.success { background: rgba(81, 207, 102, 0.15); color: #51cf66; }
  .feed-status.error { background: rgba(255, 107, 107, 0.15); color: #ff6b6b; }
  .feed-status.pending { background: rgba(77, 171, 247, 0.15); color: #4dabf7; }

  .mini-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  .feed-content {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 0.5rem;
  }

  .feed-type {
    font-size: 0.8rem;
    color: #fff;
    font-weight: 500;
  }

  .feed-user {
    font-size: 0.8rem;
    color: #666;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .feed-time {
    font-size: 0.7rem;
    color: #555;
    flex-shrink: 0;
  }

  /* Crypto Card */
  .crypto-grid {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .crypto-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    background: #222;
    border-radius: 6px;
  }

  .crypto-icon {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
  }

  .crypto-icon svg {
    width: 100%;
    height: 100%;
  }

  .crypto-info {
    flex: 1;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .crypto-name {
    font-size: 0.85rem;
    color: #888;
  }

  .crypto-price {
    font-size: 0.9rem;
    color: #fff;
    font-weight: 600;
    font-family: monospace;
  }

  /* Storage Card */
  .storage-visual {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .storage-bar-container {
    display: flex;
    height: 12px;
    background: #2a2a2a;
    border-radius: 6px;
    overflow: hidden;
  }

  .storage-segment {
    height: 100%;
    transition: width 0.5s ease;
  }

  .storage-segment.gif { background: #51cf66; }
  .storage-segment.video { background: #4dabf7; }
  .storage-segment.image { background: #ffd93d; }

  .storage-legend {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .legend-dot {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .legend-dot.gif { background: #51cf66; }
  .legend-dot.video { background: #4dabf7; }
  .legend-dot.image { background: #ffd93d; }

  .legend-label {
    flex: 1;
    font-size: 0.8rem;
    color: #888;
  }

  .legend-value {
    font-size: 0.8rem;
    color: #fff;
    font-weight: 500;
  }

  /* Responsive */
  @media (max-width: 1024px) {
    .hero-stats {
      grid-template-columns: repeat(2, 1fr);
    }

    .quick-stats {
      grid-template-columns: repeat(2, 1fr);
    }

    .main-grid {
      grid-template-columns: 1fr;
    }

    .activity-card {
      grid-column: span 1;
    }
  }

  @media (max-width: 640px) {
    .hero-stats {
      grid-template-columns: 1fr;
    }

    .quick-stats {
      grid-template-columns: 1fr;
    }

    .hero-value {
      font-size: 1.5rem;
    }

    .hero-card {
      padding: 1rem;
    }

    .hero-icon {
      width: 48px;
      height: 48px;
    }
  }
</style>
