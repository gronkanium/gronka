<script>
  import { onMount } from 'svelte';
  import { Search } from 'lucide-svelte';

  // Order + display names for the category sections. Anything the server sends in an
  // unknown category still renders under a generic "other" heading (see extraCategories).
  const CATEGORY_ORDER = [
    { id: 'social', label: 'social' },
    { id: 'video', label: 'video' },
    { id: 'adult', label: 'adult' },
    { id: 'booru', label: 'booru' },
  ];

  let catalog = []; // [{ id, label, category }]
  let disabled = new Set(); // ids that are turned off
  let loading = true;
  let error = null;
  let saving = false;
  let search = '';

  onMount(load);

  async function load() {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { settings } = await res.json();
      const svc = settings.disabled_services || {};
      catalog = svc.catalog || [];
      disabled = new Set(parseIds(svc.value));
    } catch (err) {
      error = err.message || 'failed to load sources';
    } finally {
      loading = false;
    }
  }

  function parseIds(value) {
    try {
      const arr = JSON.parse(value || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  // Persist the current disabled set. Optimistic: the caller has already mutated `disabled`,
  // so on failure we reload from the server to resync.
  async function persist() {
    saving = true;
    error = null;
    try {
      const res = await fetch('/api/settings/disabled_services', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: [...disabled] }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `HTTP ${res.status}`);
      }
      const data = await res.json();
      disabled = new Set(parseIds(data.value));
    } catch (err) {
      error = err.message || 'failed to save';
      await load(); // resync so the UI reflects what's actually stored
    } finally {
      saving = false;
    }
  }

  function toggle(id) {
    if (saving) return;
    const next = new Set(disabled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    disabled = next;
    persist();
  }

  function setCategory(ids, off) {
    if (saving) return;
    const next = new Set(disabled);
    for (const id of ids) {
      if (off) next.add(id);
      else next.delete(id);
    }
    disabled = next;
    persist();
  }

  function setAll(off) {
    if (saving) return;
    disabled = off ? new Set(catalog.map(s => s.id)) : new Set();
    persist();
  }

  // Categories present in the catalog, in preferred order, plus any unknown ones after.
  $: presentCategories = [
    ...CATEGORY_ORDER.filter(c => catalog.some(s => s.category === c.id)),
    ...[...new Set(catalog.map(s => s.category))]
      .filter(c => !CATEGORY_ORDER.some(o => o.id === c))
      .map(c => ({ id: c, label: c })),
  ];

  $: query = search.trim().toLowerCase();
  function matches(svc) {
    return !query || svc.label.toLowerCase().includes(query);
  }
  function inCategory(catId) {
    return catalog.filter(s => s.category === catId && matches(s));
  }

  $: totalOn = catalog.length - disabled.size;
</script>

<div class="sources">
  {#if loading}
    <p class="status">loading sources…</p>
  {:else if error && catalog.length === 0}
    <p class="status error">{error}</p>
  {:else}
    <div class="intro">
      <p class="lede">
        Turn download sources on or off. A turned-off source refuses <code>/download</code> with a short
        message instead of downloading.
      </p>
      <div class="toolbar">
        <div class="search">
          <Search size={16} />
          <input
            type="text"
            placeholder="filter sources"
            bind:value={search}
            aria-label="filter sources"
          />
        </div>
        <div class="summary">
          <span class="on-count">{totalOn}</span><span class="dim">/{catalog.length} on</span>
        </div>
        <div class="bulk">
          <button class="link-btn" disabled={saving} on:click={() => setAll(false)}>all on</button>
          <span class="dim">·</span>
          <button class="link-btn" disabled={saving} on:click={() => setAll(true)}>all off</button>
        </div>
      </div>
      {#if error}<p class="status error inline">{error}</p>{/if}
    </div>

    <div class="cat-grid">
      {#each presentCategories as cat (cat.id)}
        {@const rows = inCategory(cat.id)}
        {@const all = catalog.filter(s => s.category === cat.id)}
        {@const onCount = all.filter(s => !disabled.has(s.id)).length}
        {#if rows.length > 0}
          <section class="cat-card">
            <header class="cat-head">
              <h3>{cat.label}</h3>
              <span class="cat-count">{onCount}/{all.length}</span>
              <div class="cat-actions">
                <button
                  class="link-btn"
                  disabled={saving}
                  on:click={() =>
                    setCategory(
                      all.map(s => s.id),
                      false
                    )}>on</button
                >
                <span class="dim">·</span>
                <button
                  class="link-btn"
                  disabled={saving}
                  on:click={() =>
                    setCategory(
                      all.map(s => s.id),
                      true
                    )}>off</button
                >
              </div>
            </header>
            <div class="tiles">
              {#each rows as svc (svc.id)}
                <button
                  class="tile"
                  class:off={disabled.has(svc.id)}
                  disabled={saving}
                  on:click={() => toggle(svc.id)}
                  aria-pressed={!disabled.has(svc.id)}
                  title={disabled.has(svc.id) ? `${svc.label} is off` : `${svc.label} is on`}
                >
                  <span class="tile-name">{svc.label}</span>
                  <span class="switch" aria-hidden="true"><span class="knob"></span></span>
                </button>
              {/each}
            </div>
          </section>
        {/if}
      {/each}
    </div>

    {#if query && !presentCategories.some(c => inCategory(c.id).length > 0)}
      <p class="status">no sources match “{search}”.</p>
    {/if}
  {/if}
</div>

<style>
  .sources {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    max-width: 1000px;
  }

  .status {
    color: var(--text-muted);
    margin: 0;
  }
  .status.error {
    color: var(--danger);
  }
  .status.inline {
    margin-top: 0.5rem;
    font-size: 0.85rem;
  }

  .lede {
    margin: 0 0 0.85rem;
    color: var(--text-muted);
    font-size: 0.9rem;
    line-height: 1.5;
    max-width: 60ch;
  }
  .lede code {
    background: var(--surface-2);
    padding: 0.05rem 0.3rem;
    border-radius: var(--radius);
    font-size: 0.85em;
  }

  /* toolbar: search · count · bulk */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text-muted);
    flex: 1 1 220px;
    min-width: 180px;
  }
  .search input {
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 0.9rem;
    width: 100%;
    outline: none;
  }
  .summary {
    font-size: 0.9rem;
    white-space: nowrap;
  }
  .on-count {
    color: var(--success);
    font-weight: 600;
  }
  .dim {
    color: var(--text-dim);
  }
  .bulk {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
  }
  .link-btn {
    background: none;
    border: none;
    color: var(--info);
    cursor: pointer;
    font-size: 0.85rem;
    padding: 0;
  }
  .link-btn:hover:not(:disabled) {
    text-decoration: underline;
  }
  .link-btn:disabled {
    color: var(--text-dim);
    cursor: wait;
  }

  /* responsive grid of category cards */
  .cat-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
    align-items: start;
  }
  @media (max-width: 767px) {
    .cat-grid {
      grid-template-columns: 1fr;
    }
  }

  .cat-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    padding: 0.85rem 0.95rem 1rem;
  }
  .cat-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.75rem;
  }
  .cat-head h3 {
    margin: 0;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .cat-count {
    font-size: 0.75rem;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .cat-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  /* tiles: one per source, whole tile is the toggle */
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 0.5rem;
  }
  .tile {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
    text-align: left;
    transition:
      border-color 0.15s,
      opacity 0.15s,
      background-color 0.15s;
  }
  .tile:hover:not(:disabled) {
    border-color: var(--border-2);
  }
  .tile:disabled {
    cursor: wait;
  }
  .tile.off {
    opacity: 0.55;
  }
  .tile-name {
    font-size: 0.88rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* faux toggle switch (decorative — the tile button owns the interaction) */
  .switch {
    position: relative;
    width: 30px;
    height: 17px;
    flex-shrink: 0;
    border-radius: 9px;
    background: var(--success);
    transition: background-color 0.15s;
  }
  .tile.off .switch {
    background: var(--surface-3);
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: var(--bg-deep);
    transition: transform 0.15s;
  }
  .switch .knob {
    transform: translateX(13px);
  }
  .tile.off .switch .knob {
    transform: translateX(0);
    background: var(--text-dim);
  }
</style>
