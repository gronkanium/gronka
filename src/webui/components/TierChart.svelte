<script>
  import { X } from 'lucide-svelte';

  let { tiers = $bindable([]) } = $props();

  const H = 250;
  const PAD = { l: 44, r: 16, t: 34, b: 30 };
  const X_MIN = 10;
  const X_TICKS = [10, 100, 1024, 4096, 16384];
  const Y_TICKS = [1, 6, 24, 72, 168, 336, 720];

  let width = $state(320);
  let drag = $state(null);
  let hover = $state(null);
  let focused = $state(-1);

  const domain = rows => ({
    xMax: Math.max(4096, ...rows.map(r => r.mb * 2)),
    yMax: Math.max(168, ...rows.map(r => r.hours * 1.3)),
  });
  let dom = $state(domain(tiers));
  $effect(() => {
    if (!drag) dom = domain(tiers);
  });

  const plotW = $derived(Math.max(200, width - PAD.l - PAD.r));
  const plotH = H - PAD.t - PAD.b;
  const span = $derived(Math.log10(dom.xMax / X_MIN));
  const x = mb => PAD.l + (Math.log10(Math.max(X_MIN, mb) / X_MIN) / span) * plotW;
  const xInv = px => X_MIN * 10 ** (((px - PAD.l) / plotW) * span);
  const y = h => PAD.t + plotH - Math.sqrt(Math.max(0, h) / dom.yMax) * plotH;
  const yInv = py => ((PAD.t + plotH - py) / plotH) ** 2 * dom.yMax;

  const fmtH = h =>
    h < 48 ? `${h} h` : h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${h / 24} d`;
  const fmtMb = mb => (mb >= 1024 ? `${+(mb / 1024).toFixed(2)} GB` : `${mb} MB`);
  const compact = $derived(plotW < 480);
  const knobLbl = mb =>
    !compact ? fmtMb(mb) : mb >= 1024 ? `${+(mb / 1024).toFixed(1)}G` : `${mb}`;
  const pillW = mb => 14 + knobLbl(mb).length * 6;
  const snapMb = v => {
    const step = v >= 1000 ? 128 : v >= 100 ? 25 : v >= 10 ? 5 : 1;
    return Math.max(1, Math.round(v / step) * step);
  };
  const snapH = v => {
    const step = v >= 72 ? 12 : v >= 24 ? 6 : 1;
    return Math.max(1, Math.round(v / step) * step);
  };

  const steps = $derived(tiers.map((t, i) => ({ ...t, from: i ? tiers[i - 1].mb : X_MIN, i })));
  const last = $derived(tiers.at(-1));
  const hoursFor = mb => (tiers.find(t => mb <= t.mb) ?? last)?.hours;

  const point = e => {
    const r =
      e.currentTarget.ownerSVGElement?.getBoundingClientRect() ??
      e.currentTarget.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };
  const setMb = (i, mb) => {
    const lo = i ? tiers[i - 1].mb + 1 : 1;
    const hi = i < tiers.length - 1 ? tiers[i + 1].mb - 1 : dom.xMax;
    tiers[i].mb = Math.min(hi, Math.max(lo, Math.round(mb)));
  };
  const setH = (i, h) =>
    (tiers[i].hours = Math.min(Math.floor(dom.yMax), Math.max(1, Math.round(h))));

  function start(e, kind, i) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    drag = { kind, i };
  }
  function move(e) {
    if (!drag) return;
    const { px, py } = point(e);
    if (drag.kind === 'mb') setMb(drag.i, snapMb(xInv(px)));
    else setH(drag.i, snapH(yInv(py)));
  }
  const end = () => (drag = null);

  function key(e, kind, i) {
    const big = e.shiftKey;
    if (e.key === 'Delete' || e.key === 'Backspace') return remove(i);
    const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    if (kind === 'h') setH(i, tiers[i].hours + dir * (big ? 12 : 1));
    else setMb(i, tiers[i].mb * (1 + dir * (big ? 0.25 : 0.05)) + dir);
  }

  function remove(i) {
    if (tiers.length > 1) tiers = tiers.filter((_, j) => j !== i);
  }
  function split(e) {
    const mb = snapMb(xInv(point(e).px));
    if (mb >= dom.xMax || tiers.some(t => t.mb === mb)) return;
    const i = tiers.findIndex(t => mb < t.mb);
    const hours = i === -1 ? last.hours : tiers[i].hours;
    tiers = [...tiers, { mb, hours }].sort((a, b) => a.mb - b.mb);
  }
  function track(e) {
    const { px } = point(e);
    if (px < PAD.l || px > PAD.l + plotW) return (hover = null);
    const mb = Math.round(xInv(px));
    hover = { px, mb, hours: hoursFor(mb) };
  }
</script>

<div class="tier-chart" bind:clientWidth={width}>
  <svg
    {width}
    height={H}
    role="group"
    aria-label="Upload lifetime by file size"
    onpointermove={e => (drag ? move(e) : track(e))}
    onpointerup={end}
    onpointerleave={() => (hover = null)}
  >
    {#each Y_TICKS.filter(t => t <= dom.yMax) as t (t)}
      <line class="grid" x1={PAD.l} x2={PAD.l + plotW} y1={y(t)} y2={y(t)} />
      <text class="tick" x={PAD.l - 8} y={y(t) + 4} text-anchor="end">{fmtH(t)}</text>
    {/each}
    {#each X_TICKS.filter(t => t <= dom.xMax && tiers.every(r => Math.abs(x(r.mb) - x(t)) > 40)) as t (t)}
      <text class="tick" x={x(t)} y={H - 8} text-anchor="middle">{fmtMb(t)}</text>
    {/each}

    <rect
      class="plot"
      x={PAD.l}
      y={PAD.t}
      width={plotW}
      height={plotH}
      role="presentation"
      ondblclick={split}
    />

    {#if last}
      <rect
        class="area larger"
        x={x(last.mb) + 1}
        y={y(last.hours)}
        width={Math.max(0, x(dom.xMax) - x(last.mb) - 1)}
        height={PAD.t + plotH - y(last.hours)}
        ondblclick={split}
        role="presentation"
      />
      <text
        class="lbl muted"
        x={(x(last.mb) + x(dom.xMax)) / 2}
        y={y(last.hours) - 10}
        text-anchor="middle">{compact ? 'larger' : `larger · ${fmtH(last.hours)}`}</text
      >
    {/if}

    {#each steps as s (s.i)}
      {@const x0 = x(s.from) + (s.i ? 1 : 0)}
      {@const x1 = x(s.mb) - 1}
      <g class="step" class:on={focused === s.i || drag?.i === s.i}>
        <rect
          class="area"
          x={x0}
          y={y(s.hours)}
          width={Math.max(0, x1 - x0)}
          height={PAD.t + plotH - y(s.hours)}
          ondblclick={split}
          role="presentation"
        />
        <line class="top" x1={x0} x2={x1} y1={y(s.hours)} y2={y(s.hours)} />
        <rect
          class="hit-h"
          x={x0}
          y={y(s.hours) - 8}
          width={Math.max(0, x1 - x0)}
          height="16"
          tabindex="0"
          role="slider"
          aria-label={`hours kept for files up to ${fmtMb(s.mb)}`}
          aria-valuenow={s.hours}
          aria-valuemin="1"
          aria-valuemax={Math.floor(dom.yMax)}
          onpointerdown={e => start(e, 'h', s.i)}
          onkeydown={e => key(e, 'h', s.i)}
          onfocus={() => (focused = s.i)}
          onblur={() => (focused = -1)}
        />
        <text class="lbl" x={(x0 + x1) / 2} y={y(s.hours) - 10} text-anchor="middle"
          >{fmtH(s.hours)}</text
        >
        {#if tiers.length > 1 && x1 - x0 > 56}
          <foreignObject x={x1 - 22} y={y(s.hours) + 4} width="20" height="20">
            <button
              class="rm"
              aria-label={`remove the ${fmtMb(s.mb)} tier`}
              onclick={() => remove(s.i)}><X size={12} /></button
            >
          </foreignObject>
        {/if}

        <line
          class="div"
          x1={x(s.mb)}
          x2={x(s.mb)}
          y1={PAD.t + plotH}
          y2={Math.min(y(s.hours), y(tiers[s.i + 1]?.hours ?? last.hours))}
        />
        <g
          class="knob"
          tabindex="0"
          role="slider"
          aria-label={`size ceiling of tier ${s.i + 1}`}
          aria-valuenow={s.mb}
          aria-valuetext={fmtMb(s.mb)}
          onpointerdown={e => start(e, 'mb', s.i)}
          onkeydown={e => key(e, 'mb', s.i)}
          onfocus={() => (focused = s.i)}
          onblur={() => (focused = -1)}
        >
          <rect class="hit-x" x={x(s.mb) - 8} y={PAD.t} width="16" height={plotH} />
          <rect
            class="pill"
            x={x(s.mb) - pillW(s.mb) / 2}
            y={PAD.t + plotH - 10}
            width={pillW(s.mb)}
            height="20"
            rx="10"
          />
          <text x={x(s.mb)} y={PAD.t + plotH + 4} text-anchor="middle">{knobLbl(s.mb)}</text>
        </g>
      </g>
    {/each}

    {#if hover && !drag && hover.hours}
      <line class="cross" x1={hover.px} x2={hover.px} y1={PAD.t} y2={PAD.t + plotH} />
    {/if}
  </svg>
  <div class="readout" aria-live="polite">
    {#if drag}
      {@const t = tiers[drag.i]}
      Files up to <b>{fmtMb(t.mb)}</b> are kept <b>{fmtH(t.hours)}</b>
    {:else if hover?.hours}
      A <b>{fmtMb(hover.mb)}</b> file is kept <b>{fmtH(hover.hours)}</b>
    {:else}
      <span class="dim"
        >Drag a step up or down to change how long, drag a size marker sideways to move the
        boundary. Double-click to split a step.</span
      >
    {/if}
  </div>
</div>

<style>
  .tier-chart {
    width: 100%;
    min-width: 0;
    user-select: none;
    touch-action: none;
  }
  svg {
    display: block;
    overflow: visible;
  }
  .grid {
    stroke: var(--line);
  }
  .tick {
    font-size: 11px;
    fill: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .plot {
    fill: transparent;
  }
  .area {
    fill: var(--accent);
    opacity: 0.16;
    transition: opacity 0.12s;
  }
  .area.larger {
    opacity: 0.07;
  }
  .step:hover .area,
  .step.on .area {
    opacity: 0.28;
  }
  .top {
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linecap: round;
  }
  .step.on .top {
    stroke-width: 3;
  }
  .hit-h {
    fill: transparent;
    cursor: ns-resize;
    outline: none;
  }
  .lbl {
    font-size: 12px;
    font-weight: 600;
    fill: var(--text-bright);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
  .lbl.muted {
    fill: var(--text-muted);
    font-weight: 500;
  }
  .div {
    stroke: var(--border-2);
    stroke-dasharray: 3 3;
  }
  .knob {
    cursor: ew-resize;
    outline: none;
  }
  .hit-x {
    fill: transparent;
  }
  .pill {
    fill: var(--card);
    stroke: var(--border-2);
  }
  .knob:hover .pill,
  .knob:focus-visible .pill,
  .step.on .pill {
    stroke: var(--accent);
  }
  .knob:focus-visible .pill,
  .hit-h:focus-visible {
    stroke: var(--accent);
    stroke-width: 2;
  }
  .knob text {
    font-size: 11px;
    font-weight: 600;
    fill: var(--text-bright);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
  .rm {
    width: 20px;
    height: 20px;
    display: none;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--card);
    color: var(--text-muted);
    cursor: pointer;
  }
  .step:hover .rm,
  .step.on .rm {
    display: grid;
  }
  .rm:hover {
    color: var(--danger-text);
  }
  .cross {
    stroke: var(--text-dim);
    stroke-dasharray: 2 3;
    pointer-events: none;
  }
  .readout {
    min-height: 20px;
    margin-top: 6px;
    font-size: var(--fs-sm);
    color: var(--text-soft);
  }
  .readout b {
    color: var(--text-bright);
    font-variant-numeric: tabular-nums;
  }
</style>
