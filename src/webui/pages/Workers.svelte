<script>
  import { getJsonOrNull, sendJson } from '../utils/api.js';
  import { Pause, Play, AlertTriangle, Cpu } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { refreshNav } from '../stores/nav.js';
  import { formatBytes, formatRelativeTime, urlLabel } from '../utils/format.js';
  import PageHeader from '../components/PageHeader.svelte';
  import DataTable from '../components/DataTable.svelte';

  const LIVE_MS = 30_000;

  let data = $state(null);
  let system = $state(null);
  let bot = $state(null);
  let now = $state(Date.now());
  let updated = $state(0);
  let busy = $state(false);

  const statusFilter = $derived($currentRoute.params.$status || '');

  async function load() {
    [data, bot] = await Promise.all([
      getJsonOrNull('/api/system'),
      getJsonOrNull('/api/bot/status'),
    ]);
    now = Date.now();
    updated = now;
  }
  const loadDeps = async () => (system = (await getJsonOrNull('/api/system/deps')) ?? system);
  $effect(() => {
    load();
    loadDeps();
    const t = setInterval(load, 5000);
    const d = setInterval(loadDeps, 30_000);
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => (clearInterval(t), clearInterval(d), clearInterval(tick));
  });

  async function setPaused(value) {
    busy = true;
    await sendJson('/api/settings/queue_paused', 'PUT', { value }).catch(() => null);
    await load();
    refreshNav();
    busy = false;
  }

  const jobs = $derived(data?.jobs);
  const processes = $derived.by(() => {
    let w = 0;
    return (jobs?.processes ?? []).map(p => ({
      ...p,
      name: p.role === 'bot' ? 'gronka (bot)' : `worker-${++w}`,
      live: now - p.seen_at < LIVE_MS,
    }));
  });
  const down = $derived(processes.filter(p => !p.live));
  // Every process should run the same build; a mismatch means a deploy is half done.
  const versions = $derived([...new Set(processes.map(p => p.version).filter(Boolean))]);
  const mismatch = $derived(
    versions.length > 1 || (data?.version && versions.length === 1 && versions[0] !== data.version)
  );
  const recent = $derived(
    (jobs?.recent ?? []).filter(j => !statusFilter || j.status === statusFilter)
  );
  const count = s => jobs?.counts?.[s]?.count ?? 0;
  const retried = $derived(
    Object.values(jobs?.counts ?? {}).reduce((n, c) => n + (c.retried || 0), 0)
  );
  const until = ms =>
    ms < 86_400_000 ? `${Math.ceil(ms / 3_600_000)}h` : `${Math.floor(ms / 86_400_000)}d`;
  const uptime = ms => {
    const m = Math.floor(ms / 60000);
    return m < 60
      ? `${m}m`
      : m < 1440
        ? `${Math.floor(m / 60)}h ${m % 60}m`
        : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  };
  const JOB_STATUS = {
    done: ['ok', 'Done'],
    failed: ['bad', 'Failed'],
    running: ['info', 'Running'],
    queued: ['idle', 'Queued'],
  };
  const paused = $derived(!!jobs?.paused);
  const liveWorkers = $derived(processes.filter(p => p.live && p.role !== 'bot').length);
  const allWorkers = $derived(processes.filter(p => p.role !== 'bot').length);
  const sessionNote = s =>
    !s.fileFound
      ? `${s.file} not found`
      : !s.loggedIn
        ? 'anonymous'
        : s.expires
          ? s.expires < now
            ? `expired ${formatRelativeTime(s.expires)}`
            : `expires in ${until(s.expires - now)}`
          : `${s.cookies} cookies`;
  const sessionBad = s => s.loggedIn && s.lastRejected && s.lastRejected > s.fileChanged;
  const ago = $derived(updated ? Math.max(0, Math.round((now - updated) / 1000)) : null);

  const JOB_COLUMNS = [
    { key: 'id', label: 'Job', width: '64px' },
    { key: 'state', label: 'State', width: '96px' },
    { key: 'req', label: 'Request' },
    { key: 'worker', label: 'Worker', width: '120px', sm: false },
    { key: 'attempts', label: 'Attempts', width: '76px', align: 'right', sm: false },
    { key: 'age', label: 'Age', width: '70px', align: 'right' },
  ];
