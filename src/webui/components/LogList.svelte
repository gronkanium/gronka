<script>
  /**
   * The log line list: level gutter and badge, time, component, message with query matches
   * marked, a view menu, live-tail pause banner, skeleton / error / empty states, and a footer
   * that loads the next page when scrolled into view.
   *
   *   rows      lines to show (already filtered)       selectedId  highlighted line
   *   prefs     { wrap, timestamps, density } bindable  search      text to mark in messages
   *   fresh     Set of ids that just arrived (flash)    pending     live lines held while paused
   *   atTop     bindable: the list is scrolled to the top (live tail keeps prepending)
   *   empty     snippet for the no-results state
   */
  import { onMount } from 'svelte';
  import { CircleAlert, PanelLeftOpen, Pause, RotateCw } from 'lucide-svelte';
  import { formatRelativeTime } from '../utils/format.js';
  import LogLevel, { clock, compColor, day, highlight, lv, utc } from './LogLevel.svelte';
  import LogViewMenu from './LogViewMenu.svelte';

  let {
    rows = [],
    selectedId = null,
    search = '',
    prefs = $bindable(),
    loading = false,
    error = '',
    total = 0,
    excluded = 0,
    hasMore = false,
    loadingMore = false,
    fresh = new Set(),
    pending = 0,
    live = false,
    atTop = $bindable(true),
    facetsHidden = false,
    onselect,
    onstep,
    onresume,
    onmore,
    onretry,
    onshowfacets,
    empty,
  } = $props();

  let scroller = $state();
  let sentinel = $state();

  const KV = ['source', 'command', 'worker', 'job'];
  const kv = r =>
    KV.map(k => r.metadata?.[k] != null && `${k}=${r.metadata[k]}`)
      .filter(Boolean)
      .join(' ');

  function onscroll() {
    atTop = scroller.scrollTop < 8;
  }
  function resume() {
    scroller?.scrollTo({ top: 0 });
    atTop = true;
    onresume?.();
  }

  function onkeydown(e) {
    if (e.target.closest('input, textarea')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      onstep?.(e.key === 'ArrowDown' ? 1 : -1);
    }
  }

  // Keep the selected row visible, and keep keyboard focus on it while stepping through lines.
  $effect(() => {
    if (selectedId == null || !scroller) return;
    const el = scroller.querySelector(`[data-id="${CSS.escape(String(selectedId))}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    if (scroller.contains(document.activeElement)) el.focus({ preventScroll: true });
  });

  onMount(() => {
    const io = new IntersectionObserver(
      entries => entries[0]?.isIntersecting && hasMore && !loadingMore && onmore?.(),
      { root: scroller, rootMargin: '200px' }
    );
    if (sentinel) io.observe(sentinel);
    return () => io.disconnect();
  });
</script>

<section
  class="list"
  class:wrap={prefs.wrap}
  class:comfy={prefs.density === 'comfortable'}
  class:no-ts={!prefs.timestamps}
  aria-label="log lines"
>
  <div class="lh cols">
    <span class="c-lvl">
      {#if facetsHidden}
        <button
          class="icon-btn sm show-facets"
          onclick={onshowfacets}
          title="show filters"
          aria-label="show filters"><PanelLeftOpen size={14} /></button
        >
      {:else}Level{/if}
    </span>
    {#if prefs.timestamps}<span>Time</span>{/if}
    <span class="c-comp">Component</span>
    <span class="c-msg">Message <LogViewMenu bind:prefs /></span>
  </div>

  {#if error}
    <div class="err" role="alert">
      <CircleAlert size={15} />
      <span class="grow">{error}</span>
      <button class="btn sm" onclick={onretry}><RotateCw size={12} />Retry</button>
    </div>
  {/if}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="scroll"
    class:stale={loading && rows.length}
    bind:this={scroller}
    {onscroll}
    {onkeydown}
  >
    {#if live && !atTop}
      <div class="paused">
        <Pause size={12} />
        <span
          >Paused · <b class="tnum">{pending.toLocaleString()}</b>
          new {pending === 1 ? 'line' : 'lines'}</span
        >
        <button class="linkish" onclick={resume}>Resume</button>
      </div>
    {/if}

    {#if loading && !rows.length}
      {#each Array(12) as _, i (i)}
        <div class="row cols skel" aria-hidden="true">
          <span class="skeleton" style="width:32px"></span>
          {#if prefs.timestamps}<span class="skeleton" style="width:128px"></span>{/if}
          <span class="skeleton" style="width:{50 + ((i * 29) % 40)}px"></span>
          <span class="skeleton" style="width:{40 + ((i * 37) % 50)}%"></span>
        </div>
      {/each}
    {:else if !rows.length && !error}
      {@render empty?.()}
    {/if}

    {#each rows as r (r.id)}
      {@const l = lv(r.level)}
      <button
        class="row cols"
        class:sel={selectedId === r.id}
        class:fresh={fresh.has(r.id)}
        style="--lc:{l.color}"
        data-id={r.id}
        onclick={() => onselect?.(r)}
      >
        <span class="c-lvl"><LogLevel level={r.level} /></span>
        {#if prefs.timestamps}
          <span class="c-time" title="{utc(r.timestamp)} · {formatRelativeTime(r.timestamp)}"
            ><span class="dd">{day(r.timestamp)} </span>{clock(r.timestamp)}</span
          >
        {/if}
        <span class="c-comp"
          ><i style="background:{compColor(r.component)}"></i><span>{r.component}</span></span
        >
        <span class="c-msg m"
          >{#each highlight(r.message, search) as p, i (i)}{#if p.hit}<mark>{p.text}</mark
              >{:else}{p.text}{/if}{/each}{#if kv(r)}<span class="kv">{kv(r)}</span>{/if}</span
        >
      </button>
    {/each}
    <div class="sentinel" bind:this={sentinel}></div>
  </div>

  <footer class="lf" class:hidden={!rows.length && !total}>
    {#if rows.length || total}
      <span
        >Showing <b class="tnum">{rows.length ? `1–${rows.length.toLocaleString()}` : '0'}</b> of
        <b class="tnum">{total.toLocaleString()}</b></span
      >
    {/if}
    {#if excluded}
      <span
        class="excl"
        title="the API only filters positive matches; exclusions apply to the loaded lines"
        >· {excluded.toLocaleString()} excluded client-side</span
      >
    {/if}
    {#if loadingMore}<span class="dim">· loading more…</span>{/if}
    {#if hasMore && !loadingMore}
      <button class="linkish right" onclick={onmore}>Load more</button>
    {/if}
  </footer>
</section>

<style>
  .list {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    --row-h: 28px;
  }
  .list.comfy {
    --row-h: 36px;
  }
  .cols {
    display: grid;
    grid-template-columns: 56px 156px 132px minmax(0, 1fr);
    gap: 12px;
    align-items: center;
    padding: 0 12px 0 9px;
  }
  .no-ts .cols {
    grid-template-columns: 56px 132px minmax(0, 1fr);
  }
  .lh {
    height: 32px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--line);
    border-left: 3px solid transparent;
    background: var(--card-2);
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-muted);
    padding-right: 6px;
  }
  .lh .c-msg {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .show-facets {
    margin-left: -6px;
  }

  .err {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px 8px 16px;
    background: var(--danger-bg);
    border-bottom: 1px solid var(--danger-border);
    color: var(--danger-text);
    font-size: var(--fs);
  }
  .scroll {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    transition: opacity 0.15s;
  }
  .scroll.stale {
    opacity: 0.5;
    transition-delay: 0.3s;
  }
  .paused {
    position: sticky;
    top: 0;
    z-index: 3;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: var(--warning-bg);
    border-bottom: 1px solid var(--warning-border);
    color: var(--warning-text);
    font-size: var(--fs-sm);
  }
  .paused b {
    font-weight: 600;
  }
  .paused .linkish {
    font-size: var(--fs-sm);
  }

  .row {
    width: 100%;
    min-height: var(--row-h);
    height: var(--row-h);
    border: 0;
    border-left: 3px solid var(--lc, transparent);
    background: none;
    color: var(--text);
    font: var(--fs-sm) / 18px var(--mono);
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--row-hover);
  }
  .row.sel {
    background: var(--row-selected);
    border-left-color: var(--accent-strong);
  }
  .row.fresh {
    animation: arrive 1.5s ease-out;
  }
  @keyframes arrive {
    from {
      background: var(--card-3);
    }
  }
  .row.skel {
    border-left-color: var(--line);
    pointer-events: none;
  }
  .row.skel .skeleton {
    height: 10px;
    display: block;
  }
  .c-time .dd {
    margin-right: 0.6em;
  }
  .c-time {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .c-comp {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    color: var(--text-soft);
  }
  .c-comp i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .c-comp span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .m {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-bright);
  }
  .kv {
    margin-left: 12px;
    color: var(--text-dim);
  }
  mark {
    background: color-mix(in srgb, var(--warning) 34%, transparent);
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }
  .wrap .row {
    height: auto;
    align-items: start;
    padding-top: 5px;
    padding-bottom: 5px;
  }
  .wrap .m {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .wrap .c-lvl {
    display: flex;
  }
  .sentinel {
    height: 1px;
  }

  .lf {
    height: 34px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 16px;
    border-top: 1px solid var(--line);
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .lf.hidden {
    display: none;
  }
  .lf b {
    font-weight: 600;
    color: var(--text);
  }
  .excl {
    color: var(--danger-text);
  }
  .lf .linkish {
    font-size: var(--fs-sm);
  }

  @media (max-width: 1100px) {
    .show-facets {
      display: none;
    }
  }
  @media (max-width: 768px) {
    .cols,
    .no-ts .cols {
      grid-template-columns: 40px 88px minmax(0, 1fr);
      gap: 8px;
    }
    .c-comp,
    .c-time .dd {
      display: none;
    }
    .no-ts .cols {
      grid-template-columns: 40px minmax(0, 1fr);
    }
    .row .c-time {
      font-size: var(--fs-xs);
    }
    .row {
      height: auto;
      padding-top: 5px;
      padding-bottom: 5px;
      align-items: start;
    }
    .m {
      white-space: normal;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
  }
</style>
