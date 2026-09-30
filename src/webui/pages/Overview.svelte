<script>
  import { ArrowUpRight } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { connected } from '../stores/sse-store.js';
  import { issueStates } from '../stores/nav.js';
  import { groupIssues, isOpen, KIND_LABEL } from '../issues.js';
  import {
    formatDuration,
    formatRelativeTime,
    shortId,
    hostOf,
    urlLabel,
  } from '../utils/format.js';
  import PageHeader from '../components/PageHeader.svelte';
  import Chart from '../components/Chart.svelte';
  import DataTable from '../components/DataTable.svelte';
  import Sparkline from '../components/Sparkline.svelte';
  import TimeRange from '../components/TimeRange.svelte';
  import Avatar from '../components/Avatar.svelte';

  const HOUR = 3600e3;
  // Span of the range, bucket size, and whether a previous period of equal length still exists
  // (retention keeps 7 days, so only ranges up to 24h can be compared).
  const RANGES = {
    '1h': { span: HOUR, bucket: 5 * 60e3, compare: true, label: 'previous hour' },
    '24h': { span: 24 * HOUR, bucket: HOUR, compare: true, label: 'previous 24h' },
    '7d': { span: 7 * 24 * HOUR, bucket: 6 * HOUR, compare: false },
  };
  const PRESETS = { '1h': 1, '24h': 24, '7d': 168 };
  const SERIES = [
    { key: 'ok', label: 'delivered', color: 'var(--chart-1)' },
    { key: 'fail', label: 'failed', color: 'var(--chart-4)' },
  ];
  const STATUS = {
    success: ['ok', 'Delivered'],
    error: ['bad', 'Failed'],
    running: ['info', 'Running'],
    pending: ['idle', 'Queued'],
  };

  let ops = $state([]);
  let stats = $state(null);
  let system = $state(null);
  let issues = $state([]);
  let loaded = $state(false);
  let now = $state(Date.now());

  const params = $derived($currentRoute.params);
  const absolute = $derived(!!params.$startTime);
  const rangeKey = $derived(RANGES[params.$range] ? params.$range : '24h');
  const range = $derived.by(() => {
    if (!absolute) return RANGES[rangeKey];
    const start = Number(params.$startTime);
    const end = Number(params.$endTime) || Date.now();
    const span = Math.max(60e3, end - start);
    const bucket = span <= 2 * HOUR ? 5 * 60e3 : span <= 2 * 24 * HOUR ? HOUR : 6 * HOUR;
    return { span, bucket, compare: false, start, end };
  });
  const windowValue = $derived({
    range: absolute ? '' : rangeKey,
    startTime: params.$startTime || null,
    endTime: params.$endTime || null,
  });

  async function load() {
    const t = Date.now();
    const end = range.end ?? t;
    const from = (range.start ?? t - range.span) - (range.compare ? range.span : 0);
    const get = url =>
      fetch(url)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null);
    const [req, st, sys, sum] = await Promise.all([
      get(`/api/requests?dateFrom=${from}&dateTo=${end}&limit=10000`),
      get('/api/stats'),
      get('/api/system'),
      get('/api/alerts/summary?reasonLimit=300'),
    ]);
    ops = req?.requests ?? [];
    stats = st;
    system = sys;
    issues = sum?.byReason ?? [];
    now = t;
    loaded = true;
  }

  $effect(() => {
    range;
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  });

  const winEnd = $derived(range.end ?? now);
  const winStart = $derived(range.start ?? now - range.span);
  const cur = $derived(ops.filter(o => o.timestamp >= winStart && o.timestamp <= winEnd));
  const prev = $derived(range.compare ? ops.filter(o => o.timestamp < winStart) : []);

  const finished = list => list.filter(o => o.status === 'success' || o.status === 'error');
  const successRate = list => {
    const f = finished(list);
    return f.length ? (f.filter(o => o.status === 'success').length / f.length) * 100 : null;
  };
  const durations = list =>
    list
      .filter(o => o.status === 'success' && o.performanceMetrics?.duration)
      .map(o => o.performanceMetrics.duration)
      .sort((a, b) => a - b);
  const pct = (sorted, p) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
  const users = list => new Set(list.map(o => o.userId)).size;

  const bars = $derived.by(() => {
    const n = Math.max(1, Math.round(range.span / range.bucket));
    const start =
      Math.floor(winStart / range.bucket) * range.bucket + (absolute ? 0 : range.bucket);
    const out = Array.from({ length: n }, (_, i) => ({
      at: start + i * range.bucket,
      ok: 0,
      fail: 0,
    }));
    for (const o of cur) {
      const b = out[Math.floor((o.timestamp - start) / range.bucket)];
      if (b) o.status === 'error' ? b.fail++ : b.ok++;
    }
    return out;
  });
  const sparkTotals = $derived(bars.map(b => b.ok + b.fail));
  const sparkFails = $derived(bars.map(b => b.fail));

  const kpis = $derived.by(() => {
    const c = cur;
    const p = prev;
    const cmp = range.compare && p.length > 0;
    const rateC = successRate(c);
    const rateP = successRate(p);
    const dC = durations(c);
    const dP = durations(p);
    const failed = c.filter(o => o.status === 'error').length;
    const reqDelta = cmp ? Math.round(((c.length - p.length) / p.length) * 100) : null;
    const medC = pct(dC, 0.5);
    const medP = pct(dP, 0.5);
    const workers = system?.jobs?.workers ?? [];
    const procs = (system?.jobs?.processes ?? []).filter(p => p.role === 'worker');
    const live = procs.filter(p => Date.now() - p.seen_at < 30_000).length;
    const running = system?.jobs?.counts?.running?.count ?? 0;
    const queued = system?.jobs?.counts?.queued?.count ?? 0;
    const lastJob = Math.max(0, ...workers.map(w => w.last_seen));
    const retried = Object.values(system?.jobs?.counts ?? {}).reduce(
      (s, x) => s + (x.retried || 0),
      0
    );
    const windowLabel = absolute ? 'in this window' : `last ${rangeKey}`;
    return [
      {
        k: 'Requests',
        v: c.length.toLocaleString(),
        d: reqDelta == null ? '' : `${reqDelta >= 0 ? '+' : ''}${reqDelta}%`,
        up: reqDelta == null || reqDelta >= 0,
        s: cmp ? `vs ${range.label}` : windowLabel,
        spark: sparkTotals,
        page: 'requests',
      },
      {
        k: 'Delivered',
        v: rateC == null ? '—' : `${rateC.toFixed(1)}%`,
        d:
          cmp && rateC != null && rateP != null
            ? `${rateC - rateP >= 0 ? '+' : ''}${(rateC - rateP).toFixed(1)}`
            : '',
        up: !(cmp && rateC < rateP),
        s: `${failed.toLocaleString()} failed`,
        spark: sparkFails,
        sparkColor: 'var(--chart-4)',
        page: 'requests',
        params: { status: 'error' },
      },
      {
        k: 'Median time',
        v: medC == null ? '—' : formatDuration(medC),
        d:
          cmp && medC != null && medP != null
            ? `${medC - medP <= 0 ? '-' : '+'}${(Math.abs(medC - medP) / 1000).toFixed(1)}s`
            : '',
        up: !(cmp && medC > medP),
        s: `p95 ${pct(dC, 0.95) == null ? '—' : formatDuration(pct(dC, 0.95))}`,
        page: 'requests',
        params: { minDuration: '10000' },
      },
      {
        k: 'Active users',
        v: users(c).toLocaleString(),
        d: cmp ? `${users(c) - users(p) >= 0 ? '+' : ''}${users(c) - users(p)}` : '',
        up: !(cmp && users(c) < users(p)),
        s: stats ? `${stats.active_users_7d.toLocaleString()} this week` : '',
        page: 'users',
      },
      system?.mediaWorkers === false
        ? { k: 'Workers', v: 'in bot', d: '', up: true, s: 'MEDIA_WORKERS=false', page: 'system' }
        : {
            k: 'Workers',
            v: procs.length ? `${live} / ${procs.length}` : '—',
            d: !procs.length
              ? ''
              : live < procs.length
                ? 'not reporting'
                : running
                  ? `${running} running`
                  : 'healthy',
            up: live === procs.length,
            s: lastJob ? `last job ${formatRelativeTime(lastJob)}` : 'no jobs yet',
            page: 'system',
          },
      {
        k: 'Queue',
        v: String(queued),
        d: system?.jobs?.paused ? 'paused' : queued ? 'waiting' : 'clear',
        up: !system?.jobs?.paused && queued === 0,
        s: `${retried} retried in 24h`,
        page: 'system',
      },
    ];
  });

  const recent = $derived([...ops].sort((a, b) => b.timestamp - a.timestamp).slice(0, 8));

  const sources = $derived.by(() => {
    const map = new Map();
    for (const o of finished(cur)) {
      const host = hostOf(o.originalUrl) ?? 'attachment';
      const s = map.get(host) ?? { name: host, n: 0, ok: 0 };
      s.n++;
      if (o.status === 'success') s.ok++;
      map.set(host, s);
    }
    const max = Math.max(1, ...[...map.values()].map(s => s.n));
    return [...map.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 8)
      .map(s => ({ ...s, rate: Math.round((s.ok / s.n) * 100), share: s.n / max }));
  });

  const openIssues = $derived(
    groupIssues(issues)
      .filter(g => isOpen(g, $issueStates))
      .slice(0, 5)
  );

  const bucketLabel = $derived(
    range.bucket >= HOUR * 6 ? '6 hours' : range.bucket >= HOUR ? 'hour' : '5 minutes'
  );

  function onrange(v) {
    navigate(
      'dashboard',
      v.startTime
        ? { startTime: v.startTime, ...(v.endTime ? { endTime: v.endTime } : {}) }
        : v.range === '24h'
          ? {}
          : { range: v.range }
    );
  }
  // Brushing the chart opens the requests list for exactly that window.
  const onbrush = (s, e) => navigate('requests', { dateFrom: String(s), dateTo: String(e) });
