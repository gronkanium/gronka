<script>
  import { onDestroy } from 'svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { headerActions } from '../stores/header.js';
  import { formatBytes, formatRelativeTime, urlLabel } from '../utils/format.js';

  const LIVE_MS = 30_000;

  let data = $state(null);
  let health = $state(null);
  let bot = $state(null);
  let now = $state(Date.now());

  const statusFilter = $derived($currentRoute.params.$status || '');

  async function load() {
    const get = url =>
      fetch(url)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null);
    [data, health, bot] = await Promise.all([
      get('/api/system'),
      get('/api/health'),
      get('/api/bot/status'),
    ]);
    now = Date.now();
  }
  $effect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  });

  const jobs = $derived(data?.jobs);
  const processes = $derived.by(() => {
    let w = 0;
    return (jobs?.processes ?? []).map(p => ({
      ...p,
      name: p.role === 'bot' ? 'gronka (bot)' : `worker-${++w}`,
      live: now - p.seen_at < LIVE_MS,
    }));
  });
  const recent = $derived(
    (jobs?.recent ?? []).filter(j => !statusFilter || j.status === statusFilter)
  );
  const count = s => jobs?.counts?.[s]?.count ?? 0;
  const retried = $derived(
    Object.values(jobs?.counts ?? {}).reduce((n, c) => n + (c.retried || 0), 0)
  );
  const uptime = ms => {
    const m = Math.floor(ms / 60000);
    return m < 60
      ? `${m}m`
      : m < 1440
        ? `${Math.floor(m / 60)}h ${m % 60}m`
        : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  };
  const jobDot = s => ({ done: 'ok', failed: 'bad', running: 'run', queued: '' })[s] ?? '';

  headerActions.set(actions);
  onDestroy(() => headerActions.set(null));
</script>

{#snippet actions()}
  <span class="dim small">refreshes every 5 s</span>
{/snippet}

<div class="workers stack">
  {#if data?.mediaWorkers === false}
    <div class="panel pb note">
      Media jobs run inside the bot (MEDIA_WORKERS=false), so there are no worker processes.
    </div>
  {/if}

  {#if processes.length}
    <div class="cards">
      {#each processes as p (p.id)}
        <section class="panel" aria-label={p.name}>
          <div class="ph">
            <span class="dot" class:ok={p.live} class:err={!p.live}></span>
            <span>{p.name}</span>
            <span class="meta mono">v{p.version ?? '?'}</span>
          </div>
          <div class="pb facts">
            <div>
              <div class="k">state</div>
              <div class="v">
                {!p.live
                  ? 'not reporting'
                  : p.role === 'bot'
                    ? 'gateway ready'
                    : p.running
                      ? `running ${p.running}`
                      : 'idle'}
              </div>
            </div>
            <div>
              <div class="k">heartbeat</div>
              <div class="v mono">{formatRelativeTime(p.seen_at)}</div>
            </div>
            <div>
              <div class="k">uptime</div>
              <div class="v mono">{uptime(now - p.started_at)}</div>
            </div>
          </div>
          <div class="pb facts bottom">
            <div>
              <div class="k">memory</div>
              <div class="v mono">{p.rss ? formatBytes(p.rss) : '—'}</div>
            </div>
            <div>
              <div class="k">cpu</div>
              <div class="v mono">{p.cpu == null ? '—' : `${p.cpu.toFixed(1)}%`}</div>
            </div>
            <div>
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

  <div class="two">
    <section
      class="panel tbl"
      aria-label="media jobs"
      style="--cols: 56px 84px minmax(0, 1fr) 150px 64px 70px"
    >
      <div class="ph">
        <span>media_jobs</span>
        <span class="meta">
          <span>queued <b class="mono">{count('queued')}</b></span>
          <span>running <b class="mono">{count('running')}</b></span>
          <span>done 24h <b class="mono">{count('done')}</b></span>
          <button
            class="linkish"
            class:strong={statusFilter === 'failed'}
            onclick={() =>
              navigate('system', statusFilter === 'failed' ? {} : { status: 'failed' })}
          >
            failed <b class="mono">{count('failed')}</b>
          </button>
          <span>retried <b class="mono">{retried}</b></span>
        </span>
      </div>
      <div class="tr head">
        <span>job</span><span>state</span><span>request</span><span>worker</span><span class="num"
          >attempts</span
        ><span class="num">age</span>
      </div>
      {#each recent as j (j.id)}
        <button
          class="tr"
          disabled={!j.operation_id}
          onclick={() => navigate('request', { requestId: j.operation_id })}
        >
          <span class="mono dim">#{j.id}</span>
          <span class="row"><span class="dot {jobDot(j.status)}"></span>{j.status}</span>
          <span class="mono small ellipsis"
            >{j.kind} {j.url ? urlLabel(j.url) : j.attachment ? 'attachment' : ''}</span
          >
          <span class="mono small muted ellipsis">{j.worker ?? '—'}</span>
          <span class="num">{j.attempts}</span>
          <span class="num dim small">{formatRelativeTime(j.created_at)}</span>
        </button>
      {:else}
        <div class="empty">{jobs ? 'no jobs' : 'loading…'}</div>
      {/each}
    </section>

    <section class="panel" aria-label="dependencies">
      <div class="ph"><span>Health</span></div>
      {#each Object.entries(health?.components ?? {}) as [name, c] (name)}
        <div class="dep">
          <span class="dot" class:ok={c.status === 'ok'} class:err={c.status !== 'ok'}></span>
          <span>{name === 'database' ? 'Postgres' : name === 'webui' ? 'Web UI' : name}</span>
          <span class="mono dim small right">{c.status}</span>
        </div>
      {/each}
      {#if bot}
        <div class="dep">
          <span
            class="dot"
            class:ok={bot.status && bot.status !== 'offline'}
            class:err={!bot.status || bot.status === 'offline'}
          ></span>
          <span>Discord</span>
          <span class="mono dim small right ellipsis">{bot.botTag ?? '—'} · {bot.status}</span>
        </div>
      {/if}
      {#if health}
        <div class="dep">
          <span class="dot ok"></span><span>Web UI uptime</span><span class="mono dim small right"
            >{uptime(health.uptime * 1000)}</span
          >
        </div>
      {/if}
    </section>
  </div>
</div>

<style>
  .workers {
    max-width: 1400px;
    margin: 0 auto;
  }
  .small {
    font-size: 12px;
  }
  .note {
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-muted);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 16px;
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }
  .facts.bottom {
    border-top: 1px solid #1f2126;
  }
  .k {
    font-size: 11px;
    color: var(--text-dim);
  }
  .v {
    margin-top: 4px;
    font-size: 13px;
    color: var(--text);
  }
  .two {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 380px;
    gap: 16px;
    align-items: start;
  }
  .ph b {
    color: var(--text-bright);
    font-weight: 500;
  }
  .linkish {
    background: none;
    border: 0;
    padding: 0;
    color: var(--text-muted);
    font: inherit;
    cursor: pointer;
  }
  .linkish.strong,
  .linkish:hover {
    color: var(--accent);
  }
  .tr:disabled {
    cursor: default;
  }
  .dep {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 16px;
    border-top: 1px solid var(--line);
    font-size: 13px;
  }
  .dep:first-of-type {
    border-top: 0;
  }
  .right {
    margin-left: auto;
  }
  @media (max-width: 1100px) {
    .two {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 640px) {
    .tbl {
      --cols: 48px 70px minmax(0, 1fr) !important;
    }
    .tbl .tr > :nth-child(n + 4) {
      display: none;
    }
  }
</style>
