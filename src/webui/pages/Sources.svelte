<script>
  import { getJsonOrNull, sendJson } from '../utils/api.js';
  import { Search, Globe } from 'lucide-svelte';
  import PageHeader from '../components/PageHeader.svelte';

  // Order + display names for the category sections; unknown categories render after these.
  const CATEGORY_ORDER = [
    { id: 'social', label: 'Social' },
    { id: 'video', label: 'Video' },
    { id: 'adult', label: 'Adult' },
    { id: 'booru', label: 'Booru' },
  ];

  let catalog = $state([]);
  let disabled = $state(new Set());
  let loading = $state(true);
  let error = $state('');
  let saving = $state(false);
  let search = $state('');
  let toast = $state('');
  let toastTimer;
  let usage = $state({});

  getJsonOrNull('/api/sources/usage').then(d => (usage = d?.usage ?? {}));

  const parseIds = value => {
    try {
      const arr = JSON.parse(value || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };

  async function load() {
    loading = true;
    error = '';
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const svc = (await res.json()).settings.disabled_services || {};
      catalog = svc.catalog || [];
      disabled = new Set(parseIds(svc.value));
    } catch (err) {
      error = err.message || 'failed to load sources';
    } finally {
      loading = false;
    }
  }
  load();

  function say(text) {
    toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), 2000);
  }

  // Optimistic: the caller already changed `disabled`; a failure reloads what's actually stored.
  async function persist(next, what) {
    if (saving) return;
    disabled = next;
    saving = true;
    error = '';
    try {
      const res = await sendJson('/api/settings/disabled_services', 'PUT', { value: [...next] });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      disabled = new Set(parseIds(data.value));
      say(what ?? 'Saved');
    } catch (err) {
      error = err.message || 'failed to save';
      await load();
    } finally {
      saving = false;
    }
  }

  function toggle(s) {
    const next = new Set(disabled);
    const off = !next.has(s.id);
    off ? next.add(s.id) : next.delete(s.id);
    persist(next, `${s.label} turned ${off ? 'off' : 'on'}`);
  }
  function setMany(ids, off, what) {
    const next = new Set(disabled);
    for (const id of ids) off ? next.add(id) : next.delete(id);
    persist(next, what);
  }
  function allOff() {
    if (!confirm(`Turn off all ${catalog.length} sources? Every /download link will be refused.`))
      return;
    setMany(
      catalog.map(s => s.id),
      true,
      'All sources turned off'
    );
  }

  const query = $derived(search.trim().toLowerCase());
  const categories = $derived(
    [
      ...CATEGORY_ORDER.filter(c => catalog.some(s => s.category === c.id)),
      ...[...new Set(catalog.map(s => s.category))]
        .filter(c => !CATEGORY_ORDER.some(o => o.id === c))
        .map(c => ({ id: c, label: c })),
    ].map(c => {
      const all = catalog.filter(s => s.category === c.id);
      return {
        ...c,
        all,
        shown: all.filter(
          s => !query || s.label.toLowerCase().includes(query) || s.id.includes(query)
        ),
        on: all.filter(s => !disabled.has(s.id)).length,
      };
    })
  );
  const totalOn = $derived(catalog.length - disabled.size);
  const maxUse = $derived(Math.max(1, ...Object.values(usage).map(u => u.n)));
</script>

