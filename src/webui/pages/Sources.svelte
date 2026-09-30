<script>
  import { onDestroy } from 'svelte';
  import { Search } from 'lucide-svelte';
  import { headerActions } from '../stores/header.js';

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

  // Optimistic: the caller already changed `disabled`; a failure reloads what's actually stored.
  async function persist(next) {
    if (saving) return;
    disabled = next;
    saving = true;
    error = '';
    try {
      const res = await fetch('/api/settings/disabled_services', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: [...next] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      disabled = new Set(parseIds(data.value));
    } catch (err) {
      error = err.message || 'failed to save';
      await load();
    } finally {
      saving = false;
    }
  }

  function toggle(id) {
    const next = new Set(disabled);
    next.has(id) ? next.delete(id) : next.add(id);
    persist(next);
  }
  function setMany(ids, off) {
    const next = new Set(disabled);
    for (const id of ids) off ? next.add(id) : next.delete(id);
    persist(next);
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

  headerActions.set(actions);
  onDestroy(() => headerActions.set(null));
</script>

{#snippet actions()}
  <span class="dim small">{saving ? 'saving…' : `${totalOn} of ${catalog.length} on`}</span>
  <button class="btn" disabled={saving || !disabled.size} onclick={() => persist(new Set())}
    >Turn all on</button
  >
  <button
    class="btn danger"
    disabled={saving || disabled.size === catalog.length}
    onclick={() => persist(new Set(catalog.map(s => s.id)))}>Turn all off</button
  >
{/snippet}

<div class="sources stack">
  <div class="intro">
    <p class="muted">
      A turned-off source refuses <span class="mono">/download</span> with a message instead of downloading.
      The bot picks changes up within a minute.
    </p>
    <label class="searchbox">
      <Search size={14} />
      <input bind:value={search} placeholder="find a source" aria-label="find a source" />
    </label>
  </div>

  {#if error}<div class="panel pb error-text">{error}</div>{/if}
  {#if loading && !catalog.length}<div class="panel empty">loading…</div>{/if}

  <div class="grid">
    {#each categories as c (c.id)}
      {#if c.shown.length}
        <section class="panel" aria-label={c.label}>
          <div class="ph">
            <span>{c.label}</span>
            <span class="meta">
              <span class="mono">{c.on}/{c.all.length} on</span>
              <button
                class="linkish"
                disabled={saving}
                onclick={() =>
                  setMany(
                    c.all.map(s => s.id),
                    false
                  )}>all on</button
              >
              <button
                class="linkish"
                disabled={saving}
                onclick={() =>
                  setMany(
                    c.all.map(s => s.id),
                    true
                  )}>all off</button
              >
            </span>
          </div>
          {#each c.shown as s (s.id)}
            {@const on = !disabled.has(s.id)}
            <div class="src" class:off={!on}>
              <button
                class="toggle"
                class:on
                role="switch"
                aria-checked={on}
                aria-label={`${s.label} ${on ? 'on' : 'off'}`}
                disabled={saving}
                onclick={() => toggle(s.id)}
              ></button>
              <span class="grow">{s.label}</span>
              <span class="mono dim small">{s.id}</span>
            </div>
          {/each}
        </section>
      {/if}
    {/each}
  </div>
</div>

<style>
  .sources {
    max-width: 1400px;
    margin: 0 auto;
  }
  .small {
    font-size: 12px;
  }
  .intro {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  .intro p {
    margin: 0;
    flex: 1;
    min-width: 260px;
    font-size: 13px;
  }
  .searchbox {
    height: 34px;
    width: 280px;
    padding: 0 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-muted);
  }
  .searchbox:focus-within {
    border-color: var(--border-2);
  }
  .searchbox input {
    flex: 1;
    background: none;
    border: 0;
    outline: 0;
    color: var(--text-bright);
    font: inherit;
    font-size: 13px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 16px;
    align-items: start;
  }
  .linkish {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .linkish:disabled {
    opacity: 0.5;
  }
  .src {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 16px;
    border-top: 1px solid var(--line);
    font-size: 13px;
  }
  .src:first-of-type {
    border-top: 0;
  }
  .src.off .grow {
    color: var(--text-dim);
  }
</style>
