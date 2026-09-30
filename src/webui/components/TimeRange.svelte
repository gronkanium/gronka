<script>
  /**
   * Time range control shared by every time-filtered page: relative presets, an absolute
   * window with previous / next / zoom-out, and a custom picker. The value is either a preset
   * key or an absolute [startTime, endTime]; onchange receives the same shape back.
   *
   *   presets   { '1h': 1, '24h': 24, '7d': 168 }   key -> hours
   *   value     { range, startTime, endTime }        range wins when startTime is empty
   *   allowAll  adds an "all" preset that clears the range
   */
  import { tick } from 'svelte';
  import { ChevronLeft, ChevronRight, ZoomOut, CalendarRange, X } from 'lucide-svelte';

  let {
    presets = { '1h': 1, '24h': 24, '7d': 168 },
    value = {},
    onchange,
    allowAll = false,
    defaultRange = '24h',
    compact = false,
  } = $props();

  let open = $state(false);
  let from = $state('');
  let to = $state('');
  let firstInput = $state();

  const absolute = $derived(!!value.startTime);
  const hours = $derived(presets[value.range] ?? null);
  const start = $derived(
    absolute ? Number(value.startTime) : hours ? Date.now() - hours * 3600e3 : null
  );
  const end = $derived(absolute ? Number(value.endTime) || Date.now() : Date.now());
  const width = $derived(start ? end - start : 0);

  const fmt = t => {
    const d = new Date(t);
    const sameDay = new Date().toDateString() === d.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      : d.toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
  };
  const label = $derived(
    absolute
      ? `${fmt(start)} – ${value.endTime ? fmt(end) : 'now'}`
      : hours
        ? `${fmt(start)} – now`
        : 'all time'
  );

  const emit = next => onchange?.({ range: '', startTime: null, endTime: null, ...next });
  const preset = key => emit(key === 'all' ? {} : { range: key });
  function shift(dir) {
    if (!start) return;
    const s = start + dir * width;
    const e = end + dir * width;
    emit({ startTime: String(s), endTime: e >= Date.now() ? null : String(e) });
  }
  function zoomOut() {
    if (!start) return;
    const s = start - width / 2;
    const e = end + width / 2;
    emit({ startTime: String(s), endTime: e >= Date.now() ? null : String(e) });
  }
  const local = t => {
    const d = new Date(t);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  async function openPicker() {
    open = !open;
    if (!open) return;
    from = local(start ?? Date.now() - 3600e3);
    to = local(end);
    await tick();
    firstInput?.focus();
  }
  function apply() {
    const s = new Date(from).getTime();
    const e = new Date(to).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return;
    open = false;
    emit({ startTime: String(s), endTime: e >= Date.now() - 60e3 ? null : String(e) });
  }
  function onkey(e) {
    if (e.key === 'Escape') open = false;
  }
</script>

<div class="range" class:compact role="group" aria-label="time range">
  <div class="seg">
    {#each Object.keys(presets) as key (key)}
      <button class:on={!absolute && value.range === key} onclick={() => preset(key)}>{key}</button>
    {/each}
    {#if allowAll}
      <button class:on={!absolute && !value.range} onclick={() => preset('all')}>all</button>
    {/if}
  </div>
  <div class="win" class:abs={absolute}>
    <button
      class="icon-btn sm"
      onclick={() => shift(-1)}
      disabled={!start}
      title="previous window"
      aria-label="previous window"><ChevronLeft size={14} /></button
    >
    <button class="lbl mono" onclick={openPicker} title="pick an exact window" aria-expanded={open}>
      <CalendarRange size={12} />
      <span>{label}</span>
    </button>
    <button
      class="icon-btn sm"
      onclick={() => shift(1)}
      disabled={!start || !absolute || !value.endTime}
      title="next window"
      aria-label="next window"><ChevronRight size={14} /></button
    >
    {#if absolute}
      <button class="icon-btn sm" onclick={zoomOut} title="zoom out" aria-label="zoom out"
        ><ZoomOut size={14} /></button
      >
      <button
        class="icon-btn sm"
        onclick={() => emit({ range: defaultRange })}
        title="back to {defaultRange}"
        aria-label="clear window"><X size={14} /></button
      >
    {/if}
  </div>
  {#if open}
    <div class="scrim" onclick={() => (open = false)} role="presentation"></div>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="pop picker"
      role="dialog"
      tabindex="-1"
      aria-label="custom time window"
      onkeydown={onkey}
    >
      <label
        >From <input
          class="field"
          type="datetime-local"
          bind:this={firstInput}
          bind:value={from}
        /></label
      >
      <label>To <input class="field" type="datetime-local" bind:value={to} /></label>
      <div class="row">
        <button class="btn primary sm" onclick={apply}>Apply</button>
        <button class="btn sm" onclick={() => (open = false)}>Cancel</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .range {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .win {
    display: flex;
    align-items: center;
    gap: 1px;
    height: 30px;
    padding: 0 3px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }
  .win.abs {
    border-color: var(--accent-border);
    background: var(--accent-bg);
  }
  .lbl {
    height: 24px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-muted);
    font-size: var(--fs-sm);
    white-space: nowrap;
    cursor: pointer;
  }
  .abs .lbl {
    color: var(--text-bright);
  }
  .lbl:hover {
    background: var(--surface-3);
    color: var(--text-bright);
  }
  .compact .lbl span {
    display: none;
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 70;
  }
  .picker {
    position: absolute;
    right: 0;
    top: 36px;
    z-index: 71;
    width: 260px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .picker label {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .picker .field {
    font-family: var(--mono);
    font-size: var(--fs-sm);
  }
  @media (max-width: 640px) {
    .lbl span {
      display: none;
    }
  }
</style>
