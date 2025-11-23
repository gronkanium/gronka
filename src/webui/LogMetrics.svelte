<script>
  import { onMount, onDestroy } from 'svelte';

  let metrics = null;
  let loading = true;
  let error = null;
  let refreshInterval = null;

  async function fetchMetrics() {
    loading = true;
    error = null;
    try {
      const response = await fetch('/api/logs/metrics');
      if (!response.ok) throw new Error('Failed to fetch metrics');
      
      metrics = await response.json();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  function formatNumber(num) {
    if (num === null || num === undefined) return '0';
    return num.toLocaleString();
  }

  function getPercentage(value, total) {
    if (!total) return 0;
    return Math.round((value / total) * 100);
  }

  onMount(() => {
    fetchMetrics();
    // Refresh metrics every 30 seconds
    refreshInterval = setInterval(fetchMetrics, 30000);
  });

  onDestroy(() => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
  });
</script>

<section class="metrics">
  <h2>log metrics</h2>
  {#if loading && !metrics}
    <div class="loading">loading metrics...</div>
  {:else if error}
    <div class="error">error: {error}</div>
    <button on:click={fetchMetrics}>retry</button>
  {:else if metrics}
    <div class="metrics-grid">
      <div class="metric-card error-card">
        <div class="metric-header">
          <span class="metric-icon">⚠</span>
          <span class="metric-label">errors</span>
        </div>
        <div class="metric-values">
          <div class="metric-value-item">
            <span class="metric-number">{formatNumber(metrics.errorCount1h)}</span>
            <span class="metric-sublabel">last hour</span>
          </div>
          <div class="metric-value-item">
            <span class="metric-number">{formatNumber(metrics.errorCount24h)}</span>
            <span class="metric-sublabel">last 24h</span>
          </div>
        </div>
      </div>

      <div class="metric-card warn-card">
        <div class="metric-header">
          <span class="metric-icon">⚠</span>
          <span class="metric-label">warnings</span>
        </div>
        <div class="metric-values">
          <div class="metric-value-item">
            <span class="metric-number">{formatNumber(metrics.warnCount1h)}</span>
            <span class="metric-sublabel">last hour</span>
          </div>
          <div class="metric-value-item">
            <span class="metric-number">{formatNumber(metrics.warnCount24h)}</span>
            <span class="metric-sublabel">last 24h</span>
          </div>
        </div>
      </div>

      <div class="metric-card total-card">
        <div class="metric-header">
          <span class="metric-icon">📊</span>
          <span class="metric-label">total logs (24h)</span>
        </div>
        <div class="metric-values">
          <div class="metric-value-item">
            <span class="metric-number large">{formatNumber(metrics.total)}</span>
          </div>
        </div>
      </div>
    </div>

    {#if metrics.byLevel && Object.keys(metrics.byLevel).length > 0}
      <div class="section-title">logs by level (24h)</div>
      <div class="level-bars">
        {#each Object.entries(metrics.byLevel).sort((a, b) => b[1] - a[1]) as [level, count]}
          <div class="level-bar-item">
            <div class="level-bar-header">
              <span class="level-name {level.toLowerCase()}">{level}</span>
              <span class="level-count">{formatNumber(count)}</span>
            </div>
            <div class="level-bar-container">
              <div
                class="level-bar {level.toLowerCase()}"
                style="width: {getPercentage(count, metrics.total)}%"
              ></div>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    {#if metrics.byComponent && Object.keys(metrics.byComponent).length > 0}
      <div class="section-title">logs by component (24h)</div>
      <div class="component-list">
        {#each Object.entries(metrics.byComponent).sort((a, b) => b[1] - a[1]) as [component, count]}
          <div class="component-item">
            <span class="component-name">{component}</span>
            <span class="component-count">{formatNumber(count)}</span>
          </div>
        {/each}
      </div>
    {/if}

    {#if metrics.errorTimeline && metrics.errorTimeline.length > 0}
      <div class="section-title">error timeline (24h)</div>
      <div class="timeline-chart">
        {#each metrics.errorTimeline as point}
          {@const hour = new Date(point.hour).getHours()}
          {@const maxCount = Math.max(...metrics.errorTimeline.map(p => p.count))}
          {@const heightPercent = maxCount > 0 ? (point.count / maxCount) * 100 : 0}
          <div class="timeline-bar-wrapper">
            <div class="timeline-bar" style="height: {heightPercent}%">
              <div class="timeline-tooltip">{point.count} errors at {hour}:00</div>
            </div>
            <div class="timeline-label">{hour}h</div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</section>

<style>
  section {
    padding: 1rem;
    border: 1px solid #333;
    background-color: #222;
    grid-column: 1 / -1;
  }

  h2 {
    margin: 0 0 1rem 0;
    font-size: 1.25rem;
    font-weight: 500;
    color: #fff;
    border-bottom: 1px solid #333;
    padding-bottom: 0.5rem;
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .metric-card {
    padding: 1rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 3px;
  }

  .error-card {
    border-left: 3px solid #ff6b6b;
  }

  .warn-card {
    border-left: 3px solid #ffd93d;
  }

  .total-card {
    border-left: 3px solid #51cf66;
  }

  .metric-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .metric-icon {
    font-size: 1.2rem;
  }

  .metric-label {
    font-size: 0.9rem;
    color: #aaa;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 500;
  }

  .metric-values {
    display: flex;
    gap: 1rem;
  }

  .metric-value-item {
    display: flex;
    flex-direction: column;
  }

  .metric-number {
    font-size: 1.5rem;
    font-weight: 600;
    color: #fff;
  }

  .metric-number.large {
    font-size: 2rem;
  }

  .metric-sublabel {
    font-size: 0.75rem;
    color: #666;
    text-transform: uppercase;
  }

  .section-title {
    font-size: 0.9rem;
    color: #aaa;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 500;
    margin: 1.5rem 0 0.75rem 0;
  }

  .level-bars {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }

  .level-bar-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .level-bar-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.85rem;
  }

  .level-name {
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.5px;
  }

  .level-name.error {
    color: #ff6b6b;
  }

  .level-name.warn {
    color: #ffd93d;
  }

  .level-name.info {
    color: #51cf66;
  }

  .level-name.debug {
    color: #888;
  }

  .level-count {
    color: #aaa;
  }

  .level-bar-container {
    height: 24px;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 3px;
    overflow: hidden;
  }

  .level-bar {
    height: 100%;
    transition: width 0.3s ease;
  }

  .level-bar.error {
    background: linear-gradient(90deg, #ff6b6b, #fa5252);
  }

  .level-bar.warn {
    background: linear-gradient(90deg, #ffd93d, #fcc419);
  }

  .level-bar.info {
    background: linear-gradient(90deg, #51cf66, #40c057);
  }

  .level-bar.debug {
    background: linear-gradient(90deg, #888, #666);
  }

  .component-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }

  .component-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.75rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 3px;
  }

  .component-name {
    font-size: 0.85rem;
    color: #e0e0e0;
    font-weight: 500;
  }

  .component-count {
    font-size: 0.85rem;
    color: #aaa;
    font-family: monospace;
  }

  .timeline-chart {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    height: 120px;
    padding: 1rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 3px;
    overflow-x: auto;
  }

  .timeline-bar-wrapper {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 1;
    min-width: 30px;
    height: 100%;
    position: relative;
  }

  .timeline-bar {
    width: 100%;
    background: linear-gradient(180deg, #ff6b6b, #fa5252);
    border-radius: 2px 2px 0 0;
    min-height: 2px;
    position: relative;
    cursor: pointer;
    transition: opacity 0.2s;
  }

  .timeline-bar:hover {
    opacity: 0.8;
  }

  .timeline-tooltip {
    display: none;
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    background-color: #333;
    color: #fff;
    padding: 0.25rem 0.5rem;
    border-radius: 3px;
    font-size: 0.75rem;
    white-space: nowrap;
    margin-bottom: 5px;
    z-index: 10;
  }

  .timeline-bar:hover .timeline-tooltip {
    display: block;
  }

  .timeline-label {
    font-size: 0.7rem;
    color: #666;
    margin-top: 0.25rem;
  }

  .loading,
  .error {
    padding: 1rem 0;
  }

  .loading {
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

  button:active {
    background-color: #333;
  }

  @media (max-width: 768px) {
    .metrics-grid {
      grid-template-columns: 1fr;
    }

    .metric-values {
      flex-direction: row;
    }

    .component-list {
      grid-template-columns: 1fr;
    }

    .timeline-chart {
      overflow-x: scroll;
    }
  }
</style>

