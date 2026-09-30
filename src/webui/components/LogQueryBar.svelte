<script>
  /**
   * Logs query bar: `key:value` chips, `-key:value` exclusions, free text, and an autocomplete of
   * fields and their top values. It holds no filter state of its own: every change is emitted as
   * the whole next query and the page writes it to the URL.
   *
   *   filters   { key: [values] }            positive filters
   *   negated   { key: [values] }            exclusions (applied client-side by the page)
   *   search    free-text search
   *   values    { key: [{ value, count }] }  suggestions per field, most frequent first
   *   onchange  ({ filters, negated, search }) => void
   */
  import { tick } from 'svelte';
  import { Search, X } from 'lucide-svelte';
  import { FIELDS, FIELD_HINTS, lv, sameValue, shown } from './LogLevel.svelte';

  let { filters = {}, negated = {}, search = '', values = {}, onchange } = $props();

  let draft = $state('');
  let editing = $state(null); // the chip being edited as text
  let armed = $state(-1); // chip index selected by Backspace
  let open = $state(false);
  let focused = $state(false);
  let hi = $state(-1);
  let input = $state();
  let menu = $state();

  const chipId = c => (c.text != null ? 'search' : `${c.neg ? '-' : '+'}${c.key}:${c.value}`);
  const allChips = $derived([
    ...Object.entries(filters).flatMap(([key, vs]) =>
      vs.map(value => ({ key, value, neg: false }))
    ),
    ...Object.entries(negated).flatMap(([key, vs]) => vs.map(value => ({ key, value, neg: true }))),
    ...(search ? [{ text: search }] : []),
  ]);
  const chips = $derived(allChips.filter(c => !editing || chipId(c) !== chipId(editing)));

  // One token: `key:value`, `-key:value`, `key:"two words"`.
  function term(tok) {
    const m = tok.match(/^(-?)([a-z]+):(.+)$/i);
    if (!m || !FIELDS.includes(m[2].toLowerCase())) return null;
    const value = m[3].replace(/^"(.*)"?$/, '$1').replace(/"$/, '');
    return value ? { neg: m[1] === '-', key: m[2].toLowerCase(), value } : null;
  }
  const tokens = text => text.match(/-?\w+:"[^"]*"?|"[^"]*"?|\S+/g) ?? [];

  function snapshot() {
    const copy = bag => Object.fromEntries(Object.entries(bag).map(([k, v]) => [k, [...v]]));
    return { filters: copy(filters), negated: copy(negated), search };
  }
  function drop(state, chip) {
    if (!chip) return;
    if (chip.text != null) return void (state.search = '');
    const bag = chip.neg ? state.negated : state.filters;
    bag[chip.key] = (bag[chip.key] || []).filter(v => v !== chip.value);
  }
  function add(state, { neg, key, value }) {
    const v = key === 'level' ? value.toUpperCase() : value;
    const [to, from] = neg ? [state.negated, state.filters] : [state.filters, state.negated];
    from[key] = (from[key] || []).filter(x => !sameValue(key, x, v));
    if (!(to[key] || []).some(x => sameValue(key, x, v))) to[key] = [...(to[key] || []), v];
  }
  function emit(state) {
    const clean = bag => Object.fromEntries(Object.entries(bag).filter(([, v]) => v.length));
    const next = {
      filters: clean(state.filters),
      negated: clean(state.negated),
      search: state.search,
    };
    const now = { filters: clean(filters), negated: clean(negated), search };
    if (JSON.stringify(next) !== JSON.stringify(now)) onchange?.(next);
  }

  // Enter commits everything; blur and space only turn finished `key:value` tokens into chips.
  function commit({ fieldsOnly = false } = {}) {
    const state = snapshot();
    drop(state, editing);
    const rest = [];
    for (const tok of tokens(draft)) {
      const t = term(tok);
      if (t) add(state, t);
      else rest.push(tok.replace(/^"|"$/g, ''));
    }
    if (!fieldsOnly && rest.length) state.search = rest.join(' ');
    emit(state);
    draft = fieldsOnly ? rest.join(' ') : '';
    editing = null;
    armed = -1;
  }

  function remove(chip) {
    const state = snapshot();
    drop(state, chip);
    emit(state);
    armed = -1;
  }

  const chipText = c => {
    if (c.text != null) return c.text;
    const v = shown(c.key, c.value);
    return `${c.neg ? '-' : ''}${c.key}:${/\s/.test(v) ? `"${v}"` : v}`;
  };

  async function edit(chip) {
    if (editing) commit();
    editing = chip;
    draft = chipText(chip);
    armed = -1;
    open = true;
    hi = -1;
    await tick();
    input?.focus();
    input?.setSelectionRange(draft.length, draft.length);
  }

  // ---------- autocomplete ----------
  const cur = $derived(draft.match(/(\S*)$/)?.[1] ?? '');
  const head = $derived(draft.slice(0, draft.length - cur.length));
  const items = $derived.by(() => {
    const m = cur.match(/^(-?)(\w+):(.*)$/);
    if (m && FIELDS.includes(m[2].toLowerCase())) {
      const key = m[2].toLowerCase();
      const neg = m[1] === '-';
      const typed = m[3].replace(/^"|"$/g, '');
      const part = typed.toLowerCase();
      const group = `Values · ${key}`;
      const list = (values[key] || [])
        .filter(v => String(v.value).toLowerCase().includes(part))
        .slice(0, 10)
        .map(v => ({ type: 'value', group, key, neg, value: String(v.value), count: v.count }));
      if (typed && !list.some(v => sameValue(key, v.value, typed)))
        list.unshift({ type: 'value', group, key, neg, value: typed, literal: true });
      return list;
    }
    const neg = cur.startsWith('-');
    const k = cur.replace(/^-/, '').toLowerCase();
    const out = FIELDS.filter(f => f.startsWith(k)).map(key => ({
      type: 'field',
      group: 'Fields',
      key,
      neg,
      hint: FIELD_HINTS[key],
    }));
    if (draft.trim()) out.push({ type: 'search', group: 'Full text', text: draft.trim() });
    return out;
  });
  const valueMode = $derived(items[0]?.type === 'value');

  function oninput() {
    open = true;
    armed = -1;
    hi = cur || valueMode ? 0 : -1;
  }

  async function accept(item) {
    if (item.type === 'field') {
      draft = `${head}${item.neg ? '-' : ''}${item.key}:`;
      hi = 0;
      open = true;
      await tick();
      input?.focus();
      return;
    }
    if (item.type === 'search') return commit();
    const state = snapshot();
    drop(state, editing);
    add(state, item);
    emit(state);
    draft = head.trimEnd();
    editing = null;
    hi = -1;
  }

  $effect(() => {
    if (hi >= 0) menu?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  });

  function onkeydown(e) {
    const k = e.key;
    if (k !== 'Backspace' && k !== 'Shift') armed = -1;
    if (k === 'ArrowDown') {
      e.preventDefault();
      if (!open) return void (open = true);
      hi = Math.min(items.length - 1, hi + 1);
    } else if (k === 'ArrowUp') {
      e.preventDefault();
      hi = Math.max(-1, hi - 1);
    } else if (k === 'Enter') {
      e.preventDefault();
      if (open && items[hi]) accept(items[hi]);
      else commit();
    } else if (k === 'Tab') {
      if (open && items[hi]) {
        e.preventDefault();
        accept(items[hi]);
      }
    } else if (k === 'Escape') {
      if (open) open = false;
      else if (editing) {
        editing = null;
        draft = '';
      } else input?.blur();
    } else if (k === 'Backspace' && !draft && chips.length) {
      e.preventDefault();
      if (armed >= 0) remove(chips[armed]);
      else armed = chips.length - 1;
    } else if (k === ' ' && term(cur) && input.selectionStart === draft.length) {
      e.preventDefault();
      commit({ fieldsOnly: true });
      if (draft) draft += ' ';
    }
  }

  function onblur() {
    focused = false;
    open = false;
    armed = -1;
    if (editing) commit();
    else if (tokens(draft).some(term)) commit({ fieldsOnly: true });
  }

  function onglobalkey(e) {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
    input?.focus();
  }
  const keep = e => e.preventDefault(); // keeps focus in the input while clicking chips / menu
</script>

<svelte:window onkeydown={onglobalkey} />

<div class="qwrap">
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <div class="qbar" role="search" onclick={e => e.target === e.currentTarget && input?.focus()}>
    <Search size={15} />
    {#each chips as c, i (chipId(c))}
      <span
        class="tok"
        class:neg={c.neg}
        class:text={c.text != null}
        class:armed={armed === i}
        title={c.neg
          ? 'excluded client-side: the API only filters positive matches'
          : c.text != null
            ? 'full-text search'
            : 'click to edit'}
      >
        <button class="body" onmousedown={keep} onclick={() => edit(c)}>
          {#if c.text != null}
            <span class="v">"{c.text}"</span>
          {:else}
            {#if c.neg}<span class="minus">−</span>{/if}
            {#if c.key === 'level'}<i class="ldot" style="background:{lv(c.value).color}"></i>{/if}
            <span class="k">{c.key}:</span><span class="v">{shown(c.key, c.value)}</span>
          {/if}
        </button>
        <button
          class="x"
          onmousedown={keep}
          onclick={() => remove(c)}
          aria-label="remove {chipText(c)}"><X size={11} /></button
        >
      </span>
    {/each}
    <input
      bind:this={input}
      bind:value={draft}
      {oninput}
      {onkeydown}
      {onblur}
      onfocus={() => {
        focused = true;
        open = true;
      }}
      placeholder={chips.length ? '' : 'Search messages, or filter with field:value'}
      aria-label="filter logs"
      aria-expanded={open}
      aria-controls="log-q-menu"
      aria-autocomplete="list"
      role="combobox"
      spellcheck="false"
      autocomplete="off"
    />
    {#if !focused && !draft && !chips.length}<kbd class="slash" title="press / to search">/</kbd
      >{/if}
  </div>

  {#if open}
    <div
      class="menu pop"
      id="log-q-menu"
      bind:this={menu}
      onmousedown={keep}
      role="listbox"
      tabindex="-1"
    >
      <div class="scroll">
        {#each items as it, i (i)}
          {#if i === 0 || items[i - 1].group !== it.group}
            <div class="gh">{it.group}</div>
          {/if}
          <button
            class="it"
            class:hi={hi === i}
            data-i={i}
            role="option"
            aria-selected={hi === i}
            onmouseenter={() => (hi = i)}
            onclick={() => accept(it)}
          >
            {#if it.type === 'field'}
              <span class="mono"
                >{#if it.neg}<span class="minus">−</span>{/if}{it.key}:</span
              >
              <span class="hint">{it.hint}</span>
            {:else if it.type === 'value'}
              <span class="mono ellipsis">
                {#if it.neg}<span class="minus">−</span>{/if}
                {#if it.key === 'level'}<i class="ldot" style="background:{lv(it.value).color}"
                  ></i>{/if}
                {shown(it.key, it.value)}
              </span>
              {#if it.literal}<span class="hint">use as typed</span>
              {:else}<span class="count tnum">{it.count.toLocaleString()}</span>{/if}
            {:else}
              <Search size={13} />
              <span class="ellipsis">Search messages for <b>“{it.text}”</b></span>
            {/if}
          </button>
        {:else}
          <div class="none">No known values. Press Enter to use what you typed.</div>
        {/each}
      </div>
      <div class="foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>↵</kbd> select</span>
        <span><kbd>esc</kbd> close</span>
        <span class="right"><span class="mono">-key:value</span> excludes</span>
      </div>
    </div>
  {/if}
</div>

<style>
  .qwrap {
    position: relative;
    flex: 1;
    min-width: 240px;
  }
  .qbar {
    min-height: 34px;
    cursor: text;
  }
  .qbar input {
    min-width: 90px;
    font-size: var(--fs-sm);
  }
  .slash {
    margin-left: auto;
  }

  .tok {
    height: 24px;
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border-2);
    border-radius: 4px;
    background: var(--card-2);
    font: var(--fs-sm) var(--mono);
    white-space: nowrap;
    max-width: 280px;
    overflow: hidden;
  }
  .tok .body {
    height: 100%;
    display: inline-flex;
    align-items: center;
    gap: 1px;
    padding: 0 2px 0 7px;
    border: 0;
    background: none;
    font: inherit;
    min-width: 0;
    cursor: text;
  }
  .tok .k {
    color: var(--text-muted);
  }
  .tok .v {
    color: var(--text-bright);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tok .x {
    height: 100%;
    width: 20px;
    display: inline-grid;
    place-items: center;
    border: 0;
    background: none;
    color: var(--text-dim);
    padding: 0;
    flex-shrink: 0;
  }
  .tok .x:hover {
    color: var(--text-bright);
  }
  .tok.neg {
    border-color: var(--danger-border);
    background: var(--danger-bg-subtle);
  }
  .minus {
    color: var(--danger-text);
    font-weight: 700;
    margin-right: 3px;
  }
  .tok.text .v {
    color: var(--text);
  }
  .tok.armed {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-bg-strong);
  }
  .ldot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
    margin-right: 5px;
    flex-shrink: 0;
  }

  .menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 80;
    width: min(100%, 520px);
    min-width: 280px;
    display: flex;
    flex-direction: column;
    max-height: 320px;
    overflow: hidden;
  }
  .scroll {
    overflow-y: auto;
    padding: 4px;
    flex: 1;
    min-height: 0;
  }
  .gh {
    padding: 8px 10px 4px;
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-muted);
  }
  .it {
    width: 100%;
    height: 30px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font-size: var(--fs);
    text-align: left;
    cursor: pointer;
  }
  .it.hi {
    background: var(--card-3);
    color: var(--text-bright);
  }
  .it .mono {
    font-size: var(--fs-sm);
    display: inline-flex;
    align-items: center;
    min-width: 0;
  }
  .it :global(svg) {
    color: var(--text-dim);
    flex-shrink: 0;
  }
  .it b {
    font-weight: 600;
  }
  .hint {
    margin-left: auto;
    color: var(--text-dim);
    font-size: var(--fs-sm);
    white-space: nowrap;
  }
  .count {
    margin-left: auto;
    font: var(--fs-sm) var(--mono);
    color: var(--text-muted);
  }
  .none {
    padding: 12px 10px;
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
  .foot {
    display: flex;
    gap: 12px;
    padding: 7px 12px;
    border-top: 1px solid var(--line);
    background: var(--card-2);
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
  .foot kbd {
    margin-right: 2px;
  }
  .foot .right {
    margin-left: auto;
  }
  @media (max-width: 640px) {
    .foot {
      display: none;
    }
  }
</style>
