<script>
  import { onMount, onDestroy } from 'svelte';
  import { Chart, registerables } from 'chart.js';
  import TimeRangeSelector from '../components/TimeRangeSelector.svelte';
  import KPICard from '../components/KPICard.svelte';

  // Register Chart.js components
  Chart.register(...registerables);

  // State
  let timeRange = '7d';
  let interval = 'daily';
  let loading = true;
  let error = null;

  let usageData = null;
  let performanceData = null;
  let userAnalytics = null;

  // Chart instances
  let operationsChart = null;
  let usersChart = null;
  let durationChart = null;
  let errorPatternsChart = null;
  let commandDistChart = null;

  // Chart canvas refs
  let operationsCanvas;
  let usersCanvas;
  let durationCanvas;
  let errorPatternsCanvas;
  let commandDistCanvas;

  // Dark theme colors
  const colors = {
    success: '#51cf66',
    error: '#ff6b6b',
    warning: '#ffd93d',
    info: '#4dabf7',
    primary: '#51cf66',
    secondary: '#888',
    background: '#1a1a1a',
    border: '#333',
    text: '#e0e0e0',
    gridColor: '#2a2a2a',
  };

  const chartColors = ['#51cf66', '#4dabf7', '#ffd93d', '#ff6b6b', '#a78bfa', '#f472b6'];

  // Calculate time range
  function getTimeRange() {
    const now = Date.now();
    let startTime;
    switch (timeRange) {
      case '24h':
        startTime = now - 24 * 60 * 60 * 1000;
        break;
      case '30d':
        startTime = now - 30 * 24 * 60 * 60 * 1000;
        break;
      case '7d':
      default:
        startTime = now - 7 * 24 * 60 * 60 * 1000;
    }
    return { startTime, endTime: now };
  }

  // Fetch data
  async function fetchData() {
    loading = true;
    error = null;

    const { startTime, endTime } = getTimeRange();
    const params = new URLSearchParams({
      startTime: startTime.toString(),
      endTime: endTime.toString(),
      interval,
    });

    try {
      const [usageRes, perfRes, userRes] = await Promise.all([
        fetch(`/api/analytics/usage?${params}`),
        fetch(`/api/analytics/performance?${params}`),
        fetch(`/api/analytics/users?${params}`),
      ]);

      if (!usageRes.ok || !perfRes.ok || !userRes.ok) {
        throw new Error('Failed to fetch analytics data');
      }

      usageData = await usageRes.json();
      performanceData = await perfRes.json();
      userAnalytics = await userRes.json();

      updateCharts();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  // Format helpers
  function formatDuration(ms) {
    if (!ms || ms === 0) return '0s';
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  function formatTimestamp(ts) {
    const date = new Date(ts);
    if (interval === 'hourly') {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // Chart configuration helpers
  function getCommonOptions(title) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: colors.text,
            font: { size: 11 },
          },
        },
        title: {
          display: false,
        },
      },
      scales: {
        x: {
          ticks: { color: colors.secondary },
          grid: { color: colors.gridColor },
        },
        y: {
          ticks: { color: colors.secondary },
          grid: { color: colors.gridColor },
          beginAtZero: true,
        },
      },
    };
  }

  // Update charts
  function updateCharts() {
    if (!usageData || !performanceData || !userAnalytics) return;

    // Operations chart
    if (operationsCanvas) {
      if (operationsChart) operationsChart.destroy();

      const labels = usageData.intervals.map(i => formatTimestamp(i.timestamp));
      operationsChart = new Chart(operationsCanvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Success',
              data: usageData.intervals.map(i => i.operations.success),
              borderColor: colors.success,
              backgroundColor: colors.success + '20',
              fill: true,
              tension: 0.3,
            },
            {
              label: 'Error',
              data: usageData.intervals.map(i => i.operations.error),
              borderColor: colors.error,
              backgroundColor: colors.error + '20',
              fill: true,
              tension: 0.3,
            },
          ],
        },
        options: getCommonOptions(),
      });
    }

    // Users chart
    if (usersCanvas) {
      if (usersChart) usersChart.destroy();

      const labels = usageData.intervals.map(i => formatTimestamp(i.timestamp));
      usersChart = new Chart(usersCanvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Active Users',
              data: usageData.intervals.map(i => i.users.active),
              backgroundColor: colors.info,
              borderRadius: 4,
            },
          ],
        },
        options: getCommonOptions(),
      });
    }

    // Duration by type chart
    if (durationCanvas && performanceData.durations.byType) {
      if (durationChart) durationChart.destroy();

      const types = Object.keys(performanceData.durations.byType);
      durationChart = new Chart(durationCanvas, {
        type: 'bar',
        data: {
          labels: types.map(t => t.charAt(0).toUpperCase() + t.slice(1)),
          datasets: [
            {
              label: 'Avg (ms)',
              data: types.map(t => performanceData.durations.byType[t].avg),
              backgroundColor: colors.info,
              borderRadius: 4,
            },
            {
              label: 'P95 (ms)',
              data: types.map(t => performanceData.durations.byType[t].p95),
              backgroundColor: colors.warning,
              borderRadius: 4,
            },
          ],
        },
        options: {
          ...getCommonOptions(),
          indexAxis: 'y',
        },
      });
    }

    // Error patterns chart
    if (errorPatternsCanvas && performanceData.errorPatterns.length > 0) {
      if (errorPatternsChart) errorPatternsChart.destroy();

      errorPatternsChart = new Chart(errorPatternsCanvas, {
        type: 'doughnut',
        data: {
          labels: performanceData.errorPatterns.map(p => p.pattern),
          datasets: [
            {
              data: performanceData.errorPatterns.map(p => p.count),
              backgroundColor: chartColors,
              borderWidth: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'right',
              labels: {
                color: colors.text,
                font: { size: 10 },
                boxWidth: 12,
              },
            },
          },
        },
      });
    }

    // Command distribution chart
    if (commandDistCanvas && userAnalytics.commandDistribution) {
      if (commandDistChart) commandDistChart.destroy();

      const dist = userAnalytics.commandDistribution;
      const labels = Object.keys(dist).map(k => k.charAt(0).toUpperCase() + k.slice(1));
      const data = Object.values(dist);

      commandDistChart = new Chart(commandDistCanvas, {
        type: 'doughnut',
        data: {
          labels,
          datasets: [
            {
              data,
              backgroundColor: chartColors,
              borderWidth: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'right',
              labels: {
                color: colors.text,
                font: { size: 10 },
                boxWidth: 12,
              },
            },
          },
        },
      });
    }
  }

  // Reactive fetch when time range or interval changes
  $: if (timeRange || interval) {
    fetchData();
  }

  onMount(() => {
    fetchData();
  });

  onDestroy(() => {
    if (operationsChart) operationsChart.destroy();
    if (usersChart) usersChart.destroy();
    if (durationChart) durationChart.destroy();
    if (errorPatternsChart) errorPatternsChart.destroy();
    if (commandDistChart) commandDistChart.destroy();
  });
