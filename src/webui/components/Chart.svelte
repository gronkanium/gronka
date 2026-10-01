<script>
  /**
   * Time series in SVG, stacked bars or overlapping areas: gridlines, y labels, x ticks, a crosshair
   * tooltip listing every series, and brush-to-zoom on pointer drag (touch included). Escape
   * cancels a brush.
   *
   *   type    'bar' | 'area'
   *   series  [{ key, label, color }]           bars stack bottom-up in this order
   *   data    [{ at, <key>: number, ... }]      one bucket per entry, `at` is the bucket start
   *   bucket  bucket width in ms                (defaults to the gap between the first two)
   *   onbrush (startMs, endMs) => void          enables the brush when given
   *   onbar   (entry) => void                   click on a bucket, when given
   */
  let {
    type = 'bar',
    series = [],
    data = [],
    bucket = null,
    height = 180,
    onbrush = null,
    onbar = null,
    xlabel = defaultX,
    ylabel = n => n.toLocaleString(),
    showY = true,
    minTicks = 4,
    padLeft = 40,
    empty = 'no data',
    brushHint = 'drag to zoom',
  } = $props();

  const uid = $props.id();
  const PAD = { top: 12, right: 12, bottom: 24 };
  let width = $state(0);
  let hover = $state(null); // bucket index
  let press = $state(null); // { x, i }
  let brush = $state(null); // { from, to } bucket indexes, inclusive
  let wrap = $state();

  function defaultX(t, span) {
    const d = new Date(t);
    if (span > 3 * 86400e3) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    if (span > 86400e3)
      return d.toLocaleString([], {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  const step = $derived(bucket ?? (data.length > 1 ? data[1].at - data[0].at : 60e3));
  const span = $derived(data.length ? data.at(-1).at + step - data[0].at : 0);
  const left = $derived(showY ? padLeft : 6);
  const innerW = $derived(Math.max(0, width - left - PAD.right));
  const innerH = $derived(Math.max(0, height - PAD.top - PAD.bottom));
  // Areas overlap from 0: stacked, a small series would just trace the total.
  const stacked = $derived(type !== 'area');
  const totals = $derived(
    data.map(d =>
      stacked
        ? series.reduce((s, x) => s + (d[x.key] || 0), 0)
        : Math.max(0, ...series.map(x => d[x.key] || 0))
    )
  );
  const rawMax = $derived(Math.max(0, ...totals));

  // A rounded ceiling and evenly spaced ticks so the y axis reads as 0 / 50 / 100, not 0 / 47 / 94.
  const yTicks = $derived.by(() => {
    if (!rawMax) return { max: minTicks, ticks: [0, minTicks / 2, minTicks] };
    const rough = rawMax / 3;
    const mag = 10 ** Math.floor(Math.log10(rough));
    const nice = [1, 2, 2.5, 5, 10].map(m => m * mag).find(v => v >= rough) ?? 10 * mag;
    const max = Math.ceil(rawMax / nice) * nice;
    const ticks = [];
    for (let v = 0; v <= max + 1e-9; v += nice) ticks.push(v);
    return { max, ticks };
  });
  const yMax = $derived(yTicks.max);
  const slot = $derived(data.length ? innerW / data.length : 0);
  const barW = $derived(Math.max(1, slot - Math.min(6, slot * 0.35)));
  const y = v => PAD.top + innerH - (v / yMax) * innerH;
  const cx = i => left + i * slot + slot / 2;

  const bars = $derived(
    data.map((d, i) => {
      let acc = 0;
      const segs = series.map(s => {
        const v = d[s.key] || 0;
        const seg = { key: s.key, color: s.color, y0: y(acc), y1: y(acc + v), v };
        if (stacked) acc += v;
        return seg;
      });
      return {
        i,
        x: left + i * slot + (slot - barW) / 2,
        segs,
        total: segs.reduce((t, g) => t + g.v, 0),
        at: d.at,
      };
    })
  );

  // Areas share the bar math: each series fills between its lower and upper edge.
  const areas = $derived.by(() => {
    if (type !== 'area' || data.length < 2) return [];
    return series.map((s, si) => {
      const top = bars.map(b => `${cx(b.i).toFixed(1)} ${b.segs[si].y1.toFixed(1)}`);
      const bottom = bars.map(b => `${cx(b.i).toFixed(1)} ${b.segs[si].y0.toFixed(1)}`).reverse();
      return {
        key: s.key,
        color: s.color,
        line: `M${top.join(' L')}`,
        fill: `M${top.join(' L')} L${bottom.join(' L')} Z`,
      };
    });
  });

  // Around 6 x labels, always aligned to a bucket start, never crowding each other.
  const xTicks = $derived.by(() => {
    if (!data.length || !innerW) return [];
    const want = Math.max(2, Math.min(8, Math.floor(innerW / 90)));
    const every = Math.max(1, Math.ceil(data.length / want));
    const out = [];
    for (let i = 0; i < data.length; i += every)
      out.push({ x: cx(i), label: xlabel(data[i].at, span) });
    return out;
  });

  function indexAt(clientX) {
    const r = wrap.getBoundingClientRect();
    const x = clientX - r.left - left;
    return Math.max(0, Math.min(data.length - 1, Math.floor(x / slot)));
  }
  function onpointerdown(e) {
    if (!data.length) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press = { x: e.clientX, i: indexAt(e.clientX) };
  }
  function onpointermove(e) {
    if (!data.length) return;
    const i = indexAt(e.clientX);
    hover = i;
    if (press && (brush || Math.abs(e.clientX - press.x) > 4) && onbrush)
      brush = { from: press.i, to: i };
  }
  function onpointerup(e) {
    if (brush) {
      const a = Math.min(brush.from, brush.to);
      const b = Math.max(brush.from, brush.to);
      const sel = brush;
      brush = null;
      press = null;
      if (onbrush && data[a] && data[b]) onbrush(data[a].at, data[b].at + step, sel);
      return;
    }
    if (press && onbar) {
      const i = indexAt(e.clientX);
      if (data[i]) onbar(data[i]);
    }
    press = null;
  }
  function onpointerleave() {
    hover = null;
    if (!brush) press = null;
  }
  function onkey(e) {
    if (e.key === 'Escape' && (brush || press)) {
      brush = null;
      press = null;
    }
  }

  const tip = $derived.by(() => {
    if (hover == null || !bars[hover]) return null;
    const b = bars[hover];
    const x = cx(hover);
    const flip = x > width * 0.62;
    return {
      at: b.at,
      total: b.total,
      rows: series.map(s => ({ ...s, v: data[hover][s.key] || 0 })).reverse(),
      x: flip ? width - x + 12 : x + 12,
      flip,
    };
  });
  const tipTime = t =>
    new Date(t).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  const brushRect = $derived.by(() => {
    if (!brush) return null;
    const a = Math.min(brush.from, brush.to);
    const b = Math.max(brush.from, brush.to);
    return { x: left + a * slot, w: (b - a + 1) * slot };
  });
</script>

<svelte:window onkeydown={onkey} />

<div
  class="chart"
  class:brushable={!!onbrush}
  class:clickable={!!onbar}
  bind:this={wrap}
  bind:clientWidth={width}
  style="height:{height}px"
  role="img"
  aria-label={onbrush ? 'chart, drag to zoom into a time range' : 'chart'}
>
  {#if width}
    <svg {width} {height} aria-hidden="true">
      <defs>
        {#each series as s (s.key)}
          <linearGradient id="{uid}-{s.key}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color={s.color} stop-opacity="0.32" />
            <stop offset="100%" stop-color={s.color} stop-opacity="0.03" />
          </linearGradient>
        {/each}
      </defs>
      {#if showY}
        {#each yTicks.ticks as t (t)}
          <line x1={left} x2={width - PAD.right} y1={y(t)} y2={y(t)} class="grid" />
          <text x={left - 8} y={y(t)} class="ylab">{ylabel(t)}</text>
        {/each}
      {:else}
        <line x1={left} x2={width - PAD.right} y1={y(0)} y2={y(0)} class="grid" />
      {/if}
      {#each xTicks as t (t.x)}
        <text x={t.x} y={height - 6} class="xlab">{t.label}</text>
      {/each}
      {#if brushRect}
        <rect x={brushRect.x} y={PAD.top} width={brushRect.w} height={innerH} class="brush" />
        <line x1={brushRect.x} x2={brushRect.x} y1={PAD.top} y2={y(0)} class="brush-edge" />
        <line
          x1={brushRect.x + brushRect.w}
          x2={brushRect.x + brushRect.w}
          y1={PAD.top}
          y2={y(0)}
          class="brush-edge"
        />
      {/if}
      {#if type === 'area'}
        {#each areas as a (a.key)}
          <path d={a.fill} fill="url(#{uid}-{a.key})" />
          <path
            d={a.line}
            fill="none"
            stroke={a.color}
            stroke-width="1.75"
            stroke-linejoin="round"
          />
        {/each}
        {#if hover != null && bars[hover]}
          {#each bars[hover].segs as s (s.key)}
            {#if s.v > 0 || series.length === 1}
              <circle cx={cx(hover)} cy={s.y1} r="3.5" fill={s.color} class="pt" />
            {/if}
          {/each}
        {/if}
      {:else}
        {#each bars as b (b.i)}
          <g class="bar" class:dimmed={hover != null && hover !== b.i && !brush}>
            {#each b.segs as s (s.key)}
              {#if s.v > 0}
                <rect
                  x={b.x}
                  y={s.y1}
                  width={barW}
                  height={Math.max(1, s.y0 - s.y1)}
                  fill={s.color}
                  rx={barW > 3 ? 2 : 0}
                />
              {/if}
            {/each}
          </g>
        {/each}
      {/if}
      {#if hover != null && bars[hover] && !brush}
        <line x1={cx(hover)} x2={cx(hover)} y1={PAD.top} y2={y(0)} class="crosshair" />
      {/if}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <rect
        x={left}
        y={PAD.top}
        width={innerW}
        height={innerH + PAD.bottom}
        class="hit"
        {onpointerdown}
        {onpointermove}
        {onpointerup}
        {onpointerleave}
      />
    </svg>
    {#if !data.length}
      <div class="none">{empty}</div>
    {/if}
    {#if tip}
      <div class="tip" style={tip.flip ? `right:${tip.x}px` : `left:${tip.x}px`}>
        <div class="tt">{tipTime(tip.at)}</div>
        {#each tip.rows as r (r.key)}
          <div class="tr">
            <i style="background:{r.color}"></i><span>{r.label}</span><b>{ylabel(r.v)}</b>
          </div>
        {/each}
        {#if series.length > 1}
          <div class="tr total"><i></i><span>total</span><b>{ylabel(tip.total)}</b></div>
        {/if}
        {#if onbrush && !brush}<div class="hint">{brushHint}</div>{/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .chart {
    position: relative;
    width: 100%;
    min-width: 0;
    user-select: none;
    -webkit-user-select: none;
  }
  svg {
    display: block;
    overflow: visible;
  }
  .grid {
    stroke: var(--chart-grid);
    stroke-width: 1;
    shape-rendering: crispEdges;
  }
  .ylab {
    font: var(--fs-xs) var(--mono);
    fill: var(--text-dim);
    text-anchor: end;
    dominant-baseline: middle;
  }
  .xlab {
    font: var(--fs-xs) var(--mono);
    fill: var(--text-dim);
    text-anchor: middle;
  }
  .bar {
    transition: opacity 0.1s;
  }
  .bar.dimmed {
    opacity: 0.55;
  }
  .pt {
    stroke: var(--card);
    stroke-width: 2;
  }
  .crosshair {
    stroke: var(--chart-crosshair);
    stroke-width: 1;
    stroke-dasharray: 3 3;
    pointer-events: none;
  }
  .brush {
    fill: var(--chart-brush);
  }
  .brush-edge {
    stroke: var(--chart-brush-edge);
    stroke-width: 1.5;
  }
  .hit {
    fill: transparent;
    cursor: default;
    touch-action: none;
  }
  .brushable .hit {
    cursor: crosshair;
  }
  .clickable .hit {
    cursor: pointer;
  }
  .none {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: var(--fs-sm);
    color: var(--text-dim);
    pointer-events: none;
  }
  .tip {
    position: absolute;
    top: 8px;
    z-index: 5;
    min-width: 160px;
    padding: 10px 12px;
    background: var(--pop);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-pop);
    font-size: var(--fs-sm);
    pointer-events: none;
  }
  .tt {
    font-weight: 600;
    color: var(--text-bright);
    margin-bottom: 6px;
    white-space: nowrap;
  }
  .tr {
    display: grid;
    grid-template-columns: 8px 1fr auto;
    gap: 8px;
    align-items: center;
    line-height: 1.8;
    color: var(--text-muted);
  }
  .tr i {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    display: block;
  }
  .tr b {
    font-family: var(--mono);
    font-weight: 500;
    color: var(--text-bright);
    font-variant-numeric: tabular-nums;
  }
  .tr.total {
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid var(--line);
  }
  .hint {
    margin-top: 6px;
    color: var(--text-dim);
    font-size: var(--fs-xs);
  }
</style>
