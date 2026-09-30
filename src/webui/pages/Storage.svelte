<script>
  import { SlidersHorizontal, HardDrive } from 'lucide-svelte';
  import { navigate } from '../utils/router.js';
  import { formatBytes, formatRelativeTime, shortId } from '../utils/format.js';
  import PageHeader from '../components/PageHeader.svelte';
  import DataTable from '../components/DataTable.svelte';
  import Avatar from '../components/Avatar.svelte';

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
      { label: 'gone within 1h', bytes: h1, color: 'var(--chart-2)' },
      { label: 'within 6h', bytes: h6 - h1, color: 'var(--chart-1)' },
      { label: 'within 24h', bytes: h24 - h6, color: 'var(--chart-5)' },
      { label: 'later', bytes: r2.bytes - h24, color: 'var(--chart-muted)' },
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
  const diskLevel = $derived(
    diskPct == null ? '' : diskPct >= 90 ? 'bad' : diskPct >= 75 ? 'warn' : 'ok'
  );

  const FILE_COLUMNS = [
    { key: 'file', label: 'file' },
    { key: 'type', label: 'type', width: '60px', sm: false },
    { key: 'size', label: 'size', width: '84px', align: 'right' },
    { key: 'user', label: 'user', width: '120px', sm: false },
    { key: 'exp', label: 'expires in', width: '90px', align: 'right' },
  ];
</script>

<PageHeader
  title="Storage"
  description="What is in R2 right now, when it leaves, and what the local cache holds. Refreshes every 30 seconds."
>
  {#snippet actions()}
    {#if pct != null}<span class="pill {level}">{pct}% of soft limit</span>{/if}
    <button class="btn" onclick={() => navigate('settings', { section: 'storage' })}>
      <SlidersHorizontal size={14} />Limits and lifetimes
    </button>
  {/snippet}
</PageHeader>

{#snippet files(title, note, rows)}
  <DataTable
    {title}
    columns={FILE_COLUMNS}
    {rows}
    rowKey="key"
    loading={!r2}
    empty="nothing stored"
    href={f => f.url}
    label={title}
  >
    {#snippet header()}<span class="dim">{note}</span>{/snippet}
    {#snippet row(f)}
      <span class="mono ellipsis" title={f.key}>{name(f.key)}</span>
      <span class="hide-sm"><span class="chip">{f.type ?? '—'}</span></span>
      <span class="num strong">{f.size ? formatBytes(f.size) : '—'}</span>
      <span class="hide-sm">
        {#if f.userId}
          <span class="user-cell"
            ><Avatar id={f.userId} size={20} /><button
              class="linkish mono id"
              onclick={e => {
                e.preventDefault();
                e.stopPropagation();
                navigate('user-profile', { userId: f.userId });
              }}>{shortId(f.userId)}</button
            ></span
          >
        {:else}
          <span class="dim">—</span>
        {/if}
      </span>
      <span class="num" class:warn-text={f.expiresAt - now < 3_600_000}
        >{left(f.expiresAt - now)}</span
      >
    {/snippet}
  </DataTable>
{/snippet}

<div class="storage stack">
  {#if failed}
    <div class="flash error">Could not read storage. Retrying.</div>
  {/if}

  <section class="kpis" style="--kpi-cols: 5" aria-label="storage numbers">
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
      <div class="k">Local disk</div>
      <div class="v">
        {data?.disk ? formatBytes(data.disk.free) : '—'}
        {#if diskPct != null}<span class="d {diskLevel}">{diskPct}% used</span>{/if}
      </div>
      <div class="s">{data?.disk ? `free of ${formatBytes(data.disk.total)}` : ''}</div>
    </div>
  </section>

  <section class="panel" aria-label="R2 usage">
    <div class="ph">
      <span>R2 usage by time to expiry</span>
      <span class="meta">
        {#if limit && r2}<span class="dim"
            >{formatBytes(Math.max(0, limit - r2.bytes))} of headroom</span
          >{/if}
      </span>
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
      </div>
    </div>
  </section>

  {#if r2?.deletionFailures.count}
    <div class="flash error">
      <HardDrive size={14} />
      <span class="grow">
        <b
          >{r2.deletionFailures.count} expired file{r2.deletionFailures.count === 1 ? '' : 's'}
          could not be deleted from R2.</b
        >
        The cleanup job retries them.
        {#if r2.deletionFailures.lastError}
          <span class="mono small" title={r2.deletionFailures.lastError}
            >{r2.deletionFailures.lastError}</span
          >
        {/if}
      </span>
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
      <div class="pb cache">
        {#each [['gifs', local.total_gifs, local.gifs_disk_usage_formatted], ['videos', local.total_videos, local.videos_disk_usage_formatted], ['images', local.total_images, local.images_disk_usage_formatted]] as [kind, n, size] (kind)}
          <div class="cache-item">
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
  .legend {
    margin-top: 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 20px;
    font-size: var(--fs-sm);
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
    font-weight: 500;
    color: var(--text);
  }
  .cache {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--gap);
  }
  .cache-item {
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--card-2);
  }
  .cache .k {
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-muted);
    text-transform: capitalize;
  }
  .cache .v {
    margin-top: 6px;
    font-size: var(--fs-xl);
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--text-bright);
  }
  .cache .s {
    margin-top: 4px;
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }
  .flash b {
    color: inherit;
  }
  @media (max-width: 640px) {
    .cache {
      grid-template-columns: 1fr;
    }
  }
</style>
