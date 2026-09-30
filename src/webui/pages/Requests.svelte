<script>
  import { onDestroy } from 'svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { headerActions } from '../stores/header.js';
  import SaveView from '../components/SaveView.svelte';
  import {
    formatBytes,
    formatDuration,
    formatRelativeTime,
    shortId,
    urlLabel,
  } from '../utils/format.js';

  // Query-bar keys and the /api/requests parameter each one maps to.
  const KEYS = {
    status: 'status',
    type: 'type',
    user: 'userId',
    url: 'urlPattern',
    op: 'operationId',
  };
  const PARAM_KEYS = [
    'status',
    'type',
    'userId',
    'urlPattern',
    'operationId',
    'earlyFailureOnly',
    'minDuration',
    'maxDuration',
    'minFileSize',
    'maxFileSize',
    'dateFrom',
    'dateTo',
  ];
  const RANGES = { '1h': 1, '24h': 24, '7d': 168 };
  const VIEWS = [
    ['all', 'All', {}],
    ['failed', 'Failed', { status: 'error' }],
    ['slow', 'Slower than 10 s', { minDuration: '10000' }],
    ['early', 'Early failures', { earlyFailureOnly: 'true' }],
  ];
  const PAGE = 50;

  let rows = $state([]);
  let total = $state(0);
  let loading = $state(true);
  let error = $state('');
  let draft = $state('');
  let showMore = $state(false);

  const params = $derived($currentRoute.params);
  const get = k => params[`$${k}`] || '';
  const range = $derived(get('range') || 'all');
  const sort = $derived(get('sort') || 'newest');
  const offset = $derived(Number(get('offset')) || 0);
  const view = $derived(
    VIEWS.find(
      ([, , p]) => Object.keys(p).length && Object.entries(p).every(([k, v]) => get(k) === v)
    )?.[0] ?? 'all'
  );

  function go(changes) {
    const next = {};
    for (const [k, v] of Object.entries(params)) if (k.startsWith('$')) next[k.slice(1)] = v;
    Object.assign(next, { offset: '' }, changes);
    for (const k of Object.keys(next)) if (!next[k]) delete next[k];
    navigate('requests', next);
  }

  function query() {
    const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort });
    for (const k of PARAM_KEYS) if (get(k)) q.set(k, get(k));
    if (RANGES[range] && !get('dateFrom'))
      q.set('dateFrom', String(Date.now() - RANGES[range] * 3600e3));
    return q;
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const r = await fetch(`/api/requests?${query()}`);
      if (!r.ok) throw new Error();
      const data = await r.json();
      rows = data.requests ?? [];
      total = data.total ?? 0;
    } catch {
      error = 'could not load requests';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    query();
    load();
  });

  const chips = $derived(
    Object.entries(KEYS)
      .filter(([, p]) => get(p))
      .map(([k, p]) => [k, p, get(p)])
  );

  function commit() {
    const text = draft.trim();
    if (!text) return;
    const m = text.match(/^(\w+):(.+)$/);
    if (m && KEYS[m[1]]) go({ [KEYS[m[1]]]: m[2] });
    else if (/^\d{15,20}$/.test(text)) go({ userId: text });
    else if (/^\d{13}-[0-9a-f]{6,}$/i.test(text)) go({ operationId: text });
    else go({ urlPattern: text });
    draft = '';
  }

  function onkey(e) {
    if (e.key === 'Enter') commit();
    if (e.key === 'Backspace' && !draft && chips.length) go({ [chips.at(-1)[1]]: '' });
  }

  const mb = v => (v ? String(Math.round(Number(v) / 1048576)) : '');
  const secs = v => (v ? String(Math.round(Number(v) / 1000)) : '');

  function setRange(key, value, scale) {
    const n = Number(value);
    go({
      [key]: value === '' || !Number.isFinite(n) || n <= 0 ? '' : String(Math.round(n * scale)),
    });
  }

  const time = t =>
    new Date(t).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

  headerActions.set(actions);
  onDestroy(() => headerActions.set(null));
</script>

