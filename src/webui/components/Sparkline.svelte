<script>
  /** Tiny inline chart for a table row or a KPI: bars by default, or a filled line. */
  let {
    values = [],
    width = 64,
    height = 18,
    color = 'var(--chart-1)',
    type = 'bars',
    title = '',
  } = $props();

  const max = $derived(Math.max(1, ...values));
  const n = $derived(values.length);
  const gap = 1.5;
  const bw = $derived(n ? Math.max(1, (width - gap * (n - 1)) / n) : 0);
  const line = $derived.by(() => {
    if (n < 2) return { path: '', area: '' };
    const pts = values.map((v, i) => [
      (i / (n - 1)) * width,
      height - 1 - (v / max) * (height - 2),
    ]);
    const path = pts
      .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`)
      .join(' ');
    return { path, area: `${path} L${width} ${height} L0 ${height} Z` };
  });
</script>

<svg {width} {height} class="spark" aria-hidden={!title} role={title ? 'img' : undefined}>
  {#if title}<title>{title}</title>{/if}
  {#if type === 'line'}
    <path d={line.area} fill={color} opacity="0.15" />
    <path d={line.path} fill="none" stroke={color} stroke-width="1.5" stroke-linejoin="round" />
  {:else}
    <line
      x1="0"
      x2={width}
      y1={height - 0.5}
      y2={height - 0.5}
      stroke={color}
      stroke-opacity="0.25"
    />
    {#each values as v, i (i)}
      {#if v > 0}
        <rect
          x={i * (bw + gap)}
          y={height - Math.max(2, (v / max) * height)}
          width={bw}
          height={Math.max(2, (v / max) * height)}
          fill={color}
          rx="1"
        />
      {/if}
    {/each}
  {/if}
</svg>

<style>
  .spark {
    display: block;
    flex-shrink: 0;
  }
</style>
