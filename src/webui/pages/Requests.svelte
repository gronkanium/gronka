<script>
  import { Search, SlidersHorizontal, Inbox } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import PageHeader from '../components/PageHeader.svelte';
  import SaveView from '../components/SaveView.svelte';
  import DataTable from '../components/DataTable.svelte';
  import TimeRange from '../components/TimeRange.svelte';
  import Avatar from '../components/Avatar.svelte';
  import {
    formatBytes,
    formatDate,
    formatDateTime,
    formatDuration,
    formatRelativeTime,
    formatTime,
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
  // Column sorts map onto the API's named orders.
  const SORTS = {
    'time:true': 'newest',
    'time:false': 'oldest',
    'took:true': 'slowest',
    'took:false': 'fastest',
  };
  const STATUS = {
    success: ['ok', 'Delivered'],
    error: ['bad', 'Failed'],
    running: ['info', 'Running'],
    pending: ['idle', 'Queued'],
  };

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
  const sortState = $derived.by(() => {
    const hit = Object.entries(SORTS).find(([, v]) => v === sort);
    const [key, desc] = (hit?.[0] ?? 'time:true').split(':');
    return { key, desc: desc === 'true' };
  });
  const windowValue = $derived({
    range: get('dateFrom') ? '' : range === 'all' ? '' : range,
    startTime: get('dateFrom') || null,
    endTime: get('dateTo') || null,
  });

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
  function onrange(v) {
    go({ range: v.range || '', dateFrom: v.startTime || '', dateTo: v.endTime || '' });
  }
  function onsort(key, desc) {
    const s = SORTS[`${key}:${desc}`];
    if (s) go({ sort: s === 'newest' ? '' : s });
  }

  const moreActive = $derived(
    ['minDuration', 'maxDuration', 'minFileSize', 'maxFileSize'].filter(k => get(k)).length
  );
  const filtered = $derived(chips.length > 0 || moreActive > 0 || view !== 'all');
  const windowLabel = $derived(
    get('dateFrom') ? 'in this window' : RANGES[range] ? `in the last ${range}` : 'kept for 7 days'
  );
  const today = formatDate(Date.now());
  const dayOf = r => {
    const d = formatDate(r.timestamp);
    return d === today ? 'Today' : d;
  };

  const columns = [
    { key: 'st', label: 'Status', width: '100px' },
    { key: 'time', label: 'Time', width: '92px', sortable: true, sm: false },
    { key: 'type', label: 'Command', width: '84px', sm: false },
    { key: 'link', label: 'Link' },
    { key: 'user', label: 'User', width: '116px', sm: false },
    { key: 'size', label: 'Size', width: '76px', align: 'right', sm: false },
    { key: 'took', label: 'Took', width: '64px', align: 'right', sortable: true },
  ];
</script>

<PageHeader title="Requests" description="Every command the bot has run, {windowLabel}">
  {#snippet actions()}
    <TimeRange presets={RANGES} value={windowValue} onchange={onrange} allowAll defaultRange="" />
  {/snippet}
  {#snippet below()}
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
      <div class="qbar" role="search">
        <Search size={15} />
        {#each chips as [k, p, v] (k)}
          <button class="qchip" onclick={() => go({ [p]: '' })} title="remove">
            <span class="k">{k}:</span>{v}<span class="x">×</span>
          </button>
        {/each}
        <input
          bind:value={draft}
          onkeydown={onkey}
          placeholder={chips.length ? '' : 'Filter by link, user id, request id, type:download…'}
          aria-label="filter requests"
          spellcheck="false"
        />
      </div>
      <button
        class="btn"
        class:on={showMore || moreActive}
        onclick={() => (showMore = !showMore)}
        aria-expanded={showMore}
        ><SlidersHorizontal size={14} />Filters{#if moreActive}<span class="n">{moreActive}</span
          >{/if}</button
      >
      <SaveView page="requests" />
      <span class="count tnum"
        >{#if !loading || total}<b>{total.toLocaleString()}</b>
          {filtered ? 'matching' : 'requests'}{/if}</span
      >
    </div>
  {/snippet}
</PageHeader>

<div class="requests stack">
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
      <button class="btn ghost" onclick={() => navigate('requests', {})}>Clear all</button>
    </div>
  {/if}

  <DataTable
    {columns}
    {rows}
    {loading}
    {error}
    onretry={load}
    sort={sortState}
    {onsort}
    groupBy={dayOf}
    onrow={r => navigate('request', { requestId: r.id })}
    pager={{ offset, limit: PAGE, total, onpage: o => go({ offset: String(o) }) }}
    skeleton={12}
    label="requests"
  >
    {#snippet emptyState()}
      <div class="empty">
        <span class="ic"><Inbox size={20} /></span>
        <b>No requests match</b>
        {filtered ? 'Widen the time range or clear a filter' : 'Nothing has been run yet'}
        {#if filtered}<br /><button class="btn sm" onclick={() => navigate('requests', {})}
            >Clear filters</button
          >{/if}
      </div>
    {/snippet}
    {#snippet row(r)}
      {@const [kind, label] = STATUS[r.status] ?? ['idle', r.status]}
      <span><span class="pill sm {kind}">{label}</span></span>
      <span class="mono muted tnum hide-sm" title={formatDateTime(r.timestamp, { seconds: true })}
        >{formatTime(r.timestamp)}</span
      >
      <span class="soft hide-sm">/{r.type}</span>
      <span class="linkcell ellipsis">
        <span class="mono">{urlLabel(r.originalUrl)}</span>
        {#if r.status === 'error' && r.error}<span class="err" title={r.error}>· {r.error}</span
          >{/if}
      </span>
      <span class="user-cell hide-sm"
        ><Avatar id={r.userId} size={18} label="" /><span class="id">{shortId(r.userId)}</span
        ></span
      >
      <span class="num muted hide-sm">{r.fileSize ? formatBytes(r.fileSize) : '—'}</span>
      <span class="num muted" title={formatRelativeTime(r.timestamp)}
        >{r.performanceMetrics?.duration
          ? formatDuration(r.performanceMetrics.duration)
          : '—'}</span
      >
    {/snippet}
  </DataTable>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .count {
    margin-left: auto;
    font-size: var(--fs);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .count b {
    font-weight: 600;
    color: var(--text-bright);
  }
  .btn .n {
    font-size: 10px;
    font-weight: 600;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--accent-strong);
    color: var(--on-accent);
  }
  .more {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 16px;
    padding: 16px 20px;
  }
  .more label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-muted);
  }
  .more .field[type='number'] {
    width: 90px;
  }
  .linkcell {
    display: block;
  }
  .err {
    font-size: var(--fs-sm);
    color: var(--danger-text);
  }
</style>
