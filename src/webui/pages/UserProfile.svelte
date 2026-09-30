<script>
  import { TerminalSquare, Activity, Copy, Ban, ExternalLink, ShieldOff } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { useHeaderActions, useCrumbs } from '../stores/header.js';
  import { formatBytes, formatDuration, formatRelativeTime, urlLabel } from '../utils/format.js';
  import DataTable from '../components/DataTable.svelte';
  import MediaThumb from '../components/MediaThumb.svelte';

  const OPS = 10;
  const MEDIA = 12;

  let user = $state(null);
  let metrics = $state(null);
  let error = $state('');
  let ops = $state([]);
  let opsTotal = $state(0);
  let opsOffset = $state(0);
  let opsLoading = $state(true);
  let media = $state([]);
  let mediaTotal = $state(0);
  let mediaOffset = $state(0);
  let mediaLoading = $state(true);
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
    opsLoading = true;
    get(`/api/users/${userId}/operations?limit=${OPS}&offset=${opsOffset}`)
      .then(d => {
        ops = d.operations ?? [];
        opsTotal = d.total ?? 0;
      })
      .catch(() => (ops = []))
      .finally(() => (opsLoading = false));
  });
  $effect(() => {
    if (!userId) return;
    mediaLoading = true;
    get(`/api/users/${userId}/media?limit=${MEDIA}&offset=${mediaOffset}`)
      .then(d => {
        media = d.media ?? [];
        mediaTotal = d.total ?? 0;
      })
      .catch(() => (media = []))
      .finally(() => (mediaLoading = false));
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
  const splitTotal = $derived(Math.max(1, ...[split.reduce((s, [, n]) => s + n, 0)]));
  const failedRecent = $derived(ops.filter(o => o.status === 'error').length);

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

  const setCrumbs = useCrumbs();
  $effect(() =>
    setCrumbs([
      { label: 'Users', page: 'users' },
      { label: userId, mono: true },
    ])
  );
  useHeaderActions(actions);
</script>

{#snippet actions()}
  <button class="btn" onclick={() => navigate('requests', { userId })}
    ><Activity size={13} />Requests</button
  >
  <button class="btn" onclick={() => navigate('logs', { user: userId, range: '7d' })}
    ><TerminalSquare size={13} />Logs</button
  >
  {#if ban}
    <button class="btn" disabled={busy} onclick={unban}><ShieldOff size={13} />Unban</button>
  {:else}
    <button class="btn danger" onclick={() => (banOpen = !banOpen)}><Ban size={13} />Ban</button>
  {/if}
{/snippet}

<div class="profile stack">
  {#if error}
    <div class="panel empty">{error}</div>
  {:else}
    <div class="head">
      <div class="avatar mono">{userId?.slice(-2)}</div>
      <div class="grow">
        <div class="row">
          <h2 class="mono">{userId}</h2>
          <button class="icon-btn sm" onclick={copyId} title="copy id" aria-label="copy user id"
            ><Copy size={13} /></button
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
    </div>

    {#if ban}
      <div class="flash error">
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
        <button class="btn ghost" onclick={() => (banOpen = false)}>Cancel</button>
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
        <div class="v">
          {rate == null ? '—' : `${rate}%`}
        </div>
        <div class="s">{metrics?.successful_commands?.toLocaleString() ?? 0} ok</div>
      </div>
      <div class="kpi">
        <div class="k">Failed</div>
        <div class="v">
          {metrics?.failed_commands?.toLocaleString() ?? '—'}
          {#if failedRecent}<span class="d warn">{failedRecent} recent</span>{/if}
        </div>
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

    <div class="two wide-left">
      <DataTable
        title="Requests"
        columns={[
          { key: 'st', label: '', width: '12px' },
          { key: 'type', label: 'command', width: '76px' },
          { key: 'link', label: 'link' },
          { key: 'took', label: 'took', width: '70px', align: 'right', sm: false },
          { key: 'when', label: 'when', width: '80px', align: 'right' },
        ]}
        rows={ops}
        loading={opsLoading}
        empty="no requests in the last 7 days"
        onrow={r => navigate('request', { requestId: r.id })}
        pager={{ offset: opsOffset, limit: OPS, total: opsTotal, onpage: o => (opsOffset = o) }}
        skeleton={5}
      >
        {#snippet header()}<span class="mono">{opsTotal} kept, 7 days</span>{/snippet}
        {#snippet row(r)}
          <span
            class="dot"
            class:ok={r.status === 'success'}
            class:err={r.status === 'error'}
            class:run={r.status === 'running'}
          ></span>
          <span class="muted">{r.type}</span>
          <span class="linkcell">
            <span class="mono small ellipsis">{urlLabel(r.originalUrl)}</span>
            {#if r.status === 'error' && r.error}<span class="errline ellipsis">{r.error}</span
              >{/if}
          </span>
          <span class="num muted hide-sm"
            >{r.performanceMetrics?.duration
              ? formatDuration(r.performanceMetrics.duration)
              : '—'}</span
          >
          <span class="num dim">{formatRelativeTime(r.timestamp)}</span>
        {/snippet}
      </DataTable>

      <section class="panel" aria-label="commands">
        <div class="ph"><span>Commands</span><span class="meta">share of requests</span></div>
        <div class="pb split">
          {#each split as [name, n] (name)}
            <span class="mono">/{name}</span>
            <span class="bar-track"
              ><span style="width:{(n / splitTotal) * 100}%; background: var(--chart-1)"
              ></span></span
            >
            <span class="num muted">{n.toLocaleString()}</span>
            <span class="num dim">{Math.round((n / splitTotal) * 100)}%</span>
          {/each}
        </div>
      </section>
    </div>

    <DataTable
      title="Stored files"
      columns={[
        { key: 'thumb', label: '', width: '44px' },
        { key: 'type', label: 'type', width: '64px' },
        { key: 'file', label: 'file' },
        { key: 'size', label: 'size', width: '90px', align: 'right', sm: false },
        { key: 'when', label: 'created', width: '90px', align: 'right', sm: false },
        { key: 'open', label: '', width: '28px' },
      ]}
      rows={media}
      rowKey={(m, i) => `${m.file_url}#${i}`}
      loading={mediaLoading}
      empty="nothing stored"
      href={m => m.file_url}
      pager={{
        offset: mediaOffset,
        limit: MEDIA,
        total: mediaTotal,
        onpage: o => (mediaOffset = o),
      }}
      skeleton={4}
    >
      {#snippet header()}<span class="mono">{mediaTotal} total</span>{/snippet}
      {#snippet row(m)}
        <MediaThumb url={m.file_url} type={m.file_type} size={36} />
        <span><span class="chip">{m.file_type}</span></span>
        <span class="mono small ellipsis">{urlLabel(m.file_url)}</span>
        <span class="num muted hide-sm">{formatBytes(m.file_size)}</span>
        <span class="num dim hide-sm">{formatRelativeTime(m.processed_at)}</span>
        <span class="dim"><ExternalLink size={13} /></span>
      {/snippet}
    </DataTable>
  {/if}
</div>

<style>
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
    background: var(--accent-bg);
    color: var(--accent);
    font-size: var(--fs-md);
    flex-shrink: 0;
    border: 1px solid var(--accent-border);
  }
  h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 500;
    color: var(--text-bright);
  }
  .sub {
    margin-top: 3px;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .banform {
    display: flex;
    gap: 8px;
  }
  .split {
    display: grid;
    grid-template-columns: 80px 1fr 60px 44px;
    gap: 14px 12px;
    align-items: center;
    font-size: var(--fs);
  }
  .linkcell {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 6px 0;
  }
  .errline {
    font-size: var(--fs-sm);
    color: var(--danger-text);
  }
  @media (max-width: 640px) {
    .head {
      flex-wrap: wrap;
    }
    h2 {
      font-size: var(--fs-md);
    }
  }
</style>
