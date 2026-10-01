<script>
  import { untrack } from 'svelte';
  import { Download, Radio, Undo2, SearchX } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { logs as liveLogs } from '../stores/sse-store.js';
  import PageHeader from '../components/PageHeader.svelte';
  import SaveView from '../components/SaveView.svelte';
  import Chart from '../components/Chart.svelte';
  import TimeRange from '../components/TimeRange.svelte';
  import LogQueryBar from '../components/LogQueryBar.svelte';
  import LogFacets from '../components/LogFacets.svelte';
  import LogList from '../components/LogList.svelte';
  import LogDetail from '../components/LogDetail.svelte';
  import { FIELDS, SEVERITY, fieldOf, sameValue } from '../components/LogLevel.svelte';

  const RANGES = { '15m': 0.25, '1h': 1, '6h': 6, '24h': 24, '7d': 168 };
  const PAGE = 200;
  // Stacked bottom-up, most severe first, so errors always sit on the baseline.
  const SERIES = [
    { key: 'ERROR', label: 'error', color: 'var(--chart-4)' },
    { key: 'WARN', label: 'warn', color: 'var(--chart-3)' },
    { key: 'INFO', label: 'info', color: 'var(--chart-1)' },
    { key: 'DEBUG', label: 'debug', color: 'var(--chart-muted)' },
  ];
  const PREFS_KEY = 'gronka:logs:view';

  let rows = $state([]);
  let total = $state(0);
  let facets = $state({});
  let histogram = $state(null);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state('');
  let selected = $state(null);
  let related = $state([]);
  let zoomStack = $state([]);
  let pending = $state([]); // live lines held back while the list is scrolled away from the top
  let fresh = $state(new Set());
  let atTop = $state(true);
  let prefs = $state(loadPrefs());

  function loadPrefs() {
    const d = { wrap: false, timestamps: true, density: 'compact', facets: true };
    try {
      return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
    } catch {
      return d;
    }
  }
  $effect(() => {
    const json = JSON.stringify(prefs);
    try {
      localStorage.setItem(PREFS_KEY, json);
    } catch {
      /* private mode: the view simply resets next time */
    }
  });

  // The URL is the only filter state: facet clicks, the query bar and the chart all navigate.
  // `key=a,b` includes, `-key=a,b` excludes (the API has no negation, so that part is client-side).
  const params = $derived($currentRoute.params);
  const split = v => (v ? v.split(',').filter(Boolean) : []);
  const bagOf = prefix => {
    const f = {};
    for (const key of FIELDS) {
      const v = split(params[`$${prefix}${key}`]);
      if (v.length) f[key] = v;
    }
    return f;
  };
  const filters = $derived(bagOf(''));
  const negated = $derived(bagOf('-'));
  const search = $derived(params.$search || '');
  const live = $derived(params.$live === '1');
  const hasQuery = $derived(
    !!search || Object.keys(filters).length > 0 || Object.keys(negated).length > 0
  );
  // An op id starts with its creation time in ms; a request never outlives Discord's 15 min token.
  const opWindow = $derived.by(() => {
    const at = Number(filters.op?.length === 1 && filters.op[0].split('-')[0]);
    return at > 1e12 ? [at - 60e3, at + 20 * 60e3] : null;
  });
  const range = $derived(params.$range || (params.$startTime || opWindow ? '' : '24h'));
  const startTime = $derived(
    params.$startTime
      ? Number(params.$startTime)
      : range
        ? Date.now() - RANGES[range] * 3600e3
        : opWindow[0]
  );
  const endTime = $derived(
    params.$endTime
      ? Number(params.$endTime)
      : !params.$startTime && !range && opWindow
        ? opWindow[1]
        : null
  );
  const win = $derived({
    range,
    startTime: params.$startTime || (opWindow && !range ? String(opWindow[0]) : null),
    endTime:
      params.$endTime || (opWindow && !range && !params.$startTime ? String(opWindow[1]) : null),
  });
  const zoomed = $derived(!!params.$startTime);

  function query(extra = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) q.set(k, v.join(','));
    if (search) q.set('search', search);
    q.set('startTime', String(startTime));
    if (endTime) q.set('endTime', String(endTime));
    for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
    return q;
  }

  function go(changes) {
    const next = {};
    for (const [k, v] of Object.entries(params)) if (k.startsWith('$')) next[k.slice(1)] = v;
    Object.assign(next, changes);
    for (const k of Object.keys(next)) if (next[k] === '' || next[k] == null) delete next[k];
    navigate('logs', next);
  }

  const without = (key, list, v) => (list || []).filter(x => !sameValue(key, x, v));
  const has = (key, list, v) => (list || []).some(x => sameValue(key, x, v));

  // Facet click: un-exclude an excluded value, otherwise flip it in the include list.
  function toggle(key, value) {
    if (has(key, negated[key], value))
      return go({ [`-${key}`]: without(key, negated[key], value).join(',') });
    const cur = filters[key] || [];
    const next = has(key, cur, value) ? without(key, cur, value) : [...cur, value];
    go({ [key]: next.join(',') });
  }
  function only(key, value) {
    go({ [key]: value ?? '', [`-${key}`]: '' });
  }
  function filterBy(key, value, exclude) {
    const v = key === 'level' ? value.toUpperCase() : value;
    const pos = without(key, filters[key], v);
    const neg = without(key, negated[key], v);
    (exclude ? neg : pos).push(v);
    go({ [key]: pos.join(','), [`-${key}`]: neg.join(',') });
  }
  function setQuery(next) {
    const changes = { search: next.search || '' };
    for (const k of FIELDS) {
      changes[k] = (next.filters[k] || []).join(',');
      changes[`-${k}`] = (next.negated[k] || []).join(',');
    }
    go(changes);
  }
  const clearAll = () => setQuery({ filters: {}, negated: {}, search: '' });

  const get = url =>
    fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));

  let seq = 0;
  async function load() {
    const mine = ++seq;
    loading = true;
    error = '';
    pending = [];
    try {
      const [l, f, h] = await Promise.all([
        get(`/api/logs?${query({ limit: PAGE })}`),
        get(`/api/logs/facets?${query()}`),
        get(`/api/logs/histogram?${query({ buckets: 80 })}`),
      ]);
      if (mine !== seq) return;
      rows = l.logs || [];
      total = l.total || 0;
      facets = f.facets || {};
      histogram = h;
      if (selected && !rows.some(r => r.id === selected.id)) selected = null;
    } catch (e) {
      if (mine === seq)
        error = `Could not load logs${e?.message?.startsWith('HTTP') ? ` (${e.message})` : ''}. ${
          rows.length ? 'Showing the last results.' : 'Check the connection and try again.'
        }`;
    } finally {
      if (mine === seq) loading = false;
    }
  }

  async function more() {
    if (loadingMore || rows.length >= total) return;
    const mine = seq;
    loadingMore = true;
    try {
      const l = await get(`/api/logs?${query({ limit: PAGE, offset: rows.length })}`);
      if (mine !== seq) return;
      const known = new Set(rows.map(r => r.id));
      rows = [...rows, ...(l.logs || []).filter(r => !known.has(r.id))];
    } catch {
      if (mine === seq) error = 'Could not load more lines.';
    } finally {
      loadingMore = false;
    }
  }

  $effect(() => {
    query();
    load();
  });

  // Exclusions run here: the API only knows positive filters.
  const excludedBy = line =>
    Object.entries(negated).some(([k, vs]) => {
      const v = fieldOf(line, k);
      return v != null && vs.some(x => sameValue(k, x, v));
    });
  const visible = $derived(Object.keys(negated).length ? rows.filter(r => !excludedBy(r)) : rows);
  const excluded = $derived(rows.length - visible.length);

  function matches(line) {
    if (line.component === 'webui' && line.level === 'INFO') return false;
    if (line.timestamp < startTime) return false;
    for (const [key, values] of Object.entries(filters)) {
      if (!has(key, values, fieldOf(line, key))) return false;
    }
    if (excludedBy(line)) return false;
    return !search || line.message.toLowerCase().includes(search.toLowerCase());
  }

  // New lines arrive over SSE: every process's insertLog NOTIFYs and the webui server relays it.
  $effect(() => {
    if (!live || endTime) return;
    return liveLogs.subscribe(list => untrack(() => take(list)));
  });

  function take(list) {
    const known = new Set([...pending, ...rows].map(r => r.id));
    const got = [];
    for (const line of list) {
      if (known.has(line.id)) break;
      if (matches(line)) got.push(line);
    }
    if (!got.length) return;
    total += got.length;
    if (atTop) prepend(got);
    else pending = [...got, ...pending].slice(0, 1000);
  }
  function prepend(lines) {
    rows = [...lines, ...rows].slice(0, 1000);
    const ids = lines.map(l => l.id);
    fresh = new Set([...fresh, ...ids]);
    setTimeout(() => {
      const next = new Set(fresh);
      for (const id of ids) next.delete(id);
      fresh = next;
    }, 1600);
  }
  function resume() {
    if (pending.length) prepend(pending);
    pending = [];
  }
  // Scrolling back to the top (or leaving live mode) releases what was held back.
  $effect(() => {
    if ((atTop || !live) && pending.length) untrack(resume);
  });

  $effect(() => {
    const op = selected?.metadata?.op;
    related = [];
    if (!op) return;
    fetch(`/api/logs?op=${encodeURIComponent(op)}&orderDesc=false&limit=100`)
      .then(r => r.json())
      .then(l => (related = l.logs || []))
      .catch(() => {});
  });

  const selIndex = $derived(selected ? visible.findIndex(r => r.id === selected.id) : -1);
  function step(dir) {
    if (!visible.length) return;
    const i = selIndex < 0 ? (dir > 0 ? 0 : visible.length - 1) : selIndex + dir;
    if (visible[i]) selected = visible[i];
  }
  const select = r => (selected = selected?.id === r.id ? null : r);

  function onkey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"]'))
      return;
    if (e.key === 'Escape' && selected) selected = null;
    else if (e.key === 'j') step(1);
    else if (e.key === 'k') step(-1);
  }

  // Chart brush: remember where we came from so one click steps back out.
  function onbrush(s, e) {
    zoomStack = [...zoomStack, win];
    go({ range: '', startTime: String(s), endTime: String(e), live: '' });
  }
  function back() {
    const prev = zoomStack.at(-1);
    zoomStack = zoomStack.slice(0, -1);
    if (prev) go({ range: prev.range, startTime: prev.startTime, endTime: prev.endTime });
  }
  function onrange(v) {
    zoomStack = [];
    go({
      range: v.range,
      startTime: v.startTime,
      endTime: v.endTime,
      ...(v.endTime ? { live: '' } : {}),
    });
  }

  const bars = $derived(
    (histogram?.buckets ?? []).map((b, i) => ({
      at: histogram.start + i * histogram.size,
      ...Object.fromEntries(SEVERITY.map(l => [l, b[l] || 0])),
    }))
  );
  const levelTotals = $derived(
    Object.fromEntries(
      SEVERITY.map(l => [l, (histogram?.buckets ?? []).reduce((s, b) => s + (b[l] || 0), 0)])
    )
  );
  const levelOff = l =>
    (filters.level?.length && !has('level', filters.level, l)) || has('level', negated.level, l);

  // Autocomplete values: facets cover level..worker; op, user and job come from loaded lines.
  const suggest = $derived.by(() => {
    const out = { ...facets };
    for (const key of ['op', 'user', 'job']) {
      const counts = new Map();
      for (const r of rows) {
        const v = r.metadata?.[key];
        if (v != null && v !== '') counts.set(String(v), (counts.get(String(v)) || 0) + 1);
      }
      out[key] = [...counts]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    }
    return out;
  });

  function exportRows() {
    const blob = new Blob([JSON.stringify(visible, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `gronka-logs-${Date.now()}.json`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  }
</script>

<svelte:window onkeydown={onkey} />

<PageHeader title="Logs" description="Every line the bot, its workers and the web server write">
  {#snippet actions()}
    <button
      class="btn"
      class:on={live}
      onclick={() => go({ live: live ? '' : '1', endTime: '' })}
      title="stream new lines as they are written"
      aria-pressed={live}
    >
      <span class="dot" class:ok={live} class:pulse={live}></span><Radio size={14} />Live tail
    </button>
    <SaveView page="logs" />
    <button
      class="btn"
      onclick={exportRows}
      disabled={!visible.length}
      title="download the loaded lines as JSON"
    >
      <Download size={14} />Export
    </button>
  {/snippet}
</PageHeader>

{#snippet emptyState()}
  <div class="empty big">
    <span class="ic"><SearchX size={20} /></span>
    {#if excluded}
      <b>Every loaded line is excluded</b>
      Your exclusions hide all {rows.length.toLocaleString()} loaded lines.
      <div class="eacts">
        <button class="btn sm" onclick={() => setQuery({ filters, negated: {}, search })}
          >Remove exclusions</button
        >
        {#if rows.length < total}<button class="btn sm" onclick={more}>Load more</button>{/if}
      </div>
    {:else}
      <b>No lines match this query {range ? `in the last ${range}` : 'in this window'}</b>
      {hasQuery ? 'Remove a filter or widen the time range.' : 'Nothing was logged in this window.'}
      <div class="eacts">
        {#if range !== '7d'}
          <button class="btn sm" onclick={() => onrange({ range: '7d' })}>Widen to 7d</button>
        {/if}
        {#if hasQuery}<button class="btn sm" onclick={clearAll}>Clear filters</button>{/if}
      </div>
    {/if}
  </div>
{/snippet}

<section class="panel explorer" aria-label="log explorer">
  <div class="bar">
    <LogQueryBar {filters} {negated} {search} values={suggest} onchange={setQuery} />
    <TimeRange presets={RANGES} value={win} onchange={onrange} defaultRange="24h" />
  </div>

  <div class="hist">
    <div class="hist-head">
      <span class="summary">
        {#if loading && !rows.length}<span class="skeleton sum-skel"></span>{:else}<b class="tnum"
            >{total.toLocaleString()}</b
          > lines{/if}
        {#if excluded}<span class="sep">·</span><span
            class="excl"
            title="the API only filters positive matches; exclusions apply to the loaded lines"
            >{excluded.toLocaleString()} excluded client-side</span
          >{/if}
        {#if live}<span class="sep">·</span><span class="livep"
            ><span class="dot ok pulse"></span>Live</span
          >{/if}
      </span>
      <span class="legend" role="group" aria-label="levels">
        {#each SERIES as s (s.key)}
          <button
            class:off={levelOff(s.key)}
            onclick={e => (e.altKey ? only('level', s.key) : toggle('level', s.key))}
            title="click to filter by {s.label}, alt-click to show only {s.label}"
          >
            <i style="background:{s.color}"></i>{s.label}
            <span class="tnum">{levelTotals[s.key].toLocaleString()}</span>
          </button>
        {/each}
      </span>
      {#if zoomStack.length}
        <button class="btn sm" onclick={back}><Undo2 size={12} />Back</button>
      {:else if zoomed}
        <span class="hint">zoomed</span>
      {:else}
        <span class="hint">drag to zoom</span>
      {/if}
    </div>
    <Chart
      series={SERIES}
      data={bars}
      bucket={histogram?.size}
      height={92}
      {onbrush}
      padLeft={36}
    />
  </div>

  <div class="body" class:has-detail={!!selected}>
    {#if prefs.facets}
      <LogFacets
        {facets}
        loading={loading && !rows.length}
        {filters}
        {negated}
        ontoggle={toggle}
        ononly={only}
        onhide={() => (prefs.facets = false)}
      />
    {/if}

    <LogList
      rows={visible}
      selectedId={selected?.id}
      {search}
      bind:prefs
      {loading}
      {error}
      {total}
      {excluded}
      hasMore={rows.length < total}
      {loadingMore}
      {fresh}
      pending={pending.length}
      {live}
      bind:atTop
      facetsHidden={!prefs.facets}
      onselect={select}
      onstep={step}
      onresume={resume}
      onmore={more}
      onretry={load}
      onshowfacets={() => (prefs.facets = true)}
      empty={emptyState}
    />

    {#if selected}
      <LogDetail
        line={selected}
        {related}
        onfilter={filterBy}
        onselect={r => (selected = r)}
        onstep={step}
        onclose={() => (selected = null)}
        canPrev={selIndex > 0}
        canNext={selIndex < visible.length - 1}
      />
    {/if}
  </div>
</section>

<style>
  .explorer {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 193px);
    min-height: 560px;
    overflow: hidden;
  }
  .bar {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
    background: var(--card-2);
  }

  .hist {
    padding: 6px 16px 0;
    border-bottom: 1px solid var(--line);
  }
  .hist-head {
    display: flex;
    align-items: center;
    gap: 14px;
    font-size: var(--fs-sm);
    color: var(--text-muted);
    height: 26px;
  }
  .summary {
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
  }
  .summary b {
    color: var(--text-bright);
    font-weight: 600;
    margin-right: 4px;
  }
  .sum-skel {
    width: 72px;
    height: 10px;
  }
  .sep {
    margin: 0 6px;
    color: var(--text-dim);
  }
  .excl {
    color: var(--danger-text);
  }
  .livep {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--success-text);
    font-weight: 500;
  }
  .livep .dot {
    width: 6px;
    height: 6px;
  }
  .legend {
    margin-left: auto;
    display: flex;
    gap: 2px;
  }
  .legend button {
    height: 22px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .legend button:hover {
    background: var(--card-3);
    color: var(--text-bright);
  }
  .legend button span {
    font-family: var(--mono);
    color: var(--text);
  }
  .legend button.off {
    opacity: 0.45;
  }
  .legend i {
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
  .hint {
    font-size: var(--fs-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .body {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .eacts {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin-top: 14px;
  }
  .eacts .btn {
    margin: 0;
  }

  /* Below 1680px the detail panel slides over the list instead of squeezing the message away. */
  @media (max-width: 1680px) and (min-width: 769px) {
    .body :global(.detail) {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 6;
      width: min(480px, 100%);
      box-shadow: var(--shadow-pop);
      animation: slide-in 0.16s ease-out;
    }
  }
  @keyframes slide-in {
    from {
      transform: translateX(24px);
      opacity: 0;
    }
  }
  @media (max-width: 1100px) {
    .body :global(.facets) {
      display: none;
    }
  }
  @media (max-width: 768px) {
    .explorer {
      height: auto;
      min-height: 70vh;
      overflow: visible;
    }
    .bar {
      padding: 10px 12px;
    }
    .bar :global(.qwrap) {
      flex-basis: 100%;
    }
    .legend,
    .hint {
      display: none;
    }
    .body {
      flex-direction: column;
    }
    .body :global(.list) {
      flex: none;
      height: 70vh;
    }
    .body :global(.detail) {
      width: 100%;
      border-left: 0;
      border-top: 1px solid var(--line);
    }
  }
</style>