</script>

<PageHeader
  title="Overview"
  description="How the bot is doing right now: volume, delivery rate, speed and what needs attention."
>
  {#snippet actions()}
    <span class="pill" class:ok={$connected} class:idle={!$connected}
      >{$connected ? 'Live' : 'Reconnecting'}</span
    >
    <TimeRange presets={PRESETS} value={windowValue} onchange={onrange} defaultRange="24h" />
  {/snippet}
</PageHeader>

<div class="overview stack">
  <section class="kpis" aria-label="key numbers">
    {#each kpis as k (k.k)}
      <button class="kpi clickable" onclick={() => navigate(k.page, k.params ?? {})}>
        <div class="k">{k.k}</div>
        <div class="v">
          {#if loaded}{k.v}{:else}<span class="skeleton">0000</span>{/if}
          {#if loaded && k.d}<span class="d" class:up={k.up} class:down={!k.up}>{k.d}</span>{/if}
        </div>
        <div class="s">{loaded ? k.s : ' '}</div>
        {#if loaded && k.spark}
          <span class="spark"
            ><Sparkline
              values={k.spark}
              width={80}
              height={24}
              type="line"
              color={k.sparkColor ?? 'var(--chart-1)'}
            /></span
          >
        {/if}
      </button>
    {/each}
  </section>

  <div class="two wide-left">
    <section class="panel" aria-label="requests over time">
      <div class="ph">
        <span>Requests per {bucketLabel}</span>
        <span class="meta">
          {#each SERIES as s (s.key)}
            <span class="legend"><i style="background:{s.color}"></i>{s.label}</span>
          {/each}
        </span>
      </div>
      <div class="chart">
        <Chart
          type="area"
          series={SERIES}
          data={bars}
          bucket={range.bucket}
          height={240}
          {onbrush}
          brushHint="drag to open that window in Requests"
        />
      </div>
    </section>

    <section class="panel" aria-label="open issues">
      <div class="ph">
        <span>Open issues</span>
        <button class="linkish meta" onclick={() => navigate('issues')}
          >View all <ArrowUpRight size={13} /></button
        >
      </div>
      {#each openIssues as i (i.key)}
        <button class="lrow issue" onclick={() => navigate('issues', { issue: i.key })}>
          <span class="n">{i.count}</span>
          <span class="grow">
            <span class="t ellipsis">{i.title}</span>
            <span class="m"
              ><span class="chip {i.kind}">{KIND_LABEL[i.kind]}</span>{i.commands
                .map(c => `/${c}`)
                .join(', ')} · {formatRelativeTime(i.lastSeen)}</span
            >
          </span>
        </button>
      {:else}
        <div class="empty">
          {#if loaded}<b>All clear</b>no failures in the last 7 days{:else}loading…{/if}
        </div>
      {/each}
    </section>
  </div>

  <div class="two wide-left">
    <DataTable
      title="Recent requests"
      columns={[
        { key: 'st', label: 'status', width: '100px' },
        { key: 'type', label: 'command', width: '84px', sm: false },
        { key: 'link', label: 'link' },
        { key: 'user', label: 'user', width: '120px', sm: false },
        { key: 'took', label: 'took', width: '64px', align: 'right', sm: false },
        { key: 'when', label: 'when', width: '76px', align: 'right' },
      ]}
      rows={recent}
      loading={!loaded}
      empty="no requests yet"
      onrow={r => navigate('request', { requestId: r.id })}
    >
      {#snippet header()}
        <button class="linkish" onclick={() => navigate('requests')}
          >All requests <ArrowUpRight size={13} /></button
        >
      {/snippet}
      {#snippet row(r)}
        {@const [kind, label] = STATUS[r.status] ?? ['idle', r.status]}
        <span><span class="pill sm {kind}">{label}</span></span>
        <span class="soft hide-sm">/{r.type}</span>
        <span class="mono ellipsis">{urlLabel(r.originalUrl)}</span>
        <span class="user-cell hide-sm"
          ><Avatar id={r.userId} size={20} /><span class="id">{shortId(r.userId)}</span></span
        >
        <span class="num muted hide-sm"
          >{r.performanceMetrics?.duration
            ? formatDuration(r.performanceMetrics.duration)
            : '—'}</span
        >
        <span class="num dim">{formatRelativeTime(r.timestamp)}</span>
      {/snippet}
    </DataTable>

    <section class="panel" aria-label="sources">
      <div class="ph">
        <span>Sources</span>
        <span class="meta"><span class="dim">requests · delivered</span></span>
      </div>
      <div class="sources">
        {#each sources as s (s.name)}
          <button
            class="src"
            onclick={() =>
              navigate('requests', { urlPattern: s.name === 'attachment' ? '' : s.name })}
          >
            <span class="ellipsis name">{s.name}</span>
            <span class="bar-track"
              ><span
                style="width:{s.share * 100}%; background:{s.rate >= 90
                  ? 'var(--chart-1)'
                  : s.rate >= 70
                    ? 'var(--chart-3)'
                    : 'var(--chart-4)'}"
              ></span></span
            >
            <span class="num muted">{s.n}</span>
            <span
              class="num"
              class:ok-text={s.rate >= 90}
              class:warn-text={s.rate < 90 && s.rate >= 70}
              class:error-text={s.rate < 70}>{s.rate}%</span
            >
          </button>
        {:else}
          <div class="empty">{loaded ? 'nothing yet' : 'loading…'}</div>
        {/each}
      </div>
    </section>
  </div>
</div>

<style>
  .legend {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .legend i {
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
  .chart {
    padding: 18px 16px 10px 8px;
  }
  .issue .n {
    min-width: 36px;
    height: 24px;
    padding: 0 8px;
    display: inline-grid;
    place-items: center;
    border-radius: 6px;
    background: var(--card-3);
    font: 600 var(--fs-sm) var(--mono);
    color: var(--text-bright);
    font-variant-numeric: tabular-nums;
  }
  .issue .t {
    display: block;
    font-size: var(--fs);
    font-weight: 500;
    color: var(--text-bright);
  }
  .issue .m {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }
  .sources {
    padding: 8px 12px 12px;
  }
  .src {
    width: 100%;
    display: grid;
    grid-template-columns: 120px 1fr 44px 44px;
    align-items: center;
    gap: 12px;
    height: 36px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font: inherit;
    font-size: var(--fs);
    text-align: left;
    cursor: pointer;
  }
  .src .name {
    font-weight: 500;
  }
  .src:hover {
    background: var(--row-hover);
  }
  .src .bar-track {
    height: 6px;
  }
</style>
