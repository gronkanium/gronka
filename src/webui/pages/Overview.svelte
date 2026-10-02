<script module>
  // Last load, so coming back to the page draws at once while it refreshes.
  let cached = null;
</script>

<script>
  import { poll } from '../utils/poll.js';
  import { getJsonOrNull } from '../utils/api.js';
  import { ArrowUpRight, Check } from 'lucide-svelte';
  import { navigate } from '../utils/router.js';
  import { issueStates } from '../stores/nav.js';
  import { groupIssues, isOpen, KIND_LABEL } from '../issues.js';
  import { formatRelativeTime } from '../utils/format.js';
  import PageHeader from '../components/PageHeader.svelte';
  import Chart from '../components/Chart.svelte';

  const HOUR = 3600e3;
  const SERIES = [
    { key: 'ok', label: 'delivered', color: 'var(--chart-1)' },
    { key: 'fail', label: 'failed', color: 'var(--chart-4)' },
  ];

  let stats = $state(cached?.stats ?? null);
  let system = $state(cached?.system ?? null);
  let issues = $state(cached?.issues ?? []);
  let loaded = $state(!!cached);

  async function load() {
    const [st, sys, sum] = await Promise.all([
      getJsonOrNull('/api/stats'),
      getJsonOrNull('/api/system'),
      getJsonOrNull('/api/alerts/summary?reasonLimit=300'),
    ]);
    stats = st;
    system = sys;
    issues = sum?.byReason ?? [];
    loaded = true;
    cached = { stats, system, issues };
  }

  $effect(() => {
    load();
    return poll(load, 60_000);
  });

  const sum = (rows, outcome) =>
    (rows ?? []).filter(r => !outcome || r.outcome === outcome).reduce((n, r) => n + r.count, 0);

  const kpis = $derived.by(() => {
    const day = stats?.commands?.lastDay;
    const total = sum(day);
    const ok = sum(day, 'success');
    const rate = total ? Math.round((ok / total) * 1000) / 10 : null;
    return [
      { k: 'Requests', v: total.toLocaleString(), s: 'last 24 hours' },
      {
        k: 'Delivered',
        v: rate === null ? '—' : `${rate}%`,
        s: `${(total - ok).toLocaleString()} failed in 24h`,
        bad: rate !== null && rate < 90,
      },
      { k: 'All time', v: sum(stats?.commands?.allTime).toLocaleString(), s: 'commands run' },
      {
        k: 'On R2',
        v: stats?.storage?.diskUsageFormatted ?? '—',
        s: `${(stats?.storage?.totalGifs ?? 0) + (stats?.storage?.totalVideos ?? 0) + (stats?.storage?.totalImages ?? 0)} files waiting to expire`,
      },
    ];
  });

  const bars = $derived(
    (stats?.hourly ?? []).map(h => ({ at: Date.parse(h.hour), ok: h.success, fail: h.error }))
  );

  const strip = $derived.by(() => {
    const procs = (system?.jobs?.processes ?? []).filter(p => p.role === 'worker');
    const live = procs.filter(p => Date.now() - p.seen_at < 30_000).length;
    const running = system?.jobs?.counts?.running ?? 0;
    const queued = system?.jobs?.counts?.queued ?? 0;
    const paused = !!system?.jobs?.paused;
    return [
      system?.mediaWorkers === false
        ? { label: 'Workers', value: 'in bot', note: '' }
        : {
            label: 'Workers',
            value: procs.length ? `${live} / ${procs.length}` : '—',
            note:
              procs.length && live < procs.length
                ? 'not reporting'
                : running
                  ? `${running} running`
                  : 'idle',
            tone: procs.length && live < procs.length ? 'bad' : '',
          },
      {
        label: 'Queue',
        value: String(queued),
        note: paused ? 'paused' : queued ? 'waiting' : 'clear',
        tone: paused ? 'warn' : '',
      },
    ];
  });

  const openIssues = $derived(
    groupIssues(issues)
      .filter(g => isOpen(g, $issueStates))
      .slice(0, 5)
  );
</script>

<PageHeader title="Overview" description="Requests, delivery and what needs attention" />

<div class="overview stack">
  <section class="kpis" style="--kpi-cols: 4" aria-label="key numbers">
    {#each kpis as k (k.k)}
      <div class="kpi" class:bad={k.bad}>
        <div class="k">{k.k}</div>
        <div class="v">
          {#if loaded}{k.v}{:else}<span class="skeleton">0000</span>{/if}
        </div>
        <div class="s">{loaded ? k.s : ' '}</div>
      </div>
    {/each}
  </section>

  <div class="strip" aria-label="system">
    {#each strip as s (s.label)}
      <button class="item" onclick={() => navigate('system')}>
        <span>{s.label}</span>
        <b>{loaded ? s.value : '—'}</b>
        {#if s.note}<span class="pill sm {s.tone || 'idle'}" class:nodot={!s.tone}>{s.note}</span
          >{/if}
      </button>
    {/each}
  </div>

  <div class="two wide-left">
    <section class="panel" aria-label="requests over time">
      <div class="ph">
        <span>Requests per hour</span>
        <span class="meta">
          {#each SERIES as s (s.key)}
            <span class="legend"><i style="background:{s.color}"></i>{s.label}</span>
          {/each}
        </span>
      </div>
      <div class="chart">
        <Chart type="area" series={SERIES} data={bars} bucket={HOUR} height={240} />
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
        {#if loaded}
          <div class="empty">
            <span class="ic"><Check size={20} /></span>
            <b>All clear</b>No failures in the last 7 days
          </div>
        {:else}
          <div class="skel-rows">
            {#each Array(4) as _, i (i)}<span class="skeleton" style="width:{70 - i * 8}%"
              ></span>{/each}
          </div>
        {/if}
      {/each}
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
</style>
