<script>
  import { poll } from '../utils/poll.js';
  import { getJsonOrNull, sendJson } from '../utils/api.js';
  import { Pause, Play, AlertTriangle, Cpu } from 'lucide-svelte';
  import { refreshNav } from '../stores/nav.js';
  import { formatBytes, formatRelativeTime, NO_DATA } from '../utils/format.js';
  import PageHeader from '../components/PageHeader.svelte';
  import DataTable from '../components/DataTable.svelte';

  let data = $state(null);
  let system = $state(null);
  let bot = $state(null);
  let now = $state(Date.now());
  let updated = $state(0);
  let busy = $state(false);

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
    const stops = [poll(load, 5000), poll(loadDeps, 30_000), poll(() => (now = Date.now()), 1000)];
    return () => stops.forEach(stop => stop());
  });

  async function setPaused(value) {
    busy = true;
    await sendJson('/api/settings/queue_paused', 'PUT', { value }).catch(() => null);
    await load();
    refreshNav();
    busy = false;
  }

  const jobs = $derived(data?.jobs);
  const paused = $derived(!!jobs?.paused);
  const count = s => jobs?.counts?.[s] ?? 0;

  // Ids are `<container id>-<pid>`: a new container (deploy) or pid (restart) is a new process.
  const processes = $derived.by(() => {
    let n = 0;
    return (jobs?.processes ?? []).map(p => {
      const cut = p.id.lastIndexOf('-');
      return {
        ...p,
        name: p.role === 'bot' ? 'Bot' : `Worker ${++n}`,
        container: p.id.slice(0, cut),
        pid: p.id.slice(cut + 1),
      };
    });
  });
  const nameOf = $derived(Object.fromEntries(processes.map(p => [p.id, p.name])));
  const workers = $derived(processes.filter(p => p.role === 'worker'));
  const liveWorkers = $derived(workers.filter(p => p.live).length);
  const down = $derived(processes.filter(p => !p.live));
  const build = $derived(data?.version);
  const stale = $derived(processes.filter(p => p.live && p.version !== build));

  const attention = $derived(
    [
      paused &&
        (count('running')
          ? `Queue paused: ${count('running')} running job${count('running') === 1 ? '' : 's'} will finish, nothing new starts.`
          : 'Queue paused and drained: a deploy interrupts nothing.'),
      down.length &&
        `${down.map(p => p.name).join(', ')} stopped reporting ${formatRelativeTime(
          Math.max(...down.map(p => p.seenAt))
        )}. A process that stays silent drops off this list after a minute.`,
      stale.length &&
        `${stale.map(p => `${p.name} runs v${p.version}`).join(', ')}, the webui runs v${build}. Restart the older process.`,
    ].filter(Boolean)
  );

  const uptime = ms => {
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m`;
    if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
    return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  };
  const until = ms =>
    ms < 86_400_000 ? `${Math.ceil(ms / 3_600_000)}h` : `${Math.floor(ms / 86_400_000)}d`;
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
  const ago = $derived(updated ? Math.max(0, Math.round((now - updated) / 1000)) : null);
  const status = p =>
    !p.live
      ? ['bad', 'Not reporting']
      : p.role === 'bot'
        ? ['ok', 'Connected']
        : p.running
          ? ['info', `Running ${p.running}`]
          : ['ok', 'Idle'];

  const PROC_COLUMNS = [
    { key: 'name', label: 'Process' },
    { key: 'status', label: 'Status', width: '130px' },
    { key: 'uptime', label: 'Uptime', width: '90px', align: 'right' },
    { key: 'rss', label: 'Memory', width: '100px', align: 'right' },
    { key: 'cpu', label: 'CPU', width: '80px', align: 'right', sm: false },
    { key: 'seen', label: 'Last report', width: '110px', align: 'right', sm: false },
  ];
  const JOB_COLUMNS = [
    { key: 'id', label: 'Job', width: '72px' },
    { key: 'state', label: 'State', width: '96px' },
    { key: 'kind', label: 'Command' },
    { key: 'worker', label: 'Worker', width: '110px', sm: false },
    { key: 'attempts', label: 'Attempts', width: '80px', align: 'right', sm: false },
    { key: 'age', label: 'Age', width: '80px', align: 'right' },
  ];
  const JOB_STATUS = { running: ['info', 'Running'], queued: ['idle', 'Queued'] };
</script>

<PageHeader title="Workers & queue" description="Media jobs and the processes that run them">
  {#snippet actions()}
    {#if ago != null}<span class="dim small tnum">Updated {ago}s ago</span>{/if}
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

  {#if attention.length}
    <div class="flash warn" role="status">
      <AlertTriangle size={14} />
      <ul class="grow attention">
        {#each attention as line (line)}<li>{line}</li>{/each}
      </ul>
    </div>
  {/if}

  <section class="kpis" style="--kpi-cols: 4" aria-label="queue">
    <div class="kpi" class:bad={workers.length && liveWorkers < workers.length}>
      <div class="k">Workers</div>
      <div class="v tnum">{jobs ? `${liveWorkers} of ${workers.length}` : NO_DATA}</div>
      <div class="s">reporting in the last 30 s</div>
    </div>
    <div class="kpi" class:warn={paused && count('queued')}>
      <div class="k">Queued</div>
      <div class="v tnum">{jobs ? count('queued') : NO_DATA}</div>
      <div class="s">{paused ? 'held while paused' : 'waiting for a worker'}</div>
    </div>
    <div class="kpi">
      <div class="k">Running</div>
      <div class="v tnum">{jobs ? count('running') : NO_DATA}</div>
      <div class="s">right now</div>
    </div>
    <div class="kpi" class:warn={stale.length}>
      <div class="k">Build</div>
      <div class="v mono build">{build ? `v${build}` : NO_DATA}</div>
      <div class="s">{stale.length ? 'mixed versions' : 'every process matches'}</div>
    </div>
  </section>

  <DataTable
    title="Processes"
    columns={PROC_COLUMNS}
    rows={processes}
    loading={!jobs}
    empty="No process has reported yet"
    label="processes"
  >
    {#snippet row(p)}
      {@const [tone, label] = status(p)}
      <span class="pname">
        <span class="strong">{p.name}</span>
        <span class="mono xs dim">container {p.container} · pid {p.pid}</span>
      </span>
      <span><span class="pill sm {tone}">{label}</span></span>
      <span class="num tnum muted">{uptime(now - p.startedAt)}</span>
      <span class="num tnum">{p.rss ? formatBytes(p.rss) : NO_DATA}</span>
      <span class="num tnum muted hide-sm">{p.cpu == null ? NO_DATA : `${p.cpu.toFixed(1)}%`}</span>
      <span class="num dim hide-sm">{formatRelativeTime(p.seenAt)}</span>
    {/snippet}
  </DataTable>

  <div class="two wide-left">
    <DataTable
      title="Media jobs"
      columns={JOB_COLUMNS}
      rows={jobs?.recent ?? []}
      loading={!jobs}
      empty="No jobs queued or running"
      label="media jobs"
    >
      {#snippet row(j)}
        {@const [kind, label] = JOB_STATUS[j.status] ?? ['idle', j.status]}
        <span class="mono dim">#{j.id}</span>
        <span><span class="pill sm {kind}">{label}</span></span>
        <span class="mono ellipsis">{j.kind}</span>
        <span class="muted ellipsis hide-sm" title={j.worker ?? ''}
          >{j.worker ? (nameOf[j.worker] ?? 'stopped process') : NO_DATA}</span
        >
        <span class="num hide-sm" class:warn-text={j.attempts > 1}>{j.attempts}</span>
        <span class="num dim">{formatRelativeTime(j.createdAt)}</span>
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
            <span class="mono dim small right ellipsis">{bot.botTag ?? NO_DATA} · {bot.status}</span
            >
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
            <span class="dot" class:ok={s.loggedIn} class:err={!s.fileFound}></span>
            <div class="grow">
              <div class="strong">{s.label}</div>
              <div class="dim small">
                {#if s.fileFound}
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
  .attention {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 4px;
  }
  .pname {
    display: flex;
    flex-direction: column;
    line-height: 1.3;
    min-width: 0;
  }
  .build {
    font-size: var(--fs-lg, 1.1rem);
  }
  .dep {
    padding: 11px 16px;
  }
</style>