{#snippet actions()}
  <div class="seg" role="group" aria-label="time range">
    {#each [...Object.keys(RANGES), 'all'] as r (r)}
      <button class:on={range === r} onclick={() => go({ range: r === 'all' ? '' : r })}>{r}</button
      >
    {/each}
  </div>
{/snippet}

<div class="requests stack">
  <div class="toolbar">
    <div class="seg" role="group" aria-label="quick views">
      {#each VIEWS as [id, label, p] (id)}
        <button
          class:on={view === id}
          onclick={() => go({ status: '', minDuration: '', earlyFailureOnly: '', ...p })}
          >{label}</button
        >
      {/each}
    </div>
    <div class="query" role="search">
      {#each chips as [k, p, v] (k)}
        <button class="qchip" onclick={() => go({ [p]: '' })} title="remove">
          <span class="k">{k}:</span>{v}<span class="x">×</span>
        </button>
      {/each}
      <input
        bind:value={draft}
        onkeydown={onkey}
        placeholder={chips.length
          ? ''
          : 'paste a link, user id or request id, or type:download, status:error'}
        aria-label="filter requests"
        spellcheck="false"
      />
    </div>
    <button
      class="btn"
      class:on={showMore}
      onclick={() => (showMore = !showMore)}
      aria-expanded={showMore}>More filters</button
    >
    <select
      class="field"
      value={sort}
      onchange={e => go({ sort: e.currentTarget.value === 'newest' ? '' : e.currentTarget.value })}
      aria-label="sort"
    >
      <option value="newest">Newest first</option>
      <option value="oldest">Oldest first</option>
      <option value="slowest">Slowest first</option>
      <option value="fastest">Fastest first</option>
    </select>
    <SaveView page="requests" />
  </div>

  {#if showMore}
    <div class="panel more">
      <label
        >Duration, seconds
        <span class="row">
          <input
            class="field"
            type="number"
            min="0"
            placeholder="min"
            value={secs(get('minDuration'))}
            onchange={e => setRange('minDuration', e.currentTarget.value, 1000)}
          />
          <span class="dim">to</span>
          <input
            class="field"
            type="number"
            min="0"
            placeholder="max"
            value={secs(get('maxDuration'))}
            onchange={e => setRange('maxDuration', e.currentTarget.value, 1000)}
          />
        </span>
      </label>
      <label
        >File size, MB
        <span class="row">
          <input
            class="field"
            type="number"
            min="0"
            placeholder="min"
            value={mb(get('minFileSize'))}
            onchange={e => setRange('minFileSize', e.currentTarget.value, 1048576)}
          />
          <span class="dim">to</span>
          <input
            class="field"
            type="number"
            min="0"
            placeholder="max"
            value={mb(get('maxFileSize'))}
            onchange={e => setRange('maxFileSize', e.currentTarget.value, 1048576)}
          />
        </span>
      </label>
      <label
        >Command
        <select
          class="field"
          value={get('type')}
          onchange={e => go({ type: e.currentTarget.value })}
        >
          <option value="">any</option>
          <option value="download">download</option>
          <option value="convert">convert</option>
          <option value="optimize">optimize</option>
        </select>
      </label>
      <label
        >Status
        <select
          class="field"
          value={get('status')}
          onchange={e => go({ status: e.currentTarget.value })}
        >
          <option value="">any</option>
          <option value="success">delivered</option>
          <option value="error">failed</option>
          <option value="running">running</option>
          <option value="pending">pending</option>
        </select>
      </label>
      <button class="btn" onclick={() => navigate('requests', {})}>Clear all</button>
    </div>
  {/if}

  <section
    class="panel tbl"
    aria-label="requests"
    style="--cols: 12px 132px 76px minmax(0, 1fr) 96px 70px 64px"
  >
    <div class="tr head">
      <span></span><span>time</span><span>command</span><span>link</span><span>user</span>
      <span class="num">size</span><span class="num">took</span>
    </div>
    {#if error}
      <div class="empty error-text">
        {error} <button class="btn sm" onclick={load}>retry</button>
      </div>
    {:else if !rows.length}
      <div class="empty">{loading ? 'loading…' : 'no requests match'}</div>
    {/if}
    {#each rows as r (r.id)}
      <button class="tr" onclick={() => navigate('request', { requestId: r.id })}>
        <span
          class="dot"
          class:ok={r.status === 'success'}
          class:bad={r.status === 'error'}
          class:run={r.status === 'running' || r.status === 'pending'}
          title={r.status}
        ></span>
        <span class="mono small muted" title={formatRelativeTime(r.timestamp)}
          >{time(r.timestamp)}</span
        >
        <span class="muted">{r.type}</span>
        <span class="linkcell">
          <span class="mono small ellipsis">{urlLabel(r.originalUrl)}</span>
          {#if r.status === 'error' && r.error}<span class="err ellipsis">{r.error}</span>{/if}
        </span>
        <span class="mono small muted">{shortId(r.userId)}</span>
        <span class="num small muted">{r.fileSize ? formatBytes(r.fileSize) : '—'}</span>
        <span class="num small muted"
          >{r.performanceMetrics?.duration
            ? formatDuration(r.performanceMetrics.duration)
            : '—'}</span
        >
      </button>
    {/each}
    <div class="pager">
      <span class="dim"
        >{total
          ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total.toLocaleString()}`
          : ''}</span
      >
      <span class="row">
        <button
          class="btn sm"
          disabled={offset === 0}
          onclick={() => go({ offset: String(Math.max(0, offset - PAGE)) })}>Previous</button
        >
        <button
          class="btn sm"
          disabled={offset + PAGE >= total}
          onclick={() => go({ offset: String(offset + PAGE) })}>Next</button
        >
      </span>
    </div>
  </section>
</div>

<style>
  .requests {
    max-width: 1400px;
    margin: 0 auto;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .query {
    flex: 1;
    min-width: 260px;
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
    min-width: 160px;
    background: none;
    border: 0;
    outline: 0;
    color: var(--text-bright);
    font: 13px var(--mono);
  }
  .query input::placeholder {
    color: var(--text-dim);
  }
  .qchip {
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
  .qchip .k {
    color: var(--accent);
  }
  .qchip .x {
    margin-left: 6px;
    color: var(--text-dim);
  }
  .btn.on {
    border-color: var(--border-2);
    color: var(--text-bright);
  }
  .more {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 16px;
    padding: 14px 16px;
  }
  .more label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .more .field[type='number'] {
    width: 90px;
  }
  .small {
    font-size: 12px;
  }
  .linkcell {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 6px 0;
  }
  .err {
    font-size: 12px;
    color: #e9a3a3;
  }
  .pager {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-top: 1px solid var(--line);
    font-size: 12px;
  }
  @media (max-width: 760px) {
    .tbl {
      --cols: 10px minmax(0, 1fr) 60px !important;
    }
    .tbl .tr > :nth-child(2),
    .tbl .tr > :nth-child(3),
    .tbl .tr > :nth-child(5),
    .tbl .tr > :nth-child(6) {
      display: none;
    }
  }
</style>