</script>

<PageHeader title="Workers & queue" description="Media jobs and the processes that run them">
  {#snippet actions()}
    {#if ago != null}<span class="dim small tnum">Updated {ago}s ago</span>{/if}
    {#if paused}<span class="pill warn">Queue paused</span>{:else if jobs}<span class="pill ok"
        >Queue running</span
      >{/if}
    {#if jobs && data?.mediaWorkers !== false}
      <button class="btn" class:primary={paused} disabled={busy} onclick={() => setPaused(!paused)}>
        {#if paused}<Play size={14} />Resume queue{:else}<Pause size={14} />Pause queue{/if}
      </button>
    {/if}
  {/snippet}
</PageHeader>

<div class="workers stack">
  {#if data?.mediaWorkers === false}
    <div class="flash">
      <Cpu size={14} />
      Media jobs run inside the bot (MEDIA_WORKERS=false), so there are no worker processes
    </div>
  {/if}

  {#if paused}
    <div class="flash" class:warn={count('running')} class:ok={!count('running')} role="status">
      <span class="grow">
        {#if count('running')}
          <b>Queue paused, draining.</b>
          {count('running')} running job{count('running') === 1 ? '' : 's'} will finish; nothing new starts.
        {:else}
          <b>Queue paused and drained.</b> No job is running, so a deploy interrupts nothing.
        {/if}
        {#if count('queued')}{count('queued')} queued and waiting.{/if}
      </span>
      <button class="btn primary sm" disabled={busy} onclick={() => setPaused(false)}>Resume</button
      >
    </div>
  {/if}

  {#if down.length || mismatch}
    <div class="flash warn" role="status">
      <AlertTriangle size={14} />
      <span class="grow">
        {#if down.length}
          <b>{down.length} process{down.length === 1 ? '' : 'es'} not reporting:</b>
          {down.map(p => p.name).join(', ')}. Last heartbeat {formatRelativeTime(
            Math.max(...down.map(p => p.seen_at))
          )}.
        {/if}
        {#if mismatch}
          <b>Version mismatch:</b>
          {[...new Set([...versions, data?.version])]
            .filter(Boolean)
            .map(v => `v${v}`)
            .join(', ')}. Restart the older process.
        {/if}
      </span>
    </div>
  {/if}

  <section class="kpis" style="--kpi-cols: 4" aria-label="queue">
    <div class="kpi" class:warn={paused && count('queued')}>
      <div class="k">Queued</div>
      <div class="v">{jobs ? count('queued') : '—'}</div>
      {#if paused}<span class="d warn">paused</span>{/if}
      <div class="s">waiting for a worker</div>
    </div>
    <div class="kpi">
      <div class="k">Running</div>
      <div class="v">{jobs ? count('running') : '—'}</div>
      <div class="s">right now</div>
    </div>
    <div class="kpi">
      <div class="k">Done</div>
      <div class="v">{jobs ? count('done').toLocaleString() : '—'}</div>
      {#if retried}<span class="d plain">{retried} needed a retry</span>{/if}
      <div class="s">last 24h</div>
    </div>
    <div class="kpi" class:bad={count('failed') > 0}>
      <div class="k">Failed</div>
      <div class="v">{jobs ? count('failed') : '—'}</div>
      <div class="s">
        <button
          class="linkish"
          onclick={() => navigate('system', statusFilter === 'failed' ? {} : { status: 'failed' })}
          >{statusFilter === 'failed' ? 'Show all jobs' : 'Show only failed'}</button
        >
      </div>
    </div>
  </section>

  {#if processes.length}
    <section class="panel" aria-label="processes">
      <div class="ph">
        <span>Processes</span>
        <span class="meta"
          ><span class="tnum"
            >{allWorkers ? `${liveWorkers} of ${allWorkers} workers live` : ''}</span
          >{#if data?.version}<span class="dim mono">webui v{data.version}</span>{/if}</span
        >
      </div>
      <div class="procs">
        <div class="pr head">
          <span></span><span>Process</span><span>State</span><span>Build</span><span>Heartbeat</span
          ><span>Uptime</span><span class="num">Memory</span><span class="num">CPU</span>
        </div>
        {#each processes as p (p.id)}
          <div class="pr">
            <span
              class="dot"
              class:ok={p.live}
              class:err={!p.live}
              class:pulse={p.live && p.running}
            ></span>
            <span class="pname">
              <span class="strong">{p.name}</span>
              <span class="mono xs dim ellipsis" title={p.id}>{p.id}</span>
            </span>
            <span
              ><span class="pill sm" class:ok={p.live} class:bad={!p.live}
                >{!p.live
                  ? 'Not reporting'
                  : p.role === 'bot'
                    ? 'Gateway ready'
                    : p.running
                      ? `Running ${p.running}`
                      : 'Idle'}</span
              ></span
            >
            <span
              ><span class="chip mono" class:warn={mismatch && p.version !== data?.version}
                >v{p.version ?? '?'}</span
              ></span
            >
            <span class="mono small muted">{formatRelativeTime(p.seen_at)}</span>
            <span class="mono small muted">{uptime(now - p.started_at)}</span>
            <span class="meter num">
              <span class="bar-track"
                ><span
                  style="width:{Math.min(
                    100,
                    ((p.rss ?? 0) / 1024 ** 3) * 100
                  )}%; background: var(--chart-1)"
                ></span></span
              >{p.rss ? formatBytes(p.rss) : '—'}
            </span>
            <span class="meter num">
              <span class="bar-track"
                ><span
                  style="width:{Math.min(100, p.cpu ?? 0)}%; background: {(p.cpu ?? 0) > 80
                    ? 'var(--warning)'
                    : 'var(--chart-1)'}"
                ></span></span
              >{p.cpu == null ? '—' : `${p.cpu.toFixed(1)}%`}
            </span>
          </div>
        {/each}
      </div>
    </section>
  {:else if jobs}
    <div class="panel pb note">
      Live process status appears once this version is running: each bot and worker reports in every
      10 s. Until then, workers are known only from the jobs they ran:
      {#each jobs.workers as w (w.worker)}
        <span class="chip mono"
          >{w.worker} · {w.done} done{w.failed ? ` · ${w.failed} failed` : ''} · {formatRelativeTime(
            w.last_seen
          )}</span
        >
      {/each}
    </div>
  {/if}

  <div class="two wide-left">
    <DataTable
      title="Media jobs"
      columns={JOB_COLUMNS}
      rows={recent}
      loading={!jobs}
      empty={statusFilter ? `No ${statusFilter} jobs` : 'No jobs yet'}
      onrow={j => navigate('request', { requestId: j.operation_id })}
      rowDisabled={j => !j.operation_id}
      label="media jobs"
    >
      {#snippet header()}
        {#if statusFilter}
          <span class="chip warn">{statusFilter} only</span>
          <button class="linkish" onclick={() => navigate('system', {})}>Clear</button>
        {:else}
          <span class="dim">most recent first</span>
        {/if}
      {/snippet}
      {#snippet row(j)}
        {@const [kind, label] = JOB_STATUS[j.status] ?? ['idle', j.status]}
        <span class="mono dim">#{j.id}</span>
        <span><span class="pill sm {kind}">{label}</span></span>
        <span class="mono ellipsis"
          >{j.kind} {j.url ? urlLabel(j.url) : j.attachment ? 'attachment' : ''}</span
        >
        <span class="mono muted ellipsis hide-sm">{j.worker ?? '—'}</span>
        <span class="num hide-sm" class:warn-text={j.attempts > 1}>{j.attempts}</span>
        <span class="num dim">{formatRelativeTime(j.created_at)}</span>
      {/snippet}
    </DataTable>

    <div class="stack">
      <section class="panel" aria-label="dependencies">
        <div class="ph"><span>Dependencies</span><span class="meta">checked every 30 s</span></div>
        {#if bot}
          <div class="lrow dep">
            <span
              class="dot"
              class:ok={bot.status && bot.status !== 'offline'}
              class:err={!bot.status || bot.status === 'offline'}
            ></span>
            <span class="strong">Discord</span>
            <span class="mono dim small right ellipsis">{bot.botTag ?? '—'} · {bot.status}</span>
          </div>
        {/if}
        {#each system?.deps ?? [] as d (d.id)}
          <div class="lrow dep">
            <span
              class="dot"
              class:ok={d.status === 'ok'}
              class:bad={d.status === 'warn'}
              class:err={d.status === 'error'}
            ></span>
            <span class="strong">{d.label}</span>
            <span class="mono dim small right ellipsis" title={d.detail}
              >{d.detail ?? d.status}</span
            >
          </div>
        {:else}
          {#if system}<div class="empty">No checks</div>{:else}<div class="skel-rows">
              {#each Array(5) as _, i (i)}<span class="skeleton" style="width:{60 + (i % 3) * 10}%"
                ></span>{/each}
            </div>{/if}
        {/each}
      </section>

      <section class="panel" aria-label="sessions">
        <div class="ph">
          <span>Sessions</span>
          <span class="meta">from the bot's cookie files</span>
        </div>
        {#each system?.sessions ?? [] as s (s.id)}
          <div class="lrow dep">
            <span
              class="dot"
              class:ok={s.loggedIn && !sessionBad(s)}
              class:err={sessionBad(s) || !s.fileFound}
            ></span>
            <div class="grow">
              <div class="strong">{s.label}</div>
              <div class="dim small">
                {#if sessionBad(s)}
                  rejected {formatRelativeTime(s.lastRejected)}, needs a fresh cookie
                {:else if s.fileFound}
                  file updated {formatRelativeTime(s.fileChanged)}
                {/if}
              </div>
            </div>
            <span class="mono dim small right">{sessionNote(s)}</span>
          </div>
        {:else}
          {#if system}<div class="empty">No cookie files</div>{:else}<div class="skel-rows">
              {#each Array(2) as _, i (i)}<span class="skeleton" style="width:{60 + i * 10}%"
                ></span>{/each}
            </div>{/if}
        {/each}
      </section>
    </div>
  </div>
</div>

<style>
  .note {
    font-size: var(--fs);
    line-height: 1.6;
    color: var(--text-muted);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .procs {
    overflow-x: auto;
  }
  .pr {
    display: grid;
    grid-template-columns: 14px minmax(160px, 1.2fr) 130px 76px 90px 80px 130px 110px;
    align-items: center;
    gap: 14px;
    min-height: 48px;
    padding: 6px 16px;
    border-top: 1px solid var(--line);
    font-size: var(--fs);
  }
  .pr.head {
    min-height: 36px;
    padding: 0 16px;
    border-top: 0;
    background: var(--card-2);
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-muted);
  }
  .pr > * {
    min-width: 0;
  }
  .pname {
    display: flex;
    flex-direction: column;
    line-height: 1.3;
  }
  .meter {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-sm);
  }
  .meter .bar-track {
    flex: 1;
    height: 5px;
  }
  .dep {
    padding: 11px 16px;
  }
  @media (max-width: 900px) {
    .pr {
      grid-template-columns: 14px minmax(140px, 1fr) 120px;
    }
    .pr > :nth-child(n + 4) {
      display: none;
    }
  }
</style>
