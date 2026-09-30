<script>
  /**
   * Logs facet sidebar: a searchable list of fields, each with its top values, a proportional
   * bar behind every row, and an "only" shortcut on hover.
   *
   *   facets    { key: [{ value, count }] }   from /api/logs/facets (counts ignore own filter)
   *   filters   { key: [values] }             selected values
   *   negated   { key: [values] }             excluded values
   *   ontoggle  (key, value) => void           check / uncheck (or un-exclude) a value
   *   ononly    (key, value | null) => void    select just this value; null clears the field
   *   loading   first load in flight (shows placeholders)
   *   onhide    () => void                     collapse the sidebar
   */
  import { Search, Check, Minus, ChevronDown, PanelLeftClose } from 'lucide-svelte';
  import { lv, sameValue, shown } from './LogLevel.svelte';

  let {
    facets = {},
    filters = {},
    negated = {},
    loading = false,
    ontoggle,
    ononly,
    onhide,
  } = $props();

  const FACETS = [
    ['level', 'Level'],
    ['component', 'Component'],
    ['source', 'Source'],
    ['command', 'Command'],
    ['worker', 'Worker'],
  ];
  const TOP = 5;

  let q = $state('');
  let expanded = $state({});
  let closed = $state({});

  const has = (bag, key, v) => (bag[key] || []).some(x => sameValue(key, x, v));
  const groups = $derived(
    FACETS.map(([key, label]) => {
      const all = facets[key] || [];
      const needle = q.trim().toLowerCase();
      const byName = !needle || label.toLowerCase().includes(needle);
      const list = byName ? all : all.filter(f => String(f.value).toLowerCase().includes(needle));
      return { key, label, all, list, max: Math.max(1, ...all.map(f => f.count)) };
    }).filter(g => g.list.length)
  );
  const shownCount = $derived(groups.length);
</script>

