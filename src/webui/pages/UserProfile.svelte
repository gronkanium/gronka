<script>
  import {
    TerminalSquare,
    Activity,
    Copy,
    Ban,
    ExternalLink,
    ShieldOff,
    Check,
  } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import {
    formatBytes,
    formatDate,
    formatDateTime,
    formatDuration,
    formatRelativeTime,
    urlLabel,
  } from '../utils/format.js';
  import PageHeader from '../components/PageHeader.svelte';
  import DataTable from '../components/DataTable.svelte';
  import MediaThumb from '../components/MediaThumb.svelte';
  import Avatar from '../components/Avatar.svelte';

  const OPS = 10;
  const MEDIA = 12;
  const STATUS = {
    success: ['ok', 'Delivered'],
    error: ['bad', 'Failed'],
    running: ['info', 'Running'],
    pending: ['idle', 'Queued'],
  };
  const SPLIT_COLORS = ['var(--chart-1)', 'var(--chart-5)', 'var(--chart-6)'];

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
  const splitTotal = $derived(
    Math.max(
      1,
      split.reduce((s, [, n]) => s + n, 0)
    )
  );
  const failedRecent = $derived(ops.filter(o => o.status === 'error').length);
  const description = $derived(
    [
      user?.first_used && `First seen ${formatDate(user.first_used)}`,
      `last seen ${formatRelativeTime(metrics?.last_command_at ?? user?.last_used)}`,
    ]
      .filter(Boolean)
      .join(' · ')
  );

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
</script>

<PageHeader
  title={userId}
  mono
  crumbs={[{ label: 'Users', page: 'users' }]}
  description={error ? '' : description}