</script>

<div class="analytics-container">
  <!-- Time Range Selector -->
  <section class="controls-section">
    <TimeRangeSelector bind:value={timeRange} bind:interval />
  </section>

  {#if loading && !usageData}
    <div class="loading">loading analytics...</div>
  {:else if error}
    <div class="error">error: {error}</div>
    <button on:click={fetchData}>retry</button>
  {:else}
    <!-- KPI Cards -->
    <section class="kpi-section">
      <div class="kpi-grid">
        <KPICard
          title="Total Operations"
          value={usageData?.summary?.totalOperations?.toLocaleString() || '0'}
          status="neutral"
        />
        <KPICard
          title="Active Users"
          value={userAnalytics?.activeUsers?.daily?.toLocaleString() || '0'}
          subtitle="daily"
          status="neutral"
        />
        <KPICard
          title="Success Rate"
          value={performanceData?.successRates?.overall ? `${performanceData.successRates.overall}%` : 'N/A'}
          status={performanceData?.successRates?.overall >= 90 ? 'good' : performanceData?.successRates?.overall >= 70 ? 'warning' : 'critical'}
        />
        <KPICard
          title="Avg Duration"
          value={formatDuration(performanceData?.durations?.avg)}
          status="neutral"
        />
        <KPICard
          title="P95 Duration"
          value={formatDuration(performanceData?.durations?.p95)}
          status="neutral"
        />
        <KPICard
          title="Weekly Users"
          value={userAnalytics?.activeUsers?.weekly?.toLocaleString() || '0'}
          status="neutral"
        />
      </div>
    </section>

    <!-- Charts Section -->
    <section class="charts-section">
      <div class="charts-grid">
        <div class="chart-card wide">
          <div class="chart-header">operations over time</div>
          <div class="chart-container">
            <canvas bind:this={operationsCanvas}></canvas>
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-header">active users</div>
          <div class="chart-container">
            <canvas bind:this={usersCanvas}></canvas>
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-header">duration by type</div>
          <div class="chart-container">
            <canvas bind:this={durationCanvas}></canvas>
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-header">error patterns</div>
          <div class="chart-container">
            {#if performanceData?.errorPatterns?.length > 0}
              <canvas bind:this={errorPatternsCanvas}></canvas>
            {:else}
              <div class="no-data">no errors</div>
            {/if}
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-header">command distribution</div>
          <div class="chart-container">
            <canvas bind:this={commandDistCanvas}></canvas>
          </div>
        </div>
      </div>
    </section>

    <!-- Top Users Section -->
    {#if userAnalytics?.topUsers?.length > 0}
      <section class="top-users-section">
        <div class="section-header">top users</div>
        <div class="users-list">
          {#each userAnalytics.topUsers as user, i}
            <div class="user-row">
              <span class="rank">#{i + 1}</span>
              <span class="username">{user.username || user.userId}</span>
              <div class="user-stats">
                <span class="commands">{user.commands.toLocaleString()} commands</span>
                <span class="success-rate" class:good={user.successRate >= 90} class:warning={user.successRate >= 70 && user.successRate < 90} class:critical={user.successRate < 70}>
                  {user.successRate}%
                </span>
              </div>
              <div class="user-bar">
                <div
                  class="user-bar-fill"
                  style="width: {(user.commands / userAnalytics.topUsers[0].commands) * 100}%"
                ></div>
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}
  {/if}
</div>

<style>
  .analytics-container {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .controls-section {
    padding: 1rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 4px;
  }

  /* KPI Section */
  .kpi-section {
    width: 100%;
  }

  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 0.75rem;
  }

  @media (min-width: 1024px) {
    .kpi-grid {
      grid-template-columns: repeat(6, 1fr);
    }
  }

  /* Charts Section */
  .charts-section {
    width: 100%;
  }

  .charts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 1rem;
  }

  @media (min-width: 1024px) {
    .charts-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  .chart-card {
    padding: 1rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 4px;
  }

  .chart-card.wide {
    grid-column: 1 / -1;
  }

  .chart-header {
    font-size: 0.75rem;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 0.75rem;
  }

  .chart-container {
    height: 200px;
    position: relative;
  }

  .chart-card.wide .chart-container {
    height: 250px;
  }

  .no-data {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #666;
    font-size: 0.9rem;
  }

  /* Top Users Section */
  .top-users-section {
    padding: 1rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 4px;
  }

  .section-header {
    font-size: 0.75rem;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 1rem;
  }

  .users-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .user-row {
    display: grid;
    grid-template-columns: 40px 1fr auto;
    grid-template-rows: auto auto;
    gap: 0.25rem 0.5rem;
    align-items: center;
    padding: 0.5rem;
    background-color: #222;
    border-radius: 4px;
  }

  .rank {
    font-size: 0.85rem;
    color: #51cf66;
    font-weight: 600;
    grid-row: span 2;
  }

  .username {
    color: #e0e0e0;
    font-size: 0.9rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .user-stats {
    display: flex;
    gap: 0.5rem;
    font-size: 0.75rem;
  }

  .commands {
    color: #888;
  }

  .success-rate {
    font-weight: 500;
  }

  .success-rate.good {
    color: #51cf66;
  }

  .success-rate.warning {
    color: #ffd93d;
  }

  .success-rate.critical {
    color: #ff6b6b;
  }

  .user-bar {
    grid-column: 2 / -1;
    height: 4px;
    background-color: #0d0d0d;
    border-radius: 2px;
    overflow: hidden;
  }

  .user-bar-fill {
    height: 100%;
    background-color: #51cf66;
    transition: width 0.3s ease;
  }

  /* Loading / Error States */
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
    .kpi-grid {
      grid-template-columns: repeat(2, 1fr);
    }

    .charts-grid {
      grid-template-columns: 1fr;
    }

    .chart-card.wide {
      grid-column: 1;
    }

    .chart-container {
      height: 180px;
    }

    .user-row {
      grid-template-columns: 30px 1fr;
    }

    .user-stats {
      grid-column: 2;
    }
  }

  @media (max-width: 480px) {
    .kpi-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
