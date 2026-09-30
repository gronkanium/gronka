<script>
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
  let busy = $state(false);

  const statusFilter = $derived($currentRoute.params.$status || '');

  const get = url =>
    fetch(url)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
  async function load() {
    [data, bot] = await Promise.all([get('/api/system'), get('/api/bot/status')]);
    now = Date.now();
  }
  const loadDeps = async () => (system = (await get('/api/system/deps')) ?? system);
  $effect(() => {
    load();
    loadDeps();
    const t = setInterval(load, 5000);
    const d = setInterval(loadDeps, 30_000);
    return () => (clearInterval(t), clearInterval(d));
  });

  async function setPaused(value) {
    busy = true;
    await fetch('/api/settings/queue_paused', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    }).catch(() => null);
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

  const JOB_COLUMNS = [
    { key: 'id', label: 'job', width: '64px' },
    { key: 'state', label: 'state', width: '96px' },
    { key: 'req', label: 'request' },
    { key: 'worker', label: 'worker', width: '150px', sm: false },
    { key: 'attempts', label: 'attempts', width: '72px', align: 'right', sm: false },
    { key: 'age', label: 'age', width: '70px', align: 'right' },
  ];
</script>

<PageHeader
  title="Workers & queue"
  description="Media jobs, the processes running them, and the services they depend on. Refreshes every 5 seconds."
>
  {#snippet actions()}
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
      Media jobs run inside the bot (MEDIA_WORKERS=false), so there are no worker processes.
    </div>
  {/if}

  {#if paused}
    <div class="flash" class:warn={count('running')} class:ok={!count('running')} role="status">
      <span class="grow">
        {#if count('running')}
          <b>Queue paused, draining.</b>
          {count('running')} running job{count('running') === 1 ? '' : 's'} will finish; nothing new is
          started.
        {:else}
          <b>Queue paused and drained.</b> No job is running, so a deploy interrupts nothing.
        {/if}
        {#if count('queued')}{count('queued')} queued and waiting.{/if}
      </span>
      <button class="btn primary sm" disabled={busy} onclick={() => setPaused(false)}>Resume</button
      >
    </div>
  {/if}

  {#if mismatch}
    <div class="flash warn" role="status">
      <AlertTriangle size={14} />
      <span
        >Processes are on different builds ({[...new Set([...versions, data?.version])]
          .filter(Boolean)
          .map(v => `v${v}`)
          .join(', ')}). A deploy is probably half done; restart what is behind.</span
      >
    </div>
  {/if}

  <section class="kpis" style="--kpi-cols: 6" aria-label="queue">
    <div class="kpi">
      <div class="k">Queued</div>
      <div class="v">
        {jobs ? count('queued') : '—'}
        {#if paused}<span class="d warn">paused</span>{/if}
      </div>
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
      <div class="s">last 24h</div>
    </div>
    <div class="kpi">
      <div class="k">Failed</div>
      <div class="v">
        {jobs ? count('failed') : '—'}
        {#if count('failed')}<span class="d bad">24h</span>{/if}
      </div>
      <div class="s">
        <button
          class="linkish"
          onclick={() => navigate('system', statusFilter === 'failed' ? {} : { status: 'failed' })}
          >{statusFilter === 'failed' ? 'show all jobs' : 'show only failed'}</button
        >
      </div>
    </div>
    <div class="kpi">
      <div class="k">Retried</div>
      <div class="v">{jobs ? retried : '—'}</div>
      <div class="s">attempts beyond the first</div>
    </div>
    <div class="kpi">
      <div class="k">Workers live</div>
      <div class="v">
        {allWorkers ? `${liveWorkers} / ${allWorkers}` : '—'}
        {#if allWorkers && liveWorkers < allWorkers}<span class="d bad">down</span>{/if}
      </div>
      <div class="s">{data?.version ? `webui v${data.version}` : ''}</div>
    </div>
  </section>

  {#if processes.length}
    <div class="cards">
      {#each processes as p (p.id)}
        <section class="panel proc" class:accent-danger={!p.live} aria-label={p.name}>
          <div class="ph">
            <span class="dot" class:ok={p.live} class:err={!p.live}></span>
            <span>{p.name}</span>
            <span class="meta">
              <span class="pill sm" class:ok={p.live} class:bad={!p.live}
                >{!p.live
                  ? 'Not reporting'
                  : p.role === 'bot'
                    ? 'Gateway ready'
                    : p.running
                      ? `Running ${p.running}`
                      : 'Idle'}</span
              >
              <span class="mono" class:warn-text={mismatch && p.version !== data?.version}
                >v{p.version ?? '?'}</span
              >
            </span>
          </div>
          <div class="pb facts">
            <div>
              <div class="k">heartbeat</div>
              <div class="v mono">{formatRelativeTime(p.seen_at)}</div>
            </div>
            <div>
              <div class="k">uptime</div>
              <div class="v mono">{uptime(now - p.started_at)}</div>
            </div>
            <div>
              <div class="k">memory</div>
              <div class="v mono">{p.rss ? formatBytes(p.rss) : '—'}</div>
            </div>
            <div>
              <div class="k">cpu</div>
              <div class="v mono">{p.cpu == null ? '—' : `${p.cpu.toFixed(1)}%`}</div>
            </div>
            <div class="wide">
              <div class="k">id</div>
              <div class="v mono dim ellipsis" title={p.id}>{p.id}</div>
            </div>
          </div>
        </section>
      {/each}
    </div>
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
      empty={statusFilter ? `no ${statusFilter} jobs` : 'no jobs'}
      onrow={j => navigate('request', { requestId: j.operation_id })}
      rowDisabled={j => !j.operation_id}
      label="media jobs"
    >
      {#snippet header()}
        {#if statusFilter}
          <span class="chip warn">{statusFilter} only</span>
          <button class="linkish" onclick={() => navigate('system', {})}>clear</button>
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
          <div class="empty">{system ? 'no checks' : 'checking…'}</div>
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
          <div class="empty">{system ? 'no cookie files' : 'checking…'}</div>
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
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: var(--gap);
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 14px 12px;
  }
  .facts .wide {
    grid-column: 1 / -1;
  }
  .k {
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .v {
    margin-top: 4px;
    font-size: var(--fs);
    color: var(--text-bright);
  }
  .dep {
    padding: 11px 20px;
  }
  .flash b {
    color: inherit;
    font-weight: 600;
  }
</style>
