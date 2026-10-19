<script>
  import { sendJson } from '../utils/api.js';
  import { Search, Globe, ChevronDown, ArrowUp, ArrowDown, RotateCcw } from 'lucide-svelte';
  import PageHeader from '../components/PageHeader.svelte';

  const CATEGORY_ORDER = [
    { id: 'social', label: 'Social' },
    { id: 'video', label: 'Video' },
    { id: 'gallery', label: 'Galleries' },
    { id: 'adult', label: 'Adult' },
    { id: 'booru', label: 'Booru' },
  ];

  // Shared downloaders are worth naming; a site's own extractor is just "built in".
  const GENERIC = new Set(['cobalt', 'ytdlp', 'gallery-dl', 'direct']);

  let tools = $state({});
  let routes = $state({});
  let sites = $state([]);
  let loading = $state(true);
  let error = $state('');
  let saving = $state(false);
  let query = $state('');
  let tested = $state(null);
  let open = $state(null);
  let toast = $state('');
  let toastTimer;
  let testTimer;

  async function load() {
    error = '';
    try {
      const res = await fetch('/api/sources');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ({ tools, routes, sites } = await res.json());
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

  async function put(key, value, what) {
    saving = true;
    error = '';
    try {
      const res = await sendJson(`/api/settings/${key}`, 'PUT', { value });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      say(what);
      if (tested) runTest();
    } catch (err) {
      error = err.message || 'failed to save';
      await load();
    } finally {
      saving = false;
    }
  }

  const saveSwitches = what =>
    put(
      'disabled_services',
      sites.filter(s => !s.on).map(s => s.id),
      what
    );
  function toggle(site) {
    site.on = !site.on;
    saveSwitches(`${site.label} turned ${site.on ? 'on' : 'off'}`);
  }
  function setAll(list, on, what) {
    for (const s of list) s.on = on;
    saveSwitches(what);
  }

  const saveOrder = what =>
    put(
      'source_routes',
      Object.fromEntries(
        Object.values(routes).map(r => [
          r.id,
          r.steps.map(({ tool, on }) => ({ engine: tool, on })),
        ])
      ),
      what
    );
  function move(route, from, to) {
    const steps = [...route.steps];
    const [step] = steps.splice(from, 1);
    steps.splice(to, 0, step);
    route.steps = steps;
    saveOrder(`${route.name}: ${tries(route) || 'nothing'}`);
  }
  function skip(route, index) {
    const step = route.steps[index];
    if (step.on && route.steps.filter(s => s.on).length === 1) {
      error = `${route.name} needs at least one downloader. Turn the site off instead.`;
      return;
    }
    route.steps[index] = { ...step, on: !step.on };
    saveOrder(`${tools[step.tool]?.name} ${step.on ? 'skipped' : 'used again'} for ${route.name}`);
  }
  function reset(route) {
    route.steps = route.defaults.map(d => ({
      ...route.steps.find(s => s.tool === d.tool),
      on: d.on,
    }));
    saveOrder(`${route.name} back to the default order`);
  }

  const key = steps => steps.map(s => `${s.tool}:${s.on}`).join();
  const changed = route => key(route.steps) !== key(route.defaults);
  const usable = step => step.on && tools[step.tool]?.available;
  const tries = route =>
    route.steps
      .filter(usable)
      .map(s => tools[s.tool].name + (s.note ? ` (${s.note})` : ''))
      .join(', then ');

  const isLink = $derived(/^(https?:\/\/)?[\w-]+(\.[\w-]+)+\/\S*/i.test(query.trim()));
  async function runTest() {
    const url = query.trim();
    if (!isLink) {
      tested = null;
      return;
    }
    const res = await fetch(`/api/sources/test?url=${encodeURIComponent(url)}`).catch(() => null);
    tested = res?.ok ? await res.json() : { error: 'could not check that link' };
    if (tested.route && (tested.route.steps.length > 1 || !tested.site)) open = tested.site ?? null;
  }
  function onQuery() {
    clearTimeout(testTimer);
    testTimer = setTimeout(runTest, 300);
  }

  const shared = $derived(
    Object.fromEntries(
      Object.keys(routes).map(id => [id, sites.filter(s => s.route === id).map(s => s.label)])
    )
  );
  const filter = $derived(isLink ? '' : query.trim().toLowerCase());
  const groups = $derived(
    [
      ...CATEGORY_ORDER,
      ...[...new Set(sites.map(s => s.category))]
        .filter(c => !CATEGORY_ORDER.some(o => o.id === c))
        .map(c => ({ id: c, label: c })),
    ]
      .map(c => {
        const all = sites.filter(s => s.category === c.id);
        return {
          ...c,
          all,
          shown: all.filter(s => !filter || s.label.toLowerCase().includes(filter)),
          on: all.filter(s => s.on).length,
        };
      })
      .filter(c => c.all.length)
  );
  const totalOn = $derived(sites.filter(s => s.on).length);
  const testedSteps = $derived(
    (tested?.route?.steps ?? []).map(s => ({
      ...s,
      why: !s.on
        ? 'skipped'
        : s.applies === false
          ? `only ${s.note}`
          : !tools[s.tool]?.available
            ? 'not installed here'
            : null,
    }))
  );
</script>

<PageHeader
  title="Sources"
  description="Which sites the bot downloads from, and what it tries for each"
>
  {#snippet actions()}
    <span class="pill" class:ok={totalOn === sites.length} class:warn={totalOn < sites.length}
      >{saving ? 'Saving…' : `${totalOn} of ${sites.length} on`}</span
    >
    <button
      class="btn"
      disabled={saving || totalOn === sites.length}
      onclick={() => setAll(sites, true, 'All sites turned on')}>Turn all on</button
    >
    <button
      class="btn danger"
      disabled={saving || totalOn === 0}
      onclick={() =>
        confirm(`Turn off all ${sites.length} sites? Every /download link will be refused.`) &&
        setAll(sites, false, 'All sites turned off')}>Turn all off</button
    >
  {/snippet}
</PageHeader>

<div class="sources stack">
  {#if error}<div class="flash error">{error}</div>{/if}

  <section class="panel" aria-label="sites">
    <div class="finder">
      <label class="searchbox">
        <Search size={15} />
        <input
          bind:value={query}
          oninput={onQuery}
          placeholder="Find a site, or paste a link to see where it goes"
          aria-label="find a site or test a link"
        />
      </label>
      {#if isLink && tested}
        <div class="verdict" class:bad={tested.error || !tested.route}>
          {#if tested.error}
            {tested.error}
          {:else if !tested.route}
            No site takes this link, so /download refuses it.
          {:else}
            <span class="muted">Goes to</span>
            <b>{sites.find(s => s.id === tested.site)?.label ?? tested.route.name}</b>
            <span class="muted">and tries</span>
            {#each testedSteps as s, i (s.tool)}
              <span class="chip" class:dim={s.why} title={s.why ?? ''}
                >{tools[s.tool]?.name}{#if s.why}<em>{s.why}</em>{/if}</span
              >{#if i < testedSteps.length - 1}<span class="then">then</span>{/if}
            {/each}
          {/if}
        </div>
      {/if}
    </div>

    {#if loading}
      <div class="skel-rows">
        {#each Array(8) as _, i (i)}<span class="skeleton" style="width:{70 - (i % 3) * 12}%"
          ></span>{/each}
      </div>
    {:else if !groups.some(g => g.shown.length)}
      <div class="empty">
        <span class="ic"><Globe size={20} /></span>
        <b>No site matches</b>Try another name, or paste a whole link
      </div>
    {/if}

    {#each groups as g (g.id)}
      {#if g.shown.length}
        <div class="group">
          <span class="section-label">{g.label}</span>
          <span class="dim small tnum">{g.on}/{g.all.length} on</span>
          <span class="right row">
            <button
              class="linkish small"
              disabled={saving || g.on === g.all.length}
              onclick={() => setAll(g.all, true, `${g.label} turned on`)}>All on</button
            >
            <span class="dim">·</span>
            <button
              class="linkish small"
              disabled={saving || g.on === 0}
              onclick={() => setAll(g.all, false, `${g.label} turned off`)}>All off</button
            >
          </span>
        </div>
        <ul class="rows">
          {#each g.shown as site (site.id)}
            {@const route = routes[site.route]}
            {@const editable = route && route.steps.length > 1}
            <li class="site" class:off={!site.on} class:hit={tested?.site === site.id}>
              <div class="line">
                <button
                  class="toggle"
                  class:on={site.on}
                  role="switch"
                  aria-checked={site.on}
                  aria-label={`${site.label} ${site.on ? 'on' : 'off'}`}
                  disabled={saving}
                  onclick={() => toggle(site)}
                ></button>
                <span class="name">{site.label}</span>
                {#if route}
                  {#if editable}
                    <button
                      class="tries"
                      class:changed={changed(route)}
                      aria-expanded={open === site.id}
                      onclick={() => (open = open === site.id ? null : site.id)}
                    >
                      <span class="ell">{tries(route) || 'nothing switched on'}</span>
                      <ChevronDown size={14} />
                    </button>
                  {:else}
                    <span class="tries plain"
                      ><span class="ell"
                        >{tools[route.steps[0].tool]?.name === site.label ||
                        !GENERIC.has(route.steps[0].tool)
                          ? 'built in'
                          : tries(route)}</span
                      ></span
                    >
                  {/if}
                {/if}
              </div>
              {#if editable && open === site.id}
                <div class="order">
                  <ol>
                    {#each route.steps as s, i (s.tool)}
                      <li class:skipped={!s.on}>
                        <span class="n tnum"
                          >{s.on ? route.steps.slice(0, i + 1).filter(x => x.on).length : '–'}</span
                        >
                        <span class="what">
                          <b>{tools[s.tool]?.name}</b>
                          {#if s.note}<span class="dim small">only {s.note}</span>{/if}
                          {#if !tools[s.tool]?.available}<span class="warn-text small"
                              >not installed here</span
                            >{/if}
                        </span>
                        <span class="acts">
                          <button
                            class="icon"
                            aria-label="try earlier"
                            disabled={saving || i === 0}
                            onclick={() => move(route, i, i - 1)}><ArrowUp size={14} /></button
                          >
                          <button
                            class="icon"
                            aria-label="try later"
                            disabled={saving || i === route.steps.length - 1}
                            onclick={() => move(route, i, i + 1)}><ArrowDown size={14} /></button
                          >
                          <button class="btn sm" disabled={saving} onclick={() => skip(route, i)}
                            >{s.on ? 'Skip' : 'Use'}</button
                          >
                        </span>
                      </li>
                    {/each}
                  </ol>
                  <div class="foot">
                    {#if shared[route.id].length > 1}
                      <span class="dim small"
                        >Same order for {shared[route.id]
                          .filter(l => l !== site.label)
                          .join(', ')}</span
                      >
                    {:else}
                      <span class="dim small">If one fails, the next one tries.</span>
                    {/if}
                    {#if changed(route)}
                      <button
                        class="linkish small right"
                        disabled={saving}
                        onclick={() => reset(route)}><RotateCcw size={11} /> Default order</button
                      >
                    {/if}
                  </div>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/each}
  </section>
</div>

{#if toast}<div class="toast" role="status">{toast}</div>{/if}

<style>
  .sources {
    max-width: 960px;
  }
  .finder {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--line);
  }
  .finder .searchbox {
    width: 100%;
  }
  .finder input {
    width: 100%;
    min-width: 0;
    height: 34px;
  }
  .verdict {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-sm);
  }
  .verdict b {
    color: var(--text-bright);
  }
  .verdict.bad {
    color: var(--danger-text);
  }
  .chip {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    padding: 2px 9px;
    border: 1px solid var(--accent-border);
    border-radius: 999px;
    background: var(--accent-bg);
    color: var(--text-bright);
  }
  .chip.dim {
    border-style: dashed;
    border-color: var(--border-2);
    background: none;
    color: var(--text-muted);
  }
  .chip em {
    font-style: normal;
    color: var(--text-dim);
  }
  .then {
    color: var(--text-dim);
  }
  .group {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 16px 6px;
  }
  .rows {
    margin: 0 0 6px;
    padding: 0;
    list-style: none;
  }
  .site {
    border-top: 1px solid var(--line);
  }
  .site:first-child {
    border-top: 0;
  }
  .site.hit {
    background: var(--accent-bg);
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .line {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    column-gap: 12px;
    row-gap: 2px;
    min-height: 44px;
    padding: 6px 16px;
  }
  .line .toggle {
    grid-row: span 2;
  }
  .name {
    font-weight: 600;
    color: var(--text-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .site.off .name {
    color: var(--text-muted);
    font-weight: 500;
  }
  .tries {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    justify-self: start;
    max-width: 100%;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: var(--fs-sm);
    color: var(--text-muted);
    text-align: left;
  }
  button.tries {
    cursor: pointer;
  }
  button.tries:hover {
    color: var(--text-bright);
  }
  button.tries:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 4px;
  }
  .tries.changed {
    color: var(--accent);
  }
  .ell {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .site.off .tries {
    opacity: 0.6;
  }
  .order {
    margin: 0 16px 12px 16px;
    border: 1px solid var(--border-2);
    border-radius: var(--radius);
    background: var(--card);
  }
  .order ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .order li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-top: 1px solid var(--line);
  }
  .order li:first-child {
    border-top: 0;
  }
  .n {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 11px;
    font-weight: 600;
  }
  .skipped .n {
    background: var(--card-3);
    color: var(--text-muted);
  }
  .skipped .what b {
    color: var(--text-muted);
    font-weight: 500;
    text-decoration: line-through;
  }
  .what {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
    flex: 1;
    min-width: 0;
  }
  .what b {
    color: var(--text-bright);
  }
  .warn-text {
    color: var(--warning-text);
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }
  .acts .btn {
    margin-left: 6px;
    min-width: 52px;
  }
  .icon {
    display: inline-grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--text-muted);
    cursor: pointer;
  }
  .icon:hover:not(:disabled) {
    background: var(--card-2);
    color: var(--text-bright);
  }
  .icon:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-top: 1px solid var(--line);
    background: var(--card-2);
    border-radius: 0 0 var(--radius) var(--radius);
  }
  .foot .linkish {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  @media (min-width: 720px) {
    .line {
      grid-template-columns: auto 200px minmax(0, 1fr);
    }
    .line .toggle {
      grid-row: auto;
    }
    .order {
      margin-left: 76px;
    }
  }
</style>