<aside class="facets" aria-label="filters">
  <div class="head">
    <b>Filters</b>
    <button class="icon-btn sm" onclick={onhide} title="hide filters" aria-label="hide filters"
      ><PanelLeftClose size={15} /></button
    >
  </div>
  <label class="searchbox fsearch">
    <Search size={13} />
    <input bind:value={q} placeholder="Search facets" aria-label="search facets" />
  </label>
  {#if q}
    <div class="meta">Showing {shownCount} of {FACETS.length} fields</div>
  {/if}

  <div class="list">
    {#each groups as g (g.key)}
      {@const sel = (filters[g.key] || []).length + (negated[g.key] || []).length}
      {@const more = expanded[g.key] || q}
      <section class="facet">
        <div class="fh">
          <button
            class="fht"
            onclick={() => (closed[g.key] = !closed[g.key])}
            aria-expanded={!closed[g.key]}
          >
            <span class="chev" class:shut={closed[g.key]}><ChevronDown size={13} /></span>
            {g.label}
            {#if sel}<span class="n tnum">{sel}</span>{/if}
          </button>
          {#if sel}
            <button class="clear" onclick={() => ononly?.(g.key, null)}>clear</button>
          {/if}
        </div>
        {#if !closed[g.key]}
          {#each more ? g.list : g.list.slice(0, TOP) as f (f.value)}
            {@const on = has(filters, g.key, f.value)}
            {@const neg = has(negated, g.key, f.value)}
            {@const sole = on && (filters[g.key] || []).length === 1}
            {@const color = g.key === 'level' ? lv(f.value).color : 'var(--text-muted)'}
            <div
              class="fv"
              class:on
              class:neg
              style="--p:{(f.count / g.max) * 100}%;--fc:{color}"
              title="{shown(g.key, f.value)} · {f.count.toLocaleString()} lines"
            >
              <button
                class="main"
                onclick={() => ontoggle?.(g.key, f.value)}
                aria-pressed={on}
                aria-label="{neg ? 'stop excluding' : on ? 'remove' : 'add'} {g.key} {f.value}"
              >
                <span class="box" class:on class:neg>
                  {#if on}<Check size={10} strokeWidth={3} />{:else if neg}<Minus
                      size={10}
                      strokeWidth={3}
                    />{/if}
                </span>
                {#if g.key === 'level'}<i class="ldot" style="background:{color}"></i>{/if}
                <span class="fname">{shown(g.key, f.value)}</span>
              </button>
              <button
                class="only"
                onclick={() => ononly?.(g.key, sole ? null : f.value)}
                title={sole ? 'show every value' : 'show only this value'}
                >{sole ? 'all' : 'only'}</button
              >
              <span class="fcount tnum">{f.count.toLocaleString()}</span>
            </div>
          {/each}
          {#if !q && g.list.length > TOP}
            <button class="more" onclick={() => (expanded[g.key] = !expanded[g.key])}>
              {expanded[g.key] ? 'Show less' : `Show more (${g.list.length - TOP})`}
            </button>
          {/if}
        {/if}
      </section>
    {:else}
      {#if loading && !q}
        {#each [4, 5, 5] as n, gi (gi)}
          <div class="skel-group" aria-hidden="true">
            <span class="skeleton" style="width:72px"></span>
            {#each Array(n) as _, i (i)}
              <span class="skeleton" style="width:{55 + ((i * 23 + gi * 11) % 40)}%"></span>
            {/each}
          </div>
        {/each}
      {:else}
        <p class="note">
          {q
            ? `No field or value matches “${q}”.`
            : 'Values show up here once lines exist in this time range.'}
        </p>
      {/if}
    {/each}
    {#if !q && !facets.source?.length && groups.length}
      <p class="note">
        Source, command and worker fill in as lines are written with request context.
      </p>
    {/if}
  </div>
</aside>

<style>
  .facets {
    width: 256px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--line);
    min-height: 0;
  }
  .head {
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 8px 0 16px;
  }
  .head b {
    font-size: var(--fs);
    font-weight: 600;
    color: var(--text-bright);
  }
  .fsearch {
    margin: 0 12px;
    height: 30px;
    box-shadow: none;
  }
  .fsearch input {
    font-size: var(--fs-sm);
  }
  .meta {
    padding: 6px 16px 0;
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 8px 16px;
  }
  .facet {
    padding-top: 6px;
  }
  .fh {
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
  }
  .fh:hover {
    background: var(--row-hover);
  }
  .fht {
    flex: 1;
    min-width: 0;
    height: 30px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px 0 4px;
    border: 0;
    background: none;
    color: var(--text);
    font-size: var(--fs-sm);
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }
  .chev {
    display: inline-flex;
    color: var(--text-dim);
    transition: transform 0.12s;
  }
  .chev.shut {
    transform: rotate(-90deg);
  }
  .fh .n {
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 8px;
    display: inline-grid;
    place-items: center;
    background: var(--accent-bg-strong);
    color: var(--accent);
    font: 600 10px var(--mono);
  }
  .clear {
    margin-right: 6px;
    padding: 2px 4px;
    border: 0;
    background: none;
    font-size: var(--fs-xs);
    font-weight: 500;
    color: var(--accent);
    cursor: pointer;
  }
  .clear:hover {
    text-decoration: underline;
  }

  .fv {
    position: relative;
    height: 26px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    border-radius: var(--radius-sm);
    background: linear-gradient(
      to right,
      color-mix(in srgb, var(--fc) 12%, transparent) var(--p),
      transparent var(--p)
    );
    margin-bottom: 2px;
  }
  .fv:hover {
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .main {
    height: 100%;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 6px 0 8px;
    border: 0;
    background: none;
    color: var(--text);
    font: var(--fs-sm) var(--mono);
    text-align: left;
    cursor: pointer;
  }
  .box {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    border: 1px solid var(--border-2);
    border-radius: 3px;
    background: var(--card);
    color: var(--on-accent);
  }
  .box.on {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .box.neg {
    background: var(--card);
    color: var(--danger-text);
  }
  .ldot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .fname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fv.on .fname {
    color: var(--text-bright);
    font-weight: 500;
  }
  .fv.neg .fname {
    color: var(--text-muted);
    text-decoration: line-through;
  }
  .only {
    height: 20px;
    padding: 0 6px;
    border: 1px solid var(--border-2);
    border-radius: 4px;
    background: var(--card);
    color: var(--text-muted);
    font-size: var(--fs-xs);
    font-weight: 500;
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
  }
  .fv:hover .only,
  .only:focus-visible {
    opacity: 1;
    pointer-events: auto;
  }
  .only:hover {
    color: var(--text-bright);
    border-color: var(--text-dim);
  }
  .fcount {
    padding: 0 8px 0 6px;
    min-width: 36px;
    text-align: right;
    font: var(--fs-xs) var(--mono);
    color: var(--text-muted);
  }
  .more {
    margin: 2px 0 4px 30px;
    padding: 2px 0;
    border: 0;
    background: none;
    color: var(--accent);
    font-size: var(--fs-sm);
    font-weight: 500;
    cursor: pointer;
  }
  .more:hover {
    text-decoration: underline;
  }
  .skel-group {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 8px 6px;
  }
  .skel-group .skeleton {
    height: 10px;
    display: block;
  }
  .note {
    margin: 12px 8px;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text-muted);
  }
</style>
