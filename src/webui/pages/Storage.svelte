<script>
  import { onDestroy } from 'svelte';
  import { navigate } from '../utils/router.js';
  import { headerActions } from '../stores/header.js';
  import { formatBytes, formatRelativeTime, shortId } from '../utils/format.js';

  let data = $state(null);
  let local = $state(null);
  let failed = $state(false);
  let now = $state(Date.now());

  async function load() {
    const get = url =>
      fetch(url)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null);
    const [storage, stats] = await Promise.all([get('/api/storage'), get('/api/stats')]);
    failed = !storage;
    data = storage ?? data;
    local = stats ?? local;
    now = Date.now();
  }
  $effect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  });

  const r2 = $derived(data?.r2);
  const limit = $derived(data?.limitBytes ?? 0);
  const pct = $derived(limit && r2 ? Math.round((r2.bytes / limit) * 100) : null);
  const level = $derived(pct == null ? '' : pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok');
  // Expiry buckets are cumulative; the bar wants each slice on its own.
  const slices = $derived.by(() => {
    if (!r2?.bytes) return [];
    const { h1, h6, h24 } = r2.expiring;
    const of = limit || r2.bytes;
    return [
      { label: 'gone within 1h', bytes: h1, color: 'var(--success)' },
      { label: 'within 6h', bytes: h6 - h1, color: 'var(--chart-series-1)' },
      { label: 'within 24h', bytes: h24 - h6, color: 'var(--info)' },
      { label: 'later', bytes: r2.bytes - h24, color: 'var(--text-dim)' },
    ].map(s => ({ ...s, width: (s.bytes / of) * 100 }));
  });
  const left = ms =>
    ms <= 0
      ? 'due'
      : ms < 3_600_000
        ? `${Math.ceil(ms / 60_000)}m`
        : ms < 86_400_000
          ? `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
          : `${Math.floor(ms / 86_400_000)}d ${Math.floor((ms % 86_400_000) / 3_600_000)}h`;
  const name = key => key.split('/').pop();
  const diskPct = $derived(
    data?.disk ? Math.round((1 - data.disk.free / data.disk.total) * 100) : null
  );

  headerActions.set(actions);
  onDestroy(() => headerActions.set(null));
</script>

{#snippet actions()}
  <span class="dim small">refreshes every 30 s</span>
  <button class="btn sm" onclick={() => navigate('settings', { section: 'storage' })}>
    Limits and lifetimes
  </button>
{/snippet}

{#snippet files(title, note, rows)}
  <section class="panel tbl" aria-label={title} style="--cols: minmax(0, 1fr) 56px 80px 150px 84px">
    <div class="ph"><span>{title}</span><span class="meta">{note}</span></div>
    <div class="tr head">
      <span>file</span><span>type</span><span class="num">size</span><span>user</span><span
        class="num">expires in</span
      >
    </div>
    {#each rows as f (f.key)}
      <div class="tr">
        <a class="mono small ellipsis" href={f.url} target="_blank" rel="noreferrer" title={f.key}
          >{name(f.key)}</a
        >
        <span class="dim small">{f.type ?? '—'}</span>
        <span class="num">{f.size ? formatBytes(f.size) : '—'}</span>
        {#if f.userId}
          <a class="mono small ellipsis" href="#/users/{f.userId}">{shortId(f.userId)}</a>
        {:else}
          <span class="dim">—</span>
        {/if}
        <span class="num" class:soon={f.expiresAt - now < 3_600_000}>{left(f.expiresAt - now)}</span
        >
      </div>
    {:else}
      <div class="empty">{r2 ? 'nothing stored' : 'loading…'}</div>
    {/each}
  </section>
{/snippet}

<div class="storage stack">
  {#if failed}
    <div class="panel pb error-text small">Could not read storage. Retrying.</div>
  {/if}

  <section class="panel" aria-label="R2 usage">
    <div class="kpis" style="--kpi-cols: 5">
      <div class="kpi">
        <div class="k">R2, live</div>
        <div class="v">
          {r2 ? formatBytes(r2.bytes) : '—'}
          {#if pct != null}<span class="d {level}">{pct}%</span>{/if}
        </div>
        <div class="s">{limit ? `soft limit ${formatBytes(limit)}` : 'no soft limit set'}</div>
      </div>
      <div class="kpi">
        <div class="k">Files</div>
        <div class="v">{r2?.files?.toLocaleString() ?? '—'}</div>
        <div class="s">temporary uploads with a live link</div>
      </div>
      <div class="kpi">
        <div class="k">Freed within 1h</div>
        <div class="v">{r2 ? formatBytes(r2.expiring.h1) : '—'}</div>
        <div class="s">{r2 ? `${formatBytes(r2.expiring.h24)} within 24h` : ''}</div>
      </div>
      <div class="kpi">
        <div class="k">Local cache</div>
        <div class="v">{local?.disk_usage_formatted ?? '—'}</div>
        <div class="s">
          {#if local}
            {local.total_gifs} gifs · {local.total_videos} videos · {local.total_images} images
          {/if}
        </div>
      </div>
      <div class="kpi">
        <div class="k">Disk</div>
        <div class="v">
          {data?.disk ? formatBytes(data.disk.free) : '—'}
          {#if diskPct != null}<span class="d" class:bad={diskPct >= 90}>{diskPct}% used</span>{/if}
        </div>
        <div class="s">{data?.disk ? `free of ${formatBytes(data.disk.total)}` : ''}</div>
      </div>
    </div>
    <div class="pb usage">
      <div class="bar-track tall">
        {#each slices as s (s.label)}
          <span
            style="width: {s.width}%; background: {s.color}"
            title="{s.label}: {formatBytes(s.bytes)}"
          ></span>
        {/each}
      </div>
      <div class="legend">
        {#each slices as s (s.label)}
          <span
            ><i style="background: {s.color}"></i>{s.label}
            <b class="mono">{formatBytes(s.bytes)}</b></span
          >
        {/each}
        {#if limit && r2}
          <span class="right dim">{formatBytes(Math.max(0, limit - r2.bytes))} of headroom</span>
        {/if}
      </div>
    </div>
  </section>

  {#if r2?.deletionFailures.count}
    <div class="panel pb failures">
      <span class="dot err"></span>
      <div class="grow">
        <b
          >{r2.deletionFailures.count} expired file{r2.deletionFailures.count === 1 ? '' : 's'}
          could not be deleted from R2.</b
        >
        The cleanup job retries them.
        {#if r2.deletionFailures.lastError}
          <div class="mono small dim ellipsis" title={r2.deletionFailures.lastError}>
            {r2.deletionFailures.lastError}
          </div>
        {/if}
      </div>
      <button
        class="btn sm"
        onclick={() => navigate('logs', { search: 'r2', level: 'ERROR,WARN' })}
      >
        Logs
      </button>
    </div>
  {/if}

  <div class="two">
    {@render files('Expiring next', 'soonest first', r2?.soon ?? [])}
    {@render files('Biggest files', 'what the space goes to', r2?.biggest ?? [])}
  </div>

  {#if local}
    <section class="panel" aria-label="local cache">
      <div class="ph">
        <span>Local cache</span>
        <span class="meta"
          >{local.retention_days ? `pruned after ${local.retention_days} days` : ''}</span
        >
      </div>
      <div class="kpis" style="--kpi-cols: 3">
        {#each [['gifs', local.total_gifs, local.gifs_disk_usage_formatted], ['videos', local.total_videos, local.videos_disk_usage_formatted], ['images', local.total_images, local.images_disk_usage_formatted]] as [kind, n, size] (kind)}
          <div class="kpi">
            <div class="k">{kind}</div>
            <div class="v">{size}</div>
            <div class="s">{n?.toLocaleString()} files</div>
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>

<style>
  .storage {
    max-width: 1400px;
    margin: 0 auto;
  }
  .small {
    font-size: 12px;
  }
  .d.ok {
    color: var(--success);
  }
  .d.warn {
    color: var(--warning);
  }
  .d.bad {
    color: var(--danger);
  }
  .usage {
    border-top: 1px solid #1f2126;
  }
  .bar-track.tall {
    height: 10px;
    border-radius: 5px;
  }
  .legend {
    margin-top: 10px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .legend span {
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
    font-weight: 400;
    color: var(--text);
  }
  .right {
    margin-left: auto;
  }
  .failures {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 13px;
    border-color: var(--danger-border);
  }
  .failures b {
    color: var(--text-bright);
    font-weight: 500;
  }
  .two {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
    align-items: start;
  }
  .tr a {
    color: var(--text);
    text-decoration: none;
  }
  .tr a:hover {
    color: var(--accent);
  }
  .soon {
    color: var(--warning);
  }
  @media (max-width: 1100px) {
    .two {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 640px) {
    .tbl {
      --cols: minmax(0, 1fr) 70px 70px !important;
    }
    .tbl .tr > :nth-child(2),
    .tbl .tr > :nth-child(4) {
      display: none;
    }
  }
</style>