<PageHeader title="Sources" description="Sites the bot will download from">
  {#snippet actions()}
    <span class="pill" class:ok={totalOn === catalog.length} class:warn={totalOn < catalog.length}
      >{saving ? 'Saving…' : `${totalOn} of ${catalog.length} on`}</span
    >
    <button
      class="btn"
      disabled={saving || !disabled.size}
      onclick={() =>
        setMany(
          catalog.map(s => s.id),
          false,
          'All sources turned on'
        )}>Turn all on</button
    >
    <button
      class="btn danger"
      disabled={saving || disabled.size === catalog.length}
      onclick={allOff}>Turn all off</button
    >
  {/snippet}
</PageHeader>

<div class="sources stack">
  {#if error}<div class="flash error">{error}</div>{/if}

  <section class="panel" aria-label="download sources">
    <div class="ph">
      <span class="nowrap">Download sources</span>
      <span class="sub">a turned-off source refuses /download with a message</span>
      <span class="meta">
        <label class="searchbox find">
          <Search size={14} />
          <input bind:value={search} placeholder="Find a source" aria-label="find a source" />
        </label>
      </span>
    </div>
    {#if loading && !catalog.length}
      <div class="skel-rows">
        {#each Array(8) as _, i (i)}<span class="skeleton" style="width:{70 - (i % 3) * 12}%"
          ></span>{/each}
      </div>
    {:else if !categories.some(c => c.shown.length)}
      <div class="empty">
        <span class="ic"><Globe size={20} /></span>
        <b>No source matches</b>Try another name
      </div>
    {/if}
    {#each categories as c (c.id)}
      {#if c.shown.length}
        <div class="group">
          <span class="section-label">{c.label}</span>
          <span class="dim small tnum">{c.on}/{c.all.length} on</span>
          <span class="right row">
            <button
              class="linkish small"
              disabled={saving || c.on === c.all.length}
              onclick={() =>
                setMany(
                  c.all.map(s => s.id),
                  false,
                  `${c.label} sources turned on`
                )}>All on</button
            >
            <span class="dim">·</span>
            <button
              class="linkish small"
              disabled={saving || c.on === 0}
              onclick={() =>
                setMany(
                  c.all.map(s => s.id),
                  true,
                  `${c.label} sources turned off`
                )}>All off</button
            >
          </span>
        </div>
        <div class="tiles">
          {#each c.shown as s (s.id)}
            {@const on = !disabled.has(s.id)}
            {@const u = usage[s.id]}
            {@const rate = u ? Math.round((u.ok / u.n) * 100) : null}
            <button
              class="tile"
              class:off={!on}
              role="switch"
              aria-checked={on}
              aria-label={`${s.label} ${on ? 'on' : 'off'}`}
              title={s.id}
              disabled={saving}
              onclick={() => toggle(s)}
            >
              <span class="top">
                <span class="name">{s.label.replace(' (gallery-dl)', '')}</span>
                <span class="toggle sm" class:on aria-hidden="true"></span>
              </span>
              <span class="use">
                {#if !on}
                  <span>Off</span>
                {:else if u}
                  <span class="tnum"><b>{u.n}</b> in 7d</span>
                  <span class="tnum" class:low={rate < 80}>{rate}% ok</span>
                {:else}
                  <span>No requests in 7d</span>
                {/if}
              </span>
              <span class="bar"><span style:width={`${((u?.n ?? 0) / maxUse) * 100}%`}></span></span
              >
            </button>
          {/each}
        </div>
      {/if}
    {/each}
  </section>
</div>

{#if toast}<div class="toast" role="status">{toast}</div>{/if}

<style>
  .sources {
    max-width: 1100px;
  }
  .find {
    width: 220px;
    max-width: 100%;
  }
  .find input {
    min-width: 0;
    width: 100%;
    height: 28px;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px 6px;
    border-top: 1px solid var(--line);
  }
  .group:first-of-type {
    border-top: 0;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(140px, 100%), 1fr));
    gap: 8px;
    padding: 4px 16px 16px;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px 0;
    border: 1px solid var(--border-2);
    border-radius: var(--radius);
    background: var(--card);
    font: inherit;
    text-align: left;
    color: var(--text);
    cursor: pointer;
    overflow: hidden;
    transition:
      border-color 0.12s,
      background 0.12s;
  }
  .tile:hover:not(:disabled) {
    border-color: var(--text-dim);
    background: var(--card-2);
  }
  .tile:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .name {
    font-weight: 600;
    color: var(--text-bright);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .toggle.sm {
    display: block;
    pointer-events: none;
    transform: scale(0.8);
    transform-origin: right center;
  }
  .use {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .use b {
    color: var(--text-soft);
    font-weight: 600;
  }
  .use .low {
    color: var(--warning-text);
    font-weight: 600;
  }
  .bar {
    height: 3px;
    margin: 0 -12px;
    background: var(--line);
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .tile.off {
    background: none;
    border-style: dashed;
  }
  .tile.off .name {
    color: var(--text-muted);
    font-weight: 500;
  }
  .tile.off .bar span {
    background: var(--text-dim);
  }
  .linkish.small {
    font-size: var(--fs-sm);
  }
  .nowrap {
    white-space: nowrap;
  }
  .ph .sub {
    display: none;
  }
  @media (min-width: 640px) {
    .tiles {
      grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    }
  }
  @media (min-width: 1000px) {
    .ph .sub {
      display: inline;
      font-size: var(--fs-sm);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
  }
</style>
