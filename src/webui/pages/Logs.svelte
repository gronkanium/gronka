<script>
  import { untrack } from 'svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { logs as liveLogs } from '../stores/sse-store.js';
  import SaveView from '../components/SaveView.svelte';

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

  let rows = $state([]);
  let total = $state(0);
  let facets = $state({});
  let histogram = $state(null);
  let loading = $state(true);
  let error = $state('');
  let selected = $state(null);
  let related = $state([]);
  let draft = $state('');
  let drag = $state(null);
  let histEl = $state();

  // The URL is the only filter state: facet clicks, the query bar and the palette all navigate.
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
        get(`/api/logs/histogram?${query({ buckets: 60 })}`),
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

  const time = t =>
    new Date(t).toLocaleTimeString([], { hour12: false }) + '.' + String(t % 1000).padStart(3, '0');
  const stamp = t =>
    new Date(t).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  const day = t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const lvl = l => ({ ERROR: 'ERR', WARN: 'WRN', INFO: 'INF', DEBUG: 'DBG' })[l] || l;

  const bars = $derived.by(() => {
    if (!histogram?.buckets) return [];
    const max = Math.max(1, ...histogram.buckets.map(b => b.ERROR + b.WARN + b.INFO + b.DEBUG));
    return histogram.buckets.map((b, i) => ({
      at: histogram.start + i * histogram.size,
      err: (b.ERROR / max) * 100,
      warn: (b.WARN / max) * 100,
      info: ((b.INFO + b.DEBUG) / max) * 100,
      title: `${stamp(histogram.start + i * histogram.size)} · ${b.ERROR} err · ${b.WARN} warn · ${b.INFO + b.DEBUG} info`,
    }));
  });

  function bucketAt(e) {
    const r = histEl.getBoundingClientRect();
    return Math.min(
      bars.length - 1,
      Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * bars.length))
    );
  }
  function endDrag() {
    if (!drag) return;
    const [a, b] = [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)];
    drag = null;
    if (!histogram) return;
    go({
      range: '',
      startTime: String(histogram.start + a * histogram.size),
      endTime: String(histogram.start + (b + 1) * histogram.size),
      live: '',
    });
  }

  function exportRows() {
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `gronka-logs-${Date.now()}.json`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const chips = $derived(Object.entries(filters).flatMap(([k, vs]) => vs.map(v => [k, v])));
  const zoomed = $derived(!!params.$startTime);
</script>

<div class="logs">
  <div class="bar">
    <div class="query" role="search">
      {#each chips as [key, value] (key + value)}
        <button class="chip" onclick={() => toggle(key, value)} title="remove">
          <span class="k">{key}:</span>{value}<span class="x">×</span>
        </button>
      {/each}
      {#if search}
        <button class="chip text" onclick={() => go({ search: '' })} title="remove">
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
    <div class="seg" role="group" aria-label="time range">
      {#each Object.keys(RANGES) as r (r)}
        <button
          class:on={range === r && !zoomed}
          onclick={() => go({ range: r, startTime: '', endTime: '' })}>{r}</button
        >
      {/each}
    </div>
    <button
      class="btn"
      class:live
      onclick={() => go({ live: live ? '' : '1', endTime: '' })}
      title="stream new lines as they are written"
    >
      <span class="dot"></span>Live tail
    </button>
    <SaveView page="logs" />
    <button class="btn" onclick={exportRows} disabled={!rows.length}>Export</button>
  </div>

  <div class="hist-wrap">
    <div
      class="hist"
      bind:this={histEl}
      role="slider"
      aria-label="drag to zoom the time range"
      aria-valuenow={0}
      tabindex="-1"
      onmousedown={e => (drag = { from: bucketAt(e), to: bucketAt(e) })}
      onmousemove={e => drag && (drag.to = bucketAt(e))}
      onmouseup={endDrag}
      onmouseleave={endDrag}
    >
      {#each bars as b, i (i)}
        <div
          class="col"
          class:sel={drag && i >= Math.min(drag.from, drag.to) && i <= Math.max(drag.from, drag.to)}
          title={b.title}
        >
          <span class="err" style="height:{b.err}%"></span>
          <span class="warn" style="height:{b.warn}%"></span>
          <span class="info" style="height:{b.info}%"></span>
        </div>
      {/each}
    </div>
    <div class="axis">
      <span>{histogram ? stamp(histogram.start) : ''}</span>
      <span class="hint">
        {#if zoomed}
          <button class="link" onclick={() => go({ startTime: '', endTime: '', range: '24h' })}
            >reset zoom</button
          >
        {:else}drag to zoom{/if}
      </span>
      <span>{endTime ? stamp(endTime) : 'now'}</span>
    </div>
  </div>

  <div class="body">
    <aside class="facets" aria-label="filters">
      {#each FACETS as [key, label] (key)}
        {#if facets[key]?.length}
          <div class="fh">{label}</div>
          {#each facets[key] as f (f.value)}
            {@const on = filters[key]?.includes(f.value)}
            <button class="fv" class:on onclick={() => toggle(key, f.value)}>
              <span class="box lvl-{key === 'level' ? f.value.toLowerCase() : ''}" class:on></span>
              <span class="fname">{key === 'level' ? f.value.toLowerCase() : f.value}</span>
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
        <span>time</span><span>lvl</span><span>component</span>
        <span
          >message · {rows.length.toLocaleString()} of {total.toLocaleString()}{loading
            ? ' · loading'
            : ''}</span
        >
      </div>
      <div class="scroll" class:busy={loading}>
        {#if error}
          <div class="empty">{error} <button class="link" onclick={load}>retry</button></div>
        {:else if !rows.length && !loading}
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
            <span class="c">{r.component}</span>
            <span class="m">{r.message}</span>
          </button>
        {/each}
        {#if rows.length < total}
          <button class="more" onclick={more}
            >load {Math.min(PAGE, total - rows.length)} more</button
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
          <button class="x" onclick={() => (selected = null)} aria-label="close">×</button>
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
            <button class="btn" onclick={() => navigate('logs', { op: selected.metadata.op })}
              >Only this request</button
            >
          {/if}
          <button
            class="btn"
            onclick={() =>
              navigate('logs', {
                startTime: String(selected.timestamp - 30000),
                endTime: String(selected.timestamp + 30000),
              })}>Lines around this</button
          >
          <button class="btn" onclick={() => navigator.clipboard?.writeText(selected.message)}
            >Copy</button
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
    height: calc(100vh - 56px);
    min-width: 0;
    font-size: 13px;
  }
  .bar {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 12px 24px;
    border-bottom: 1px solid var(--line);
  }
  .query {
    flex: 1;
    min-height: 34px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .query:focus-within {
    border-color: var(--border-2);
  }
  .query input {
    flex: 1;
    min-width: 120px;
    background: none;
    text-overflow: ellipsis;
    border: 0;
    outline: 0;
    color: var(--text-bright);
    font: 13px var(--mono);
  }
  .query input::placeholder {
    color: var(--text-dim);
  }
  .chip {
    height: 24px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font: 12px var(--mono);
    color: var(--text-bright);
    background: var(--info-bg);
    border: 1px solid #2b3350;
    border-radius: 6px;
    cursor: pointer;
  }
  .chip.text {
    background: var(--surface-2);
    border-color: var(--border-2);
  }
  .chip .k {
    color: var(--accent);
  }
  .chip .x {
    margin-left: 6px;
    color: var(--text-dim);
  }
  .seg {
    display: flex;
    gap: 2px;
    padding: 2px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .seg button {
    height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .seg button.on {
    background: var(--surface-3);
    color: var(--text-bright);
  }
  .btn {
    height: 32px;
    padding: 0 12px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--border-2);
  }
  .btn:disabled {
    opacity: 0.5;
  }
  .btn .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-dim);
  }
  .btn.live {
    border-color: #1f5a41;
    color: var(--text-bright);
  }
  .btn.live .dot {
    background: var(--success);
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  .link {
    background: none;
    border: 0;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
    padding: 0;
  }

  .hist-wrap {
    padding: 10px 24px 6px;
    border-bottom: 1px solid var(--line);
  }
  .hist {
    height: 64px;
    display: flex;
    align-items: flex-end;
    gap: 2px;
    cursor: crosshair;
    user-select: none;
  }
  .col {
    flex: 1;
    height: 100%;
    display: flex;
    flex-direction: column-reverse;
    border-radius: 2px;
  }
  .col.sel {
    background: rgba(143, 167, 245, 0.14);
  }
  .col span {
    display: block;
    min-height: 0;
  }
  .col .info {
    background: #33405f;
  }
  .col .warn {
    background: var(--warning);
  }
  .col .err {
    background: var(--danger);
  }
  .col span:last-child {
    border-radius: 2px 2px 0 0;
  }
  .axis {
    display: flex;
    justify-content: space-between;
    padding-top: 4px;
    font: 11px var(--mono);
    color: var(--text-dim);
  }

  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .facets {
    width: 236px;
    flex-shrink: 0;
    overflow-y: auto;
    padding: 8px 10px 16px;
    border-right: 1px solid var(--line);
  }
  .fh {
    padding: 12px 8px 4px;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .fv {
    width: 100%;
    height: 28px;
    padding: 0 8px;
    display: flex;
    align-items: center;
    gap: 9px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .fv:hover,
  .fv.on {
    background: var(--surface-2);
  }
  .box {
    width: 11px;
    height: 11px;
    border-radius: 3px;
    border: 1.5px solid var(--border-2);
    flex-shrink: 0;
  }
  .box.on {
    background: var(--accent);
    border-color: var(--accent);
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
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fcount {
    font: 11px var(--mono);
    color: var(--text-dim);
  }
  .note {
    margin: 14px 8px;
    font-size: 12px;
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
    grid-template-columns: 110px 38px 140px minmax(0, 1fr);
    gap: 12px;
    align-items: center;
    padding: 0 16px;
  }
  .lh {
    height: 32px;
    font: 11px var(--mono);
    color: var(--text-dim);
    border-bottom: 1px solid var(--line);
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    transition: opacity 0.15s;
  }
  .scroll.busy {
    opacity: 0.45;
  }
  .row {
    width: 100%;
    height: 30px;
    border: 0;
    border-left: 2px solid transparent;
    background: none;
    color: var(--text);
    font: 12px var(--mono);
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--surface);
  }
  .row.sel {
    background: var(--surface-2);
    border-left-color: var(--accent);
  }
  .row .t {
    color: var(--text-muted);
  }
  .row .c {
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row .m {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row.lvl-error .l,
  .row.lvl-error .m {
    color: #f4b4b4;
  }
  .row.lvl-error .l {
    color: var(--danger);
  }
  .row.lvl-warn .l {
    color: var(--warning);
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
    cursor: pointer;
  }

  .detail {
    width: 380px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--line);
    overflow-y: auto;
  }
  .dh {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--line);
  }
  .dh .t {
    font: 12px var(--mono);
    color: var(--text-muted);
  }
  .dh .x {
    margin-left: auto;
    background: none;
    border: 0;
    color: var(--text-dim);
    font-size: 18px;
    cursor: pointer;
  }
  .badge {
    font: 11px var(--mono);
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
    font: 12px/1.6 var(--mono);
    color: var(--text-bright);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    border-bottom: 1px solid var(--line);
  }
  .sh {
    padding: 14px 16px 6px;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .fields {
    display: grid;
    grid-template-columns: 90px 1fr;
    gap: 6px 12px;
    padding: 0 16px 12px;
    font: 12px var(--mono);
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
    border-radius: 5px;
    background: none;
    color: var(--text);
    font: 12px var(--mono);
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
    border-radius: 50%;
    background: var(--text-dim);
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
    gap: 8px;
    padding: 14px 16px;
    border-top: 1px solid var(--line);
  }

  @media (max-width: 1100px) {
    .facets {
      display: none;
    }
  }
  @media (max-width: 768px) {
    .logs {
      height: auto;
      min-height: calc(100vh - 56px);
    }
    .bar {
      flex-wrap: wrap;
      padding: 10px 16px;
    }
    .query {
      flex-basis: 100%;
    }
    .hist-wrap {
      padding: 8px 16px 4px;
    }
    .lh {
      grid-template-columns: minmax(0, 1fr);
      padding: 0 12px;
    }
    .lh > :not(:last-child) {
      display: none;
    }
    .query input {
      font-size: 16px;
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
      font-size: 11px;
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
