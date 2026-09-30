<script>
  import { onDestroy } from 'svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { connected } from '../stores/sse-store.js';
  import { headerActions } from '../stores/header.js';
  import {
    formatDuration,
    formatRelativeTime,
    shortId,
    hostOf,
    urlLabel,
  } from '../utils/format.js';

  const HOUR = 3600e3;
  // span of the range, bucket size, and whether a previous period of equal length still exists
  // (retention keeps 7 days, so only ranges up to 24h can be compared).
  const RANGES = {
    '1h': { span: HOUR, bucket: 5 * 60e3, compare: true, label: 'previous hour' },
    '24h': { span: 24 * HOUR, bucket: HOUR, compare: true, label: 'previous 24h' },
    '7d': { span: 7 * 24 * HOUR, bucket: 6 * HOUR, compare: false },
  };

  let ops = $state([]);
  let stats = $state(null);
  let system = $state(null);
  let issues = $state([]);
  let loaded = $state(false);
  let now = $state(Date.now());

  const rangeKey = $derived(
    RANGES[$currentRoute.params.$range] ? $currentRoute.params.$range : '24h'
  );
  const range = $derived(RANGES[rangeKey]);

  async function load() {
    const t = Date.now();
    const from = t - (range.compare ? 2 : 1) * range.span;
    const get = url =>
      fetch(url)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null);
    const [req, st, sys, sum] = await Promise.all([
      get(`/api/requests?dateFrom=${from}&limit=10000`),
      get('/api/stats'),
      get('/api/system'),
      get('/api/alerts/summary'),
    ]);
    ops = req?.requests ?? [];
    stats = st;
    system = sys;
    issues = sum?.byReason ?? [];
    now = t;
    loaded = true;
  }

  $effect(() => {
    rangeKey;
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  });

  const cur = $derived(ops.filter(o => o.timestamp >= now - range.span));
  const prev = $derived(range.compare ? ops.filter(o => o.timestamp < now - range.span) : []);

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
    return [
      {
        k: 'Requests',
        v: c.length.toLocaleString(),
        d: reqDelta == null ? '' : `${reqDelta >= 0 ? '+' : ''}${reqDelta}%`,
        up: reqDelta == null || reqDelta >= 0,
        s: cmp ? `vs ${range.label}` : `last ${rangeKey}`,
      },
      {
        k: 'Delivered',
        v: rateC == null ? '—' : `${rateC.toFixed(1)}%`,
        d:
          cmp && rateC != null && rateP != null
            ? `${rateC - rateP >= 0 ? '+' : ''}${(rateC - rateP).toFixed(1)}`
            : '',
        up: !(cmp && rateC < rateP),
        s: `${failed} failed`,
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
      },
      {
        k: 'Active users',
        v: users(c).toLocaleString(),
        d: cmp ? `${users(c) - users(p) >= 0 ? '+' : ''}${users(c) - users(p)}` : '',
        up: !(cmp && users(c) < users(p)),
        s: stats ? `${stats.active_users_7d.toLocaleString()} this week` : '',
      },
      system?.mediaWorkers === false
        ? { k: 'Workers', v: 'in bot', d: '', up: true, s: 'MEDIA_WORKERS=false' }
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
          },
      {
        k: 'Queue',
        v: String(queued),
        d: queued ? 'waiting' : 'clear',
        up: queued === 0,
        s: `${retried} retried in 24h`,
      },
    ];
  });

  const bars = $derived.by(() => {
    const n = Math.round(range.span / range.bucket);
    const start = Math.floor((now - range.span) / range.bucket) * range.bucket + range.bucket;
    const out = Array.from({ length: n }, (_, i) => ({
      at: start + i * range.bucket,
      ok: 0,
      fail: 0,
    }));
    for (const o of cur) {
      const b = out[Math.floor((o.timestamp - start) / range.bucket)];
      if (b) o.status === 'error' ? b.fail++ : b.ok++;
    }
    const max = Math.max(4, ...out.map(b => b.ok + b.fail));
    return out.map(b => ({ ...b, okH: (b.ok / max) * 100, failH: (b.fail / max) * 100 }));
  });
  const ticks = $derived(
    [0, 0.25, 0.5, 0.75, 1].map(f => {
      const b = bars[Math.min(bars.length - 1, Math.round(f * (bars.length - 1)))];
      if (!b) return '';
      const d = new Date(b.at);
      return rangeKey === '7d'
        ? d.toLocaleDateString([], { weekday: 'short', day: 'numeric' })
        : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    })
  );

  const recent = $derived([...ops].sort((a, b) => b.timestamp - a.timestamp).slice(0, 6));

  const sources = $derived.by(() => {
    const map = new Map();
    for (const o of finished(cur)) {
      const host = hostOf(o.originalUrl) ?? 'attachment';
      const s = map.get(host) ?? { name: host, n: 0, ok: 0 };
      s.n++;
      if (o.status === 'success') s.ok++;
      map.set(host, s);
    }
    return [...map.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 7)
      .map(s => ({ ...s, rate: Math.round((s.ok / s.n) * 100) }));
  });

  const openIssues = $derived(issues.filter(i => i.lastSeen > now - 7 * 24 * HOUR).slice(0, 4));

  const hourLabel = at =>
    new Date(at).toLocaleString([], {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

  headerActions.set(actions);
  onDestroy(() => headerActions.set(null));
</script>

{#snippet actions()}
  <div class="seg" role="group" aria-label="time range">
    {#each Object.keys(RANGES) as r (r)}
      <button
        class:on={rangeKey === r}
        onclick={() => navigate('dashboard', r === '24h' ? {} : { range: r })}>{r}</button
      >
    {/each}
  </div>
  <span class="live" title={$connected ? 'live feed connected' : 'live feed reconnecting'}>
    <span class="dot" class:ok={$connected}></span>live
  </span>
{/snippet}

<div class="overview stack">
  <section class="panel kpis" aria-label="key numbers">
    {#each kpis as k (k.k)}
      <div class="kpi">
        <div class="k">{k.k}</div>
        <div class="v">
          {loaded ? k.v : '—'}
          {#if loaded && k.d}<span class="d" class:up={k.up} class:down={!k.up}>{k.d}</span>{/if}
        </div>
        <div class="s">{loaded ? k.s : ' '}</div>
      </div>
    {/each}
  </section>

  <div class="two">
    <section class="panel" aria-label="requests over time">
      <div class="ph">
        <span
          >Requests per {range.bucket >= HOUR * 6
            ? '6 hours'
            : range.bucket >= HOUR
              ? 'hour'
              : '5 minutes'}</span
        >
        <span class="meta">
          <span class="legend"><i class="okc"></i>delivered</span>
          <span class="legend"><i class="failc"></i>failed</span>
        </span>
      </div>
      <div class="chart">
        <div class="bars">
          {#each bars as b (b.at)}
            <div class="col" title="{hourLabel(b.at)} · {b.ok} delivered, {b.fail} failed">
              <div class="fail" style="height:{b.failH}%" class:gap={b.fail && b.ok}></div>
              <div class="ok" style="height:{b.okH}%" class:top={!b.fail}></div>
            </div>
          {/each}
        </div>
        <div class="axis mono">
          {#each ticks as t, i (i)}<span>{t}</span>{/each}
        </div>
      </div>
    </section>

    <section class="panel" aria-label="open issues">
      <div class="ph">
        <span>Open issues</span>
        <button class="linkish meta" onclick={() => navigate('issues')}>View all</button>
      </div>
      {#each openIssues as i (i.reason)}
        <button class="issue" onclick={() => navigate('issues', { reason: i.reason })}>
          <span class="n mono">{i.count}</span>
          <span class="grow">
            <span class="t ellipsis">{i.reason}</span>
            <span class="m">{i.commands.join(', ')} · {formatRelativeTime(i.lastSeen)}</span>
          </span>
        </button>
      {:else}
        <div class="empty">{loaded ? 'no failures in the last 7 days' : 'loading…'}</div>
      {/each}
    </section>
  </div>

  <div class="two">
    <section
      class="panel tbl"
      aria-label="recent requests"
      style="--cols: 12px 76px minmax(0,1fr) 96px 64px 72px"
    >
      <div class="ph">
        <span>Recent requests</span>
        <button class="linkish meta" onclick={() => navigate('requests')}>Open requests</button>
      </div>
      {#each recent as r (r.id)}
        <button class="tr" onclick={() => navigate('request', { requestId: r.id })}>
          <span
            class="dot"
            class:ok={r.status === 'success'}
            class:bad={r.status === 'error'}
            class:run={r.status === 'running'}
            title={r.status}
          ></span>
          <span class="muted">{r.type}</span>
          <span class="mono ellipsis small">{urlLabel(r.originalUrl)}</span>
          <span class="mono muted small">{shortId(r.userId)}</span>
          <span class="num muted small"
            >{r.performanceMetrics?.duration
              ? formatDuration(r.performanceMetrics.duration)
              : '—'}</span
          >
          <span class="dim small right">{formatRelativeTime(r.timestamp)}</span>
        </button>
      {:else}
        <div class="empty">{loaded ? 'no requests yet' : 'loading…'}</div>
      {/each}
    </section>

    <section class="panel" aria-label="sources">
      <div class="ph"><span>Sources, last {rangeKey}</span></div>
      <div class="sources">
        {#each sources as s (s.name)}
          <button
            class="src"
            onclick={() =>
              navigate('requests', { urlPattern: s.name === 'attachment' ? '' : s.name })}
          >
            <span class="ellipsis">{s.name}</span>
            <span class="bar-track"
              ><span
                style="width:{s.rate}%; background:{s.rate >= 90
                  ? 'var(--chart-series-1)'
                  : 'var(--warning)'}"
              ></span></span
            >
            <span class="num muted small">{s.rate}%</span>
            <span class="num dim small">{s.n}</span>
          </button>
        {:else}
          <div class="empty">{loaded ? 'nothing yet' : 'loading…'}</div>
        {/each}
      </div>
    </section>
  </div>
</div>

<style>
  .overview {
    max-width: 1400px;
    margin: 0 auto;
  }
  .two {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 420px;
    gap: 16px;
  }
  .live {
    height: 32px;
    padding: 0 10px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12px;
    color: var(--text-muted);
  }
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
  .okc {
    background: var(--chart-series-1);
  }
  .failc {
    background: var(--warning);
  }
  .chart {
    height: 216px;
    padding: 16px 16px 8px;
    display: flex;
    flex-direction: column;
  }
  .bars {
    flex: 1;
    display: flex;
    align-items: flex-end;
    gap: 6px;
    border-bottom: 1px solid #25272d;
  }
  .col {
    flex: 1;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
  }
  .col:hover .ok {
    background: var(--chart-series-1-hover);
  }
  .ok {
    background: var(--chart-series-1);
  }
  .ok.top,
  .fail {
    border-radius: 3px 3px 0 0;
  }
  .fail {
    background: var(--warning);
  }
  .fail.gap {
    margin-bottom: 1px;
  }
  .axis {
    display: flex;
    justify-content: space-between;
    padding-top: 6px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .issue {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 16px;
    border: 0;
    border-top: 1px solid var(--line);
    background: none;
    color: #d4d3cf;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .issue:first-of-type {
    border-top: 0;
  }
  .issue:hover {
    background: #191a1f;
  }
  .issue .n {
    width: 34px;
    text-align: right;
    font-size: 13px;
    color: var(--text-bright);
  }
  .issue .t {
    display: block;
    font-size: 13px;
  }
  .issue .m {
    display: block;
    margin-top: 2px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .small {
    font-size: 12px;
  }
  .right {
    text-align: right;
  }
  .sources {
    padding: 6px 8px 10px;
  }
  .src {
    width: 100%;
    display: grid;
    grid-template-columns: 110px 1fr 48px 40px;
    align-items: center;
    gap: 10px;
    height: 34px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .src:hover {
    background: #191a1f;
  }
  @media (max-width: 1100px) {
    .two {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 640px) {
    .tbl {
      --cols: 10px 64px minmax(0, 1fr) 60px !important;
    }
    .tbl :global(.tr > :nth-child(4)),
    .tbl :global(.tr > :nth-child(5)) {
      display: none;
    }
    .live {
      display: none;
    }
  }
</style>
