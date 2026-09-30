<script>
  /**
   * Table panel: sticky uppercase header, sortable columns, tabular numbers, hover and selected
   * rows, skeleton / empty / error states and a pager. Cells come from the `row` snippet, one
   * element per column, in column order.
   *
   *   columns  [{ key, label, width, align: 'right', sortable, sm: false }]
   *            sm: false drops the column on phones; give its cell class="hide-sm".
   *   rows     the data; rowKey names the id field or is a function
   *   onrow    (r) => void makes rows buttons; href (r) => url makes them links
   *   sort     { key, desc } with onsort(key, desc)
   *   pager    { offset, limit, total, onpage(offset) }
   *   header   snippet for the panel header's right side; title for its left
   */
  import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-svelte';

  let {
    columns = [],
    rows = [],
    rowKey = 'id',
    title = '',
    header = null,
    toolbar = null,
    footer = null,
    row,
    onrow = null,
    href = null,
    selected = null,
    rowClass = null,
    rowDisabled = null,
    loading = false,
    error = '',
    onretry = null,
    empty = 'nothing here',
    emptyState = null,
    pager = null,
    sort = null,
    onsort = null,
    flat = false,
    skeleton = 6,
    maxHeight = null,
    label = title || 'table',
  } = $props();

  let narrow = $state(false);
  $effect(() => {
    const mq = matchMedia('(max-width: 720px)');
    const sync = () => (narrow = mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  });

  const shown = $derived(narrow ? columns.filter(c => c.sm !== false) : columns);
  const cols = $derived(shown.map(c => c.width ?? 'minmax(0, 1fr)').join(' '));
  const keyOf = (r, i) => (typeof rowKey === 'function' ? rowKey(r, i) : r[rowKey]);
  const Tag = $derived(href ? 'a' : onrow ? 'button' : 'div');
  const widths = [72, 48, 88, 40, 64, 56];

  function clickSort(c) {
    if (!c.sortable || !onsort) return;
    if (sort?.key === c.key) onsort(c.key, !sort.desc);
    else onsort(c.key, c.align === 'right');
  }
  const from = $derived(pager ? pager.offset + 1 : 0);
  const to = $derived(pager ? Math.min(pager.offset + pager.limit, pager.total) : 0);
</script>

<svelte:element
  this={flat ? 'div' : 'section'}
  class="tbl"
  class:panel={!flat}
  class:narrow
  aria-label={label}
  style="--cols: {cols}"
>
  {#if title || header}
    <div class="ph">
      {#if title}<span>{title}</span>{/if}
      {#if header}<span class="meta">{@render header()}</span>{/if}
    </div>
  {/if}
  {#if toolbar}{@render toolbar()}{/if}
  <div class="body" class:busy={loading && rows.length} style:max-height={maxHeight}>
    <div class="tr head">
      {#each shown as c (c.key)}
        {#if c.sortable && onsort}
          <button
            class="sorter"
            class:num={c.align === 'right'}
            class:on={sort?.key === c.key}
            onclick={() => clickSort(c)}
          >
            {c.label}
            {#if sort?.key === c.key}
              {#if sort.desc}<ArrowDown size={11} />{:else}<ArrowUp size={11} />{/if}
            {/if}
          </button>
        {:else}
          <span class:num={c.align === 'right'}>{c.label}</span>
        {/if}
      {/each}
    </div>
    {#if error}
      <div class="empty error-text">
        {error}
        {#if onretry}<button class="btn sm" onclick={onretry}><RefreshCw size={11} />Retry</button
          >{/if}
      </div>
    {:else if loading && !rows.length}
      {#each Array(skeleton) as _, i (i)}
        <div class="tr skel" aria-hidden="true">
          {#each shown as c, j (c.key)}
            <span
              class="skeleton"
              style="width:{Math.min(100, widths[(i + j) % widths.length])}%;{c.align === 'right'
                ? 'margin-left:auto'
                : ''}"
            ></span>
          {/each}
        </div>
      {/each}
    {:else if !rows.length}
      {#if emptyState}{@render emptyState()}{:else}<div class="empty">{empty}</div>{/if}
    {/if}
    {#each rows as r, i (keyOf(r, i))}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <svelte:element
        this={Tag}
        class="tr {rowClass ? rowClass(r) : ''}"
        class:sel={selected != null && keyOf(r, i) === selected}
        href={href ? href(r) : undefined}
        onclick={onrow ? () => onrow(r) : undefined}
        disabled={rowDisabled ? rowDisabled(r) : undefined}
      >
        {@render row(r, i)}
      </svelte:element>
    {/each}
  </div>
  {#if footer}{@render footer()}{/if}
  {#if pager && pager.total > 0}
    <div class="pager">
      <span class="tnum"
        >{from.toLocaleString()}–{to.toLocaleString()} of {pager.total.toLocaleString()}</span
      >
      <span class="row">
        <button
          class="icon-btn sm"
          disabled={pager.offset === 0}
          onclick={() => pager.onpage(Math.max(0, pager.offset - pager.limit))}
          aria-label="previous page"><ChevronLeft size={15} /></button
        >
        <button
          class="icon-btn sm"
          disabled={pager.offset + pager.limit >= pager.total}
          onclick={() => pager.onpage(pager.offset + pager.limit)}
          aria-label="next page"><ChevronRight size={15} /></button
        >
      </span>
    </div>
  {/if}
</svelte:element>

<style>
  .body {
    position: relative;
    overflow: auto;
  }
  .sorter {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: 0;
    padding: 0;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    text-align: left;
    cursor: pointer;
    min-width: 0;
  }
  .sorter.num {
    justify-content: flex-end;
    text-align: right;
  }
  .sorter:hover,
  .sorter.on {
    color: var(--text);
  }
  .sorter.on {
    color: var(--accent);
  }
  .tr.skel {
    pointer-events: none;
  }
  .tr.skel .skeleton {
    height: 12px;
    display: block;
  }
  .tr:disabled {
    cursor: default;
  }
  .narrow :global(.hide-sm) {
    display: none !important;
  }
</style>
