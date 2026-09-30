<script>
  import { untrack } from 'svelte';
  import { Search, Download, Radio, Undo2, X, Copy, Crosshair, Link2 } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { logs as liveLogs } from '../stores/sse-store.js';
  import { useHeaderActions } from '../stores/header.js';
  import SaveView from '../components/SaveView.svelte';
  import Chart from '../components/Chart.svelte';
  import TimeRange from '../components/TimeRange.svelte';

  const FIELDS = ['level', 'component', 'source', 'command', 'worker', 'op', 'user', 'job'];
  const FACETS = [
    ['level', 'Level'],
    ['component', 'Component'],
    ['source', 'Source'],
    ['command', 'Command'],
    ['worker', 'Worker'],
  ];
  const RANGES = { '15m': 0.25, '1h': 1, '6h': 6, '24h': 24, '7d': 168 };
  const PAGE = 200;
  const SERIES = [
    { key: 'info', label: 'info', color: 'var(--chart-muted)' },
    { key: 'warn', label: 'warn', color: 'var(--warning)' },
    { key: 'err', label: 'error', color: 'var(--danger)' },
  ];

  let rows = $state([]);
  let total = $state(0);
  let facets = $state({});
  let histogram = $state(null);
  let loading = $state(true);
  let error = $state('');
  let selected = $state(null);
  let related = $state([]);
  let draft = $state('');
  let zoomStack = $state([]);
  let copied = $state(false);

  // The URL is the only filter state: facet clicks, the query bar and the chart all navigate.
  const params = $derived($currentRoute.params);
  const filters = $derived.by(() => {
    const f = {};
    for (const key of FIELDS) {
      const v = params[`$${key}`];
      if (v) f[key] = v.split(',').filter(Boolean);
    }
    return f;
  });
  const search = $derived(params.$search || '');
  const live = $derived(params.$live === '1');
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

  function toggle(key, value) {
    const cur = filters[key] || [];
    const next = cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value];
    go({ [key]: next.join(',') });
  }

  let seq = 0;
  async function load() {
    const mine = ++seq;
    loading = true;
    error = '';
    try {
      const get = url => fetch(url).then(r => (r.ok ? r.json() : Promise.reject(r.status)));
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
    } catch {
      if (mine === seq) error = 'could not load logs';
    } finally {
      if (mine === seq) loading = false;
    }
  }

  async function more() {
    const l = await fetch(`/api/logs?${query({ limit: PAGE, offset: rows.length })}`).then(r =>
      r.json()
    );
    rows = [...rows, ...(l.logs || [])];
  }

  $effect(() => {
    query();
    load();
  });

  function matches(line) {
    if (line.component === 'webui' && line.level === 'INFO') return false;
    if (line.timestamp < startTime) return false;
    for (const [key, values] of Object.entries(filters)) {
      const v = key === 'level' || key === 'component' ? line[key] : line.metadata?.[key];
      if (!values.includes(String(v))) return false;
    }
    return !search || line.message.toLowerCase().includes(search.toLowerCase());
  }

  // New lines arrive over SSE: every process's insertLog NOTIFYs and the webui server relays it.
  $effect(() => {
    if (!live || endTime) return;
    return liveLogs.subscribe(list => untrack(() => take(list)));
  });

  function take(list) {
    const known = new Set(rows.map(r => r.id));
    const fresh = [];
    for (const line of list) {
      if (known.has(line.id)) break;
      if (matches(line)) fresh.push(line);
    }
    if (fresh.length) {
      rows = [...fresh, ...rows].slice(0, 1000);
      total += fresh.length;
    }
  }

  $effect(() => {
    const op = selected?.metadata?.op;
    related = [];
    if (!op) return;
    fetch(`/api/logs?op=${encodeURIComponent(op)}&orderDesc=false&limit=100`)
      .then(r => r.json())
      .then(l => (related = l.logs || []))
      .catch(() => {});
  });

  function commitDraft() {
    const text = draft.trim();
    if (!text) return;
    const m = text.match(/^(\w+):(.+)$/);
    if (m && FIELDS.includes(m[1])) {
      const value = m[1] === 'level' ? m[2].toUpperCase() : m[2];
      toggle(m[1], value);
    } else {
      go({ search: text });
    }
    draft = '';
  }

  function onQueryKey(e) {
    if (e.key === 'Enter') commitDraft();
    if (e.key === 'Backspace' && !draft) {
      if (search) return go({ search: '' });
      const last = Object.entries(filters).at(-1);
      if (last) toggle(last[0], last[1].at(-1));
    }
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
      live: v.endTime ? '' : undefined,
    });
  }

  const time = t =>
    new Date(t).toLocaleTimeString([], { hour12: false }) + '.' + String(t % 1000).padStart(3, '0');
  const day = t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const lvl = l => ({ ERROR: 'ERR', WARN: 'WRN', INFO: 'INF', DEBUG: 'DBG' })[l] || l;
  const ctx = r =>
    [r.metadata?.source, r.metadata?.command && `/${r.metadata.command}`, r.metadata?.worker]
      .filter(Boolean)
      .join(' · ');

  const bars = $derived(
    (histogram?.buckets ?? []).map((b, i) => ({
      at: histogram.start + i * histogram.size,
      info: b.INFO + b.DEBUG,
      warn: b.WARN,
      err: b.ERROR,
    }))
  );
  const levelCount = l => facets.level?.find(f => f.value === l)?.count ?? 0;
  const facetMax = list => Math.max(1, ...list.map(f => f.count));

  const chips = $derived(Object.entries(filters).flatMap(([k, vs]) => vs.map(v => [k, v])));

  function exportRows() {
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `gronka-logs-${Date.now()}.json`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function copy(text) {
    navigator.clipboard?.writeText(text);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }

  useHeaderActions(actions);
</script>

{#snippet actions()}
  <button
    class="btn"
    class:on={live}
    onclick={() => go({ live: live ? '' : '1', endTime: '' })}
    title="stream new lines as they are written"
  >
    <span class="dot" class:ok={live} class:pulse={live}></span><Radio size={13} />Live tail
  </button>
  <SaveView page="logs" />
  <button
    class="btn"
    onclick={exportRows}
    disabled={!rows.length}
    title="download the loaded lines as JSON"
  >
    <Download size={13} />Export
  </button>
{/snippet}

<div class="logs" class:has-detail={!!selected}>
  <div class="bar">
    <div class="qbar" role="search">
      <Search size={14} />
      {#each chips as [key, value] (key + value)}
        <button class="qchip" onclick={() => toggle(key, value)} title="remove">
          <span class="k">{key}:</span>{value}<span class="x">×</span>
        </button>
      {/each}
      {#if search}
        <button class="qchip text" onclick={() => go({ search: '' })} title="remove">
          "{search}"<span class="x">×</span>
        </button>
      {/if}
      <input
        bind:value={draft}
        onkeydown={onQueryKey}
        placeholder={chips.length || search ? '' : 'search, or field:value'}
        title="fields: level, component, source, command, worker, op, user"
        aria-label="filter logs"
        spellcheck="false"
      />
    </div>
    <TimeRange presets={RANGES} value={win} onchange={onrange} defaultRange="24h" />
  </div>

  <div class="hist">
    <div class="hist-head">
      <span class="summary">
        <b class="tnum">{total.toLocaleString()}</b> lines
        {#if levelCount('ERROR')}<span class="sep">·</span><span class="error-text tnum"
            >{levelCount('ERROR').toLocaleString()} errors</span
          >{/if}
        {#if levelCount('WARN')}<span class="sep">·</span><span class="warn-text tnum"
            >{levelCount('WARN').toLocaleString()} warnings</span
          >{/if}
        {#if loading}<span class="sep">·</span><span class="dim">loading</span>{/if}
      </span>
      <span class="legend">
        {#each [...SERIES].reverse() as s (s.key)}
          <span><i style="background:{s.color}"></i>{s.label}</span>
        {/each}
      </span>
      {#if zoomStack.length}
        <button class="btn sm" onclick={back}><Undo2 size={12} />Back</button>
      {:else if zoomed}
        <span class="dim small">zoomed</span>
      {:else}
        <span class="dim small">drag the chart to zoom</span>
      {/if}
    </div>
    <Chart
      series={SERIES}
      data={bars}
      bucket={histogram?.size}
      height={104}
      {onbrush}
      padLeft={44}
    />
  </div>

  <div class="body">
    <aside class="facets" aria-label="filters">
      {#each FACETS as [key, label] (key)}
        {#if facets[key]?.length}
          {@const max = facetMax(facets[key])}
          <div class="fh">{label}</div>
          {#each facets[key] as f (f.value)}
            {@const on = filters[key]?.includes(f.value)}
            <button class="fv" class:on onclick={() => toggle(key, f.value)}>
              <span class="box lvl-{key === 'level' ? f.value.toLowerCase() : ''}" class:on></span>
              <span class="fname">{key === 'level' ? f.value.toLowerCase() : f.value}</span>
              <span class="fbar"><i style="width:{(f.count / max) * 100}%"></i></span>
              <span class="fcount">{f.count.toLocaleString()}</span>
            </button>
          {/each}
        {/if}
      {/each}
      {#if !facets.source?.length}
        <p class="note">
          Source, command and worker filters fill in as new lines are written with request context.
        </p>
      {/if}
    </aside>

    <section class="list" aria-label="log lines">
      <div class="lh">
        <span>time</span><span>lvl</span><span>component</span><span>message</span>
        <span class="ctxh">context</span>
      </div>
      <div class="scroll" class:busy={loading && rows.length}>
        {#if error}
          <div class="empty">{error} <button class="btn sm" onclick={load}>retry</button></div>
        {:else if loading && !rows.length}
          {#each Array(14) as _, i (i)}
            <div class="row skel" aria-hidden="true">
              <span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"
              ></span><span class="skeleton" style="width:{40 + ((i * 37) % 55)}%"></span>
            </div>
          {/each}
        {:else if !rows.length}
          <div class="empty">no lines match</div>
        {/if}
        {#each rows as r (r.id)}
          <button
            class="row lvl-{r.level.toLowerCase()}"
            class:sel={selected?.id === r.id}
            onclick={() => (selected = selected?.id === r.id ? null : r)}
          >
            <span class="t">{time(r.timestamp)}</span>
            <span class="l">{lvl(r.level)}</span>
            <span class="c ellipsis">{r.component}</span>
            <span class="m ellipsis">{r.message}</span>
            <span class="x ellipsis">{ctx(r)}</span>
          </button>
        {/each}
        {#if rows.length < total}
          <button class="more" onclick={more}
            >load {Math.min(PAGE, total - rows.length)} more · {(
              total - rows.length
            ).toLocaleString()} remaining</button
          >
        {/if}
      </div>
    </section>

    {#if selected}
      <aside class="detail" aria-label="selected line">
        <div class="dh">
          <span class="badge lvl-{selected.level.toLowerCase()}">{lvl(selected.level)}</span>
          <b>{selected.component}</b>
          <span class="t">{day(selected.timestamp)} {time(selected.timestamp)}</span>
          <button class="icon-btn sm right" onclick={() => (selected = null)} aria-label="close"
            ><X size={15} /></button
          >
        </div>
        <pre class="msg">{selected.message}</pre>
        {#if selected.metadata && typeof selected.metadata === 'object'}
          <div class="sh">Fields</div>
          <div class="fields">
            {#each Object.entries(selected.metadata) as [k, v] (k)}
              <span class="fk">{k}</span>
              {#if FIELDS.includes(k)}
                <button class="fvv" onclick={() => toggle(k, String(v))} title="filter by this"
                  >{v}</button
                >
              {:else}<span class="fvv">{v}</span>{/if}
            {/each}
          </div>
        {/if}
        {#if related.length}
          <div class="sh">Same request · {related.length}</div>
          <div class="related">
            {#each related as r (r.id)}
              <button class="rr" class:cur={r.id === selected.id} onclick={() => (selected = r)}>
                <span class="t">{time(r.timestamp)}</span>
                <span class="dot lvl-{r.level.toLowerCase()}"></span>
                <span class="m">{r.message}</span>
              </button>
            {/each}
          </div>
        {/if}
        <div class="actions">
          {#if selected.metadata?.op}
            <button class="btn sm" onclick={() => navigate('logs', { op: selected.metadata.op })}
              ><Link2 size={12} />Only this request</button
            >
          {/if}
          <button
            class="btn sm"
            onclick={() =>
              navigate('logs', {
                startTime: String(selected.timestamp - 30000),
                endTime: String(selected.timestamp + 30000),
              })}><Crosshair size={12} />±30 s around</button
          >
          <button class="btn sm" onclick={() => copy(selected.message)}
            ><Copy size={12} />{copied ? 'Copied' : 'Copy'}</button
          >
        </div>
      </aside>
    {/if}
  </div>
</div>

<style>
  .logs {
    flex: 1;
    display: flex;
    flex-direction: column;
    height: calc(100vh - var(--topbar-h));
    min-width: 0;
    font-size: var(--fs);
  }
  .bar {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 10px 24px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }

  .hist {
    padding: 8px 24px 4px;
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
  .summary b {
    color: var(--text-bright);
    font-weight: 500;
  }
  .sep {
    margin: 0 6px;
    color: var(--text-dim);
  }
  .legend {
    margin-left: auto;
    display: flex;
    gap: 12px;
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .legend i {
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }

  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .facets {
    width: 240px;
    flex-shrink: 0;
    overflow-y: auto;
    padding: 6px 10px 16px;
    border-right: 1px solid var(--line);
  }
  .fh {
    padding: 14px 8px 4px;
    font-size: var(--fs-xs);
    font-weight: 500;
    color: var(--text-dim);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .fv {
    width: 100%;
    height: 28px;
    padding: 0 8px;
    display: grid;
    grid-template-columns: 11px minmax(0, 1fr) 36px auto;
    align-items: center;
    gap: 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font: inherit;
    font-size: var(--fs);
    text-align: left;
    cursor: pointer;
  }
  .fv:hover {
    background: var(--surface);
  }
  .fv.on {
    background: var(--surface-2);
  }
  .box {
    width: 11px;
    height: 11px;
    border-radius: 3px;
    border: 1.5px solid var(--border-2);
  }
  .box.on {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .box.lvl-error {
    border-color: var(--danger);
  }
  .box.lvl-warn {
    border-color: var(--warning);
  }
  .box.lvl-error.on {
    background: var(--danger);
  }
  .box.lvl-warn.on {
    background: var(--warning);
  }
  .fname {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fbar {
    height: 3px;
    border-radius: 2px;
    background: var(--surface-3);
    overflow: hidden;
  }
  .fbar i {
    display: block;
    height: 100%;
    background: var(--chart-muted);
  }
  .fv.on .fbar i {
    background: var(--accent-strong);
  }
  .fcount {
    font: var(--fs-xs) var(--mono);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    min-width: 28px;
    text-align: right;
  }
  .note {
    margin: 14px 8px;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text-dim);
  }

  .list {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .lh,
  .row {
    display: grid;
    grid-template-columns: 100px 32px 130px minmax(0, 1fr) 170px;
    gap: 12px;
    align-items: center;
    padding: 0 16px;
  }
  .lh {
    height: 30px;
    font-size: var(--fs-xs);
    font-weight: 500;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--text-dim);
    border-bottom: 1px solid var(--line);
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
  }
  .row {
    width: 100%;
    height: 28px;
    border: 0;
    border-left: 2px solid transparent;
    background: none;
    color: var(--text);
    font: var(--fs-sm) var(--mono);
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
  .row.skel {
    pointer-events: none;
  }
  .row.skel .skeleton {
    height: 11px;
    display: block;
  }
  .row .t {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .row .c {
    color: var(--text-muted);
  }
  .row .x {
    color: var(--text-dim);
    font-size: var(--fs-xs);
  }
  .row.lvl-error .m {
    color: var(--danger-text);
  }
  .row.lvl-error .l {
    color: var(--danger);
    font-weight: 500;
  }
  .row.lvl-warn .l {
    color: var(--warning);
    font-weight: 500;
  }
  .row.lvl-info .l,
  .row.lvl-debug .l {
    color: var(--text-dim);
  }
  .empty {
    padding: 24px 16px;
    color: var(--text-dim);
  }
  .more {
    width: 100%;
    height: 40px;
    border: 0;
    border-top: 1px solid var(--line);
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  .more:hover {
    background: var(--row-hover);
  }

  .detail {
    width: 400px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--line);
    overflow-y: auto;
    background: var(--surface);
  }
  .dh {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px 10px 16px;
    border-bottom: 1px solid var(--line);
  }
  .dh b {
    font-weight: 500;
    color: var(--text-bright);
  }
  .dh .t {
    font: var(--fs-sm) var(--mono);
    color: var(--text-muted);
  }
  .badge {
    font: var(--fs-xs) var(--mono);
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--surface-2);
    color: var(--text-muted);
  }
  .badge.lvl-error {
    background: var(--danger-bg);
    color: var(--danger);
  }
  .badge.lvl-warn {
    background: var(--warning-bg);
    color: var(--warning);
  }
  .msg {
    margin: 0;
    padding: 14px 16px;
    font: var(--fs-sm) / 1.6 var(--mono);
    color: var(--text-bright);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    border-bottom: 1px solid var(--line);
  }
  .sh {
    padding: 14px 16px 6px;
    font-size: var(--fs-xs);
    font-weight: 500;
    color: var(--text-dim);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .fields {
    display: grid;
    grid-template-columns: 90px 1fr;
    gap: 6px 12px;
    padding: 0 16px 12px;
    font: var(--fs-sm) var(--mono);
  }
  .fk {
    color: var(--text-dim);
  }
  .fvv {
    color: var(--text-bright);
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    text-align: left;
    overflow-wrap: anywhere;
  }
  button.fvv {
    cursor: pointer;
  }
  button.fvv:hover {
    color: var(--accent);
    text-decoration: underline;
  }
  .related {
    padding: 0 8px 12px;
  }
  .rr {
    width: 100%;
    display: grid;
    grid-template-columns: 92px 8px minmax(0, 1fr);
    gap: 8px;
    align-items: center;
    height: 26px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font: var(--fs-sm) var(--mono);
    text-align: left;
    cursor: pointer;
  }
  .rr:hover,
  .rr.cur {
    background: var(--surface-2);
  }
  .rr .t {
    color: var(--text-dim);
  }
  .rr .m {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rr .dot {
    width: 7px;
    height: 7px;
  }
  .rr .dot.lvl-error {
    background: var(--danger);
  }
  .rr .dot.lvl-warn {
    background: var(--warning);
  }
  .actions {
    margin-top: auto;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 12px 16px;
    border-top: 1px solid var(--line);
  }

  @media (max-width: 1280px) {
    .lh,
    .row {
      grid-template-columns: 100px 32px 130px minmax(0, 1fr);
    }
    .ctxh,
    .row .x {
      display: none;
    }
  }
  /* With the detail open the message needs the room more than the context column does. */
  @media (max-width: 1700px) {
    .has-detail .lh,
    .has-detail .row {
      grid-template-columns: 100px 32px 130px minmax(0, 1fr);
    }
    .has-detail .ctxh,
    .has-detail .row .x {
      display: none;
    }
  }
  @media (max-width: 1100px) {
    .facets {
      display: none;
    }
  }
  @media (max-width: 768px) {
    .logs {
      height: auto;
      min-height: calc(100vh - var(--topbar-h));
    }
    .bar {
      padding: 10px 16px;
    }
    .qbar {
      flex-basis: 100%;
    }
    .hist {
      padding: 8px 16px 4px;
    }
    .legend {
      display: none;
    }
    .lh {
      grid-template-columns: minmax(0, 1fr);
      padding: 0 12px;
    }
    .lh > :not(:nth-child(4)) {
      display: none;
    }
    .scroll {
      min-height: 50vh;
    }
    .row {
      grid-template-columns: 72px 30px minmax(0, 1fr);
      height: auto;
      min-height: 30px;
      padding: 6px 12px;
    }
    .row .c {
      display: none;
    }
    .row .t {
      font-size: var(--fs-xs);
    }
    .body {
      flex-direction: column;
    }
    .detail {
      width: 100%;
      border-left: 0;
      border-top: 1px solid var(--line);
    }
  }
</style>
