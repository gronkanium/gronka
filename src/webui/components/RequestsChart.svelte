<script>
  export let data = []; // Array<{date: string, count: number}>, oldest first

  const VIEW_W = 560;
  const VIEW_H = 160;
  const PAD_LEFT = 30;
  const PAD_RIGHT = 6;
  const PAD_TOP = 10;
  const PAD_BOTTOM = 18;
  const MAX_BAR_WIDTH = 24;
  const BAR_GAP = 4;

  let hoveredIndex = null;

  function niceCeil(n) {
    if (n <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(n));
    const residual = n / magnitude;
    let niceResidual;
    if (residual <= 1) niceResidual = 1;
    else if (residual <= 2) niceResidual = 2;
    else if (residual <= 5) niceResidual = 5;
    else niceResidual = 10;
    return niceResidual * magnitude;
  }

  function formatShortDate(isoDate) {
    const d = new Date(`${isoDate}T00:00:00Z`);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  $: plotWidth = VIEW_W - PAD_LEFT - PAD_RIGHT;
  $: plotHeight = VIEW_H - PAD_TOP - PAD_BOTTOM;
  $: maxTick = niceCeil(Math.max(...data.map(d => d.count), 1));
  $: barSlot = data.length ? plotWidth / data.length : 0;
  $: barWidth = Math.max(2, Math.min(MAX_BAR_WIDTH, barSlot - BAR_GAP));
  $: bars = data.map((d, i) => {
    const height = maxTick > 0 ? (d.count / maxTick) * plotHeight : 0;
    const x = PAD_LEFT + i * barSlot + (barSlot - barWidth) / 2;
    const y = PAD_TOP + (plotHeight - height);
    const radius = Math.min(4, height / 2, barWidth / 2);
    return { ...d, x, y, height, width: barWidth, radius, slotX: PAD_LEFT + i * barSlot };
  });
</script>

<div class="requests-chart">
  <h3>requests / day <span class="chart-subtitle">(last {data.length} days)</span></h3>
  <div class="chart-area">
    <svg viewBox="0 0 {VIEW_W} {VIEW_H}" preserveAspectRatio="none" role="presentation">
      <!-- gridlines -->
      <line x1={PAD_LEFT} y1={PAD_TOP} x2={VIEW_W - PAD_RIGHT} y2={PAD_TOP} class="gridline" />
      <line
        x1={PAD_LEFT}
        y1={PAD_TOP + plotHeight}
        x2={VIEW_W - PAD_RIGHT}
        y2={PAD_TOP + plotHeight}
        class="gridline"
      />

      {#each bars as bar, i (bar.date)}
        <rect
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={Math.max(bar.height, 1)}
          rx={bar.radius}
          ry={bar.radius}
          class="bar"
          class:bar-hovered={hoveredIndex === i}
        />
        {#if bar.height > bar.radius}
          <rect
            x={bar.x}
            y={PAD_TOP + plotHeight - bar.radius}
            width={bar.width}
            height={bar.radius}
            class="bar"
            class:bar-hovered={hoveredIndex === i}
          />
        {/if}
        <rect
          x={bar.slotX}
          y={PAD_TOP}
          width={barSlot}
          height={plotHeight}
          class="hit-area"
          role="button"
          tabindex="0"
          aria-label="{formatShortDate(bar.date)}: {bar.count.toLocaleString()} requests"
          on:mouseenter={() => (hoveredIndex = i)}
          on:mouseleave={() => (hoveredIndex = null)}
          on:focus={() => (hoveredIndex = i)}
          on:blur={() => (hoveredIndex = null)}
        />
      {/each}
    </svg>

    <span class="axis-tick axis-tick-top" style="left: {(PAD_LEFT / VIEW_W) * 100}%">
      {maxTick.toLocaleString()}
    </span>
    <span class="axis-tick axis-tick-bottom" style="left: {(PAD_LEFT / VIEW_W) * 100}%">0</span>

    {#if bars.length}
      <span class="axis-label axis-label-first" style="left: {(bars[0].slotX / VIEW_W) * 100}%">
        {formatShortDate(bars[0].date)}
      </span>
      <span
        class="axis-label axis-label-last"
        style="left: {((bars[bars.length - 1].slotX + barSlot) / VIEW_W) * 100}%"
      >
        {formatShortDate(bars[bars.length - 1].date)}
      </span>
    {/if}

    {#if hoveredIndex !== null}
      {@const bar = bars[hoveredIndex]}
      <div
        class="tooltip"
        style="left: {((bar.slotX + barSlot / 2) / VIEW_W) * 100}%; top: {(bar.y / VIEW_H) * 100}%"
      >
        <span class="tooltip-value">{bar.count.toLocaleString()}</span>
        <span class="tooltip-date">{formatShortDate(bar.date)}</span>
      </div>
    {/if}
  </div>

  <details class="table-view">
    <summary>show as table</summary>
    <table>
      <thead>
        <tr>
          <th>date</th>
          <th>requests</th>
        </tr>
      </thead>
      <tbody>
        {#each data as row (row.date)}
          <tr>
            <td>{formatShortDate(row.date)}</td>
            <td>{row.count.toLocaleString()}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </details>
</div>

<style>
  .requests-chart {
    margin-top: 1rem;
  }

  h3 {
    margin: 0 0 0.5rem 0;
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--text-bright);
  }

  .chart-subtitle {
    font-weight: 400;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .chart-area {
    position: relative;
    height: 140px;
  }

  svg {
    width: 100%;
    height: 100%;
    display: block;
    overflow: visible;
  }

  .gridline {
    stroke: var(--border);
    stroke-width: 1;
  }

  .bar {
    fill: var(--chart-series-1);
  }

  .bar-hovered {
    fill: var(--chart-series-1-hover);
  }

  .hit-area {
    fill: transparent;
    cursor: pointer;
  }

  .hit-area:focus-visible {
    outline: 1px solid var(--border-2);
    outline-offset: -1px;
  }

  .axis-tick {
    position: absolute;
    transform: translate(-100%, -50%);
    padding-right: 6px;
    font-size: 0.7rem;
    color: var(--text-dim);
    white-space: nowrap;
  }

  .axis-tick-top {
    top: 6.25%;
  }

  .axis-tick-bottom {
    top: 88.75%;
  }

  .axis-label {
    position: absolute;
    bottom: 0;
    font-size: 0.7rem;
    color: var(--text-dim);
  }

  .axis-label-first {
    transform: translateX(0);
  }

  .axis-label-last {
    transform: translateX(-100%);
  }

  .tooltip {
    position: absolute;
    transform: translate(-50%, -100%) translateY(-6px);
    display: flex;
    flex-direction: column;
    align-items: center;
    background-color: var(--surface-3);
    border: 1px solid var(--border-2);
    border-radius: var(--radius);
    padding: 0.25rem 0.5rem;
    pointer-events: none;
    white-space: nowrap;
  }

  .tooltip-value {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text-bright);
  }

  .tooltip-date {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .table-view {
    margin-top: 0.5rem;
  }

  .table-view summary {
    font-size: 0.8rem;
    color: var(--text-muted);
    cursor: pointer;
  }

  .table-view table {
    margin-top: 0.5rem;
    border-collapse: collapse;
    font-size: 0.85rem;
    width: 100%;
  }

  .table-view th,
  .table-view td {
    text-align: left;
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid var(--surface-2);
    color: var(--text);
  }

  .table-view th {
    color: var(--text-muted);
    font-weight: 400;
  }
</style>
