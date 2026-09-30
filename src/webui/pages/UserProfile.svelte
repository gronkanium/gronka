<script>
  import { onDestroy } from 'svelte';
  import { TerminalSquare, Activity, Copy, Ban, ExternalLink } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { headerActions } from '../stores/header.js';
  import { formatBytes, formatDuration, formatRelativeTime, urlLabel } from '../utils/format.js';

  const OPS = 10;
  const MEDIA = 12;

  let user = $state(null);
  let metrics = $state(null);
  let error = $state('');
  let ops = $state([]);
  let opsTotal = $state(0);
  let opsOffset = $state(0);
  let media = $state([]);
  let mediaTotal = $state(0);
  let mediaOffset = $state(0);
  let ban = $state(null);
  let banOpen = $state(false);
  let banReason = $state('');
  let busy = $state(false);
  let copied = $state(false);

  const userId = $derived($currentRoute.params.userId);
  const get = url =>
    fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));

  async function loadProfile(id) {
    error = '';
    user = metrics = null;
    try {
      const data = await get(`/api/users/${id}`);
      user = data.user;
      metrics = data.metrics;
    } catch {
      error = 'no user with this id';
    }
    const bans = await get('/api/bans').catch(() => null);
    ban = bans?.bans?.find(b => b.user_id === id) ?? null;
  }
  $effect(() => {
    opsOffset = 0;
    mediaOffset = 0;
    if (userId) loadProfile(userId);
  });
  $effect(() => {
    if (!userId) return;
    get(`/api/users/${userId}/operations?limit=${OPS}&offset=${opsOffset}`)
      .then(d => {
        ops = d.operations ?? [];
        opsTotal = d.total ?? 0;
      })
      .catch(() => (ops = []));
  });
  $effect(() => {
    if (!userId) return;
    get(`/api/users/${userId}/media?limit=${MEDIA}&offset=${mediaOffset}`)
      .then(d => {
        media = d.media ?? [];
        mediaTotal = d.total ?? 0;
      })
      .catch(() => (media = []));
  });

  const rate = $derived(
    metrics?.total_commands
      ? ((metrics.successful_commands / metrics.total_commands) * 100).toFixed(1)
      : null
  );
  const split = $derived(
    metrics
      ? [
          ['download', metrics.total_download],
          ['convert', metrics.total_convert],
          ['optimize', metrics.total_optimize],
        ]
      : []
  );
  const splitMax = $derived(Math.max(1, ...split.map(([, n]) => n)));

  async function doBan() {
    busy = true;
    const res = await fetch('/api/bans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, reason: banReason.trim() }),
    }).catch(() => null);
    busy = false;
    if (res?.ok) {
      banOpen = false;
      banReason = '';
      loadProfile(userId);
    }
  }
  async function unban() {
    if (!confirm(`Unban ${userId}?`)) return;
    busy = true;
    await fetch(`/api/bans/${userId}`, { method: 'DELETE' }).catch(() => null);
    busy = false;
    loadProfile(userId);
  }
  function copyId() {
    navigator.clipboard?.writeText(userId);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }

  headerActions.set(actions);
  onDestroy(() => headerActions.set(null));
</script>