>
  {#if ban}<span class="pill bad">Banned</span>{/if}
  <button class="icon-btn sm" onclick={copyId} title="copy id" aria-label="copy user id"
    >{#if copied}<Check size={14} />{:else}<Copy size={14} />{/if}</button
  >
  {#snippet actions()}
    <button class="btn" onclick={() => navigate('requests', { userId })}
      ><Activity size={14} />Requests</button
    >
    <button class="btn" onclick={() => navigate('logs', { user: userId, range: '7d' })}
      ><TerminalSquare size={14} />Logs</button
    >
    {#if ban}
      <button class="btn" disabled={busy} onclick={unban}><ShieldOff size={14} />Unban</button>
    {:else}
      <button class="btn danger" onclick={() => (banOpen = !banOpen)}><Ban size={14} />Ban</button>
    {/if}
  {/snippet}
</PageHeader>

<div class="profile stack">
  {#if error}
    <div class="panel empty big">
      <b>No user with this id</b>Check the id, or find them in Users
    </div>
  {:else}
    {#if ban}
      <div class="flash error">
        <Ban size={14} />
        <span
          >Banned {formatRelativeTime(ban.banned_at)}: <b>{ban.reason}</b>{ban.appeal_allowed
            ? ''
            : ' (no appeal)'}</span
        >
      </div>
    {/if}
    {#if banOpen && !ban}
      <div class="panel pb banform">
        <Avatar id={userId} size={32} />
        <input
          class="field grow"
          bind:value={banReason}
          placeholder="Reason (the user sees it when appealing)"
          maxlength="200"
        />
        <button class="btn danger solid" disabled={busy || !banReason.trim()} onclick={doBan}
          >Confirm ban</button
        >
        <button class="btn ghost" onclick={() => (banOpen = false)}>Cancel</button>
      </div>
    {/if}

    <section class="kpis" style="--kpi-cols: 4">
      <div class="kpi">
        <div class="k">Requests</div>
        <div class="v">{metrics?.total_commands?.toLocaleString() ?? '—'}</div>
        <div class="s">all time</div>
      </div>
      <div class="kpi" class:bad={rate != null && rate < 80}>
        <div class="k">Delivered</div>
        <div class="v">
          {rate == null ? '—' : rate}{#if rate != null}<span class="unit">%</span>{/if}
        </div>
        <div class="s">{metrics?.successful_commands?.toLocaleString() ?? 0} delivered</div>
      </div>
      <div class="kpi">
        <div class="k">Failed</div>
        <div class="v">{metrics?.failed_commands?.toLocaleString() ?? '—'}</div>
        {#if failedRecent}<span class="d warn">{failedRecent} in the last 7 days</span>{/if}
        <div class="s">user and site errors included</div>
      </div>
      <div class="kpi">
        <div class="k">Data</div>
        <div class="v">{metrics ? formatBytes(metrics.total_file_size) : '—'}</div>
        <div class="s">processed for them</div>
      </div>
    </section>

    <section class="panel" aria-label="commands">
      <div class="pb split">
        <span class="section-label">Commands</span>
        <div class="bar-track tall">
          {#each split as [name, n], i (name)}
            <span
              style="width:{(n / splitTotal) * 100}%; background:{SPLIT_COLORS[i]}"
              title="/{name}: {n}"
            ></span>
          {/each}
        </div>
        <div class="legend">
          {#each split as [name, n], i (name)}
            <span
              ><i style="background:{SPLIT_COLORS[i]}"></i><span class="mono">/{name}</span>
              <b>{n.toLocaleString()}</b><span class="dim"
                >{Math.round((n / splitTotal) * 100)}%</span
              ></span
            >
          {/each}
        </div>
      </div>
    </section>

    <div class="two wide-left">
      <DataTable
        title="Recent requests"
        columns={[
          { key: 'st', label: 'Status', width: '100px' },
          { key: 'type', label: 'Command', width: '84px', sm: false },
          { key: 'link', label: 'Link' },
          { key: 'took', label: 'Took', width: '70px', align: 'right', sm: false },
          { key: 'when', label: 'When', width: '80px', align: 'right' },
        ]}
        rows={ops}
        loading={opsLoading}
        empty="No requests in the last 7 days"
        onrow={r => navigate('request', { requestId: r.id })}
        pager={{ offset: opsOffset, limit: OPS, total: opsTotal, onpage: o => (opsOffset = o) }}
        skeleton={5}
      >
        {#snippet header()}<span class="tnum">{opsTotal} kept, 7 days</span>{/snippet}
        {#snippet row(r)}
          {@const [kind, label] = STATUS[r.status] ?? ['idle', r.status]}
          <span><span class="pill sm {kind}">{label}</span></span>
          <span class="soft hide-sm">/{r.type}</span>
          <span class="ellipsis">
            <span class="mono">{urlLabel(r.originalUrl)}</span>
            {#if r.status === 'error' && r.error}<span class="errline" title={r.error}
                >· {r.error}</span
              >{/if}
          </span>
          <span class="num muted hide-sm"
            >{r.performanceMetrics?.duration
              ? formatDuration(r.performanceMetrics.duration)
              : '—'}</span
          >
          <span class="num dim" title={formatDateTime(r.timestamp)}
            >{formatRelativeTime(r.timestamp)}</span
          >
        {/snippet}
      </DataTable>

      <DataTable
        title="Stored files"
        columns={[
          { key: 'thumb', label: '', width: '36px' },
          { key: 'file', label: 'File' },
          { key: 'size', label: 'Size', width: '80px', align: 'right' },
          { key: 'open', label: '', width: '20px' },
        ]}
        rows={media}
        rowKey={(m, i) => `${m.file_url}#${i}`}
        loading={mediaLoading}
        empty="Nothing stored"
        href={m => m.file_url}
        pager={{
          offset: mediaOffset,
          limit: MEDIA,
          total: mediaTotal,
          onpage: o => (mediaOffset = o),
        }}
        skeleton={4}
      >
        {#snippet header()}<span class="tnum">{mediaTotal} in the URL cache</span>{/snippet}
        {#snippet row(m)}
          <MediaThumb url={m.file_url} type={m.file_type} size={28} />
          <span class="filecell">
            <span class="mono ellipsis">{urlLabel(m.file_url).split('/').pop()}</span>
            <span class="dim xs">{m.file_type} · {formatRelativeTime(m.processed_at)}</span>
          </span>
          <span class="num muted">{formatBytes(m.file_size)}</span>
          <span class="dim"><ExternalLink size={13} /></span>
        {/snippet}
      </DataTable>
    </div>
  {/if}
</div>

<style>
  .banform {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .split {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 20px;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .legend > span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .legend i {
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
  .legend b {
    font-weight: 600;
    color: var(--text-bright);
    font-variant-numeric: tabular-nums;
  }
  .errline {
    font-size: var(--fs-sm);
    color: var(--danger-text);
  }
  .filecell {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.3;
  }
</style>