{#snippet actions()}
  <button class="btn" onclick={() => navigate('requests', { userId })}
    ><Activity size={13} />Requests</button
  >
  <button class="btn" onclick={() => navigate('logs', { user: userId, range: '7d' })}
    ><TerminalSquare size={13} />Logs</button
  >
{/snippet}

<div class="profile stack">
  <div class="crumbs">
    <button class="linkish" onclick={() => navigate('users')}>Users</button>
    <span class="dim">/</span>
    <span class="mono">{userId}</span>
  </div>

  {#if error}
    <div class="panel empty">{error}</div>
  {:else}
    <div class="head">
      <div class="avatar mono">{userId?.slice(-2)}</div>
      <div class="grow">
        <div class="row">
          <h2 class="mono">{userId}</h2>
          <button class="iconbtn" onclick={copyId} title="copy id" aria-label="copy user id"
            ><Copy size={14} /></button
          >
          {#if copied}<span class="dim small">copied</span>{/if}
          {#if ban}<span class="chip bad">banned</span>{/if}
        </div>
        <div class="sub">
          {#if user?.first_used}first seen {new Date(user.first_used).toLocaleDateString()} ·
          {/if}
          last seen {formatRelativeTime(metrics?.last_command_at ?? user?.last_used)}
        </div>
      </div>
      {#if ban}
        <button class="btn" disabled={busy} onclick={unban}>Unban</button>
      {:else}
        <button class="btn danger" onclick={() => (banOpen = !banOpen)}><Ban size={13} />Ban</button
        >
      {/if}
    </div>

    {#if ban}
      <div class="panel pb banned">
        Banned {formatRelativeTime(ban.banned_at)}: <b>{ban.reason}</b>{ban.appeal_allowed
          ? ''
          : ' (no appeal)'}
      </div>
    {/if}
    {#if banOpen && !ban}
      <div class="panel pb banform">
        <input
          class="field grow"
          bind:value={banReason}
          placeholder="reason (the user sees it when appealing)"
          maxlength="200"
        />
        <button class="btn danger" disabled={busy || !banReason.trim()} onclick={doBan}
          >Confirm ban</button
        >
      </div>
    {/if}

    <section class="panel kpis" style="--kpi-cols: 5">
      <div class="kpi">
        <div class="k">Requests</div>
        <div class="v">{metrics?.total_commands?.toLocaleString() ?? '—'}</div>
        <div class="s">all time</div>
      </div>
      <div class="kpi">
        <div class="k">Delivered</div>
        <div class="v">{rate == null ? '—' : `${rate}%`}</div>
        <div class="s">{metrics?.successful_commands?.toLocaleString() ?? 0} ok</div>
      </div>
      <div class="kpi">
        <div class="k">Failed</div>
        <div class="v">{metrics?.failed_commands?.toLocaleString() ?? '—'}</div>
        <div class="s">user and site errors included</div>
      </div>
      <div class="kpi">
        <div class="k">Data</div>
        <div class="v">{metrics ? formatBytes(metrics.total_file_size) : '—'}</div>
        <div class="s">processed for them</div>
      </div>
      <div class="kpi">
        <div class="k">Stored files</div>
        <div class="v">{mediaTotal.toLocaleString()}</div>
        <div class="s">in the URL cache</div>
      </div>
    </section>

    <div class="two">
      <section
        class="panel tbl"
        aria-label="requests"
        style="--cols: 12px 76px minmax(0, 1fr) 70px 80px"
      >
        <div class="ph">
          <span>Requests</span><span class="meta mono">{opsTotal} kept, 7 days</span>
        </div>
        {#each ops as r (r.id)}
          <button class="tr" onclick={() => navigate('request', { requestId: r.id })}>
            <span
              class="dot"
              class:ok={r.status === 'success'}
              class:bad={r.status === 'error'}
              class:run={r.status === 'running'}
            ></span>
            <span class="muted">{r.type}</span>
            <span class="mono small ellipsis">{urlLabel(r.originalUrl)}</span>
            <span class="num small muted"
              >{r.performanceMetrics?.duration
                ? formatDuration(r.performanceMetrics.duration)
                : '—'}</span
            >
            <span class="num small dim">{formatRelativeTime(r.timestamp)}</span>
          </button>
        {:else}
          <div class="empty">no requests in the last 7 days</div>
        {/each}
        {#if opsTotal > OPS}
          <div class="pager">
            <span class="dim"
              >{opsOffset + 1}–{Math.min(opsOffset + OPS, opsTotal)} of {opsTotal}</span
            >
            <span class="row">
              <button class="btn sm" disabled={opsOffset === 0} onclick={() => (opsOffset -= OPS)}
                >Previous</button
              >
              <button
                class="btn sm"
                disabled={opsOffset + OPS >= opsTotal}
                onclick={() => (opsOffset += OPS)}>Next</button
              >
            </span>
          </div>
        {/if}
      </section>

      <section class="panel" aria-label="commands">
        <div class="ph"><span>Commands</span></div>
        <div class="pb split">
          {#each split as [name, n] (name)}
            <span>/{name}</span>
            <span class="bar-track"
              ><span style="width:{(n / splitMax) * 100}%; background: var(--chart-series-1)"
              ></span></span
            >
            <span class="num small muted">{n.toLocaleString()}</span>
          {/each}
        </div>
      </section>
    </div>

    <section
      class="panel tbl"
      aria-label="stored files"
      style="--cols: 64px minmax(0, 1fr) 90px 100px 28px"
    >
      <div class="ph">
        <span>Stored files</span><span class="meta mono">{mediaTotal} total</span>
      </div>
      {#each media as m, i (m.file_url + i)}
        <a class="tr" href={m.file_url} target="_blank" rel="noreferrer">
          <span class="chip">{m.file_type}</span>
          <span class="mono small ellipsis">{urlLabel(m.file_url)}</span>
          <span class="num small muted">{formatBytes(m.file_size)}</span>
          <span class="num small dim">{formatRelativeTime(m.processed_at)}</span>
          <span class="dim"><ExternalLink size={13} /></span>
        </a>
      {:else}
        <div class="empty">nothing stored</div>
      {/each}
      {#if mediaTotal > MEDIA}
        <div class="pager">
          <span class="dim"
            >{mediaOffset + 1}–{Math.min(mediaOffset + MEDIA, mediaTotal)} of {mediaTotal}</span
          >
          <span class="row">
            <button
              class="btn sm"
              disabled={mediaOffset === 0}
              onclick={() => (mediaOffset -= MEDIA)}>Previous</button
            >
            <button
              class="btn sm"
              disabled={mediaOffset + MEDIA >= mediaTotal}
              onclick={() => (mediaOffset += MEDIA)}>Next</button
            >
          </span>
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .profile {
    max-width: 1400px;
    margin: 0 auto;
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  .linkish {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }
  .small {
    font-size: 12px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .avatar {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--info-bg);
    color: var(--accent);
    font-size: 14px;
    flex-shrink: 0;
  }
  h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 500;
    color: var(--text-bright);
  }
  .sub {
    margin-top: 3px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .iconbtn {
    display: flex;
    padding: 4px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
  }
  .iconbtn:hover {
    color: var(--text-bright);
    background: var(--surface-2);
  }
  .banned {
    border-color: var(--danger-border);
    background: var(--danger-bg-subtle);
    font-size: 13px;
    color: #f0c9c9;
  }
  .banform {
    display: flex;
    gap: 8px;
  }
  .two {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    gap: 16px;
    align-items: start;
  }
  .split {
    display: grid;
    grid-template-columns: 80px 1fr 60px;
    gap: 14px 12px;
    align-items: center;
    font-size: 13px;
  }
  .pager {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-top: 1px solid var(--line);
    font-size: 12px;
  }
  @media (max-width: 1000px) {
    .two {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 640px) {
    .head {
      flex-wrap: wrap;
    }
    h2 {
      font-size: 14px;
    }
  }
</style>
