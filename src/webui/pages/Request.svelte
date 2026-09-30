<script>
  import { Check, X, Loader, Copy, TerminalSquare, Ban, ExternalLink } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import {
    formatBytes,
    formatDuration,
    formatRelativeTime,
    hostOf,
    urlLabel,
    shortId,
  } from '../utils/format.js';
  import PageHeader from '../components/PageHeader.svelte';
  import Avatar from '../components/Avatar.svelte';

  let op = $state(null);
  let trace = $state(null);
  let logs = $state([]);
  let jobs = $state([]);
  let related = $state({ sameUrl: null, user: null });
  let error = $state('');
  let banOpen = $state(false);
  let banReason = $state('');
  let banStatus = $state('');
  let copied = $state(false);

  const id = $derived($currentRoute.params.requestId);
  const json = url =>
    fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));

  async function load(requestId) {
    error = '';
    op = null;
    try {
      const data = await json(`/api/operations/${encodeURIComponent(requestId)}`);
      op = data.operation;
      trace = data.trace;
    } catch {
      error = 'This request is not in the history any more. Requests are kept for 7 days.';
      return;
    }
    const start = op.timestamp;
    const [l, j, same, user] = await Promise.all([
      json(
        `/api/logs?op=${encodeURIComponent(requestId)}&orderDesc=false&limit=500&startTime=${start - 60e3}&endTime=${start + 20 * 60e3}`
      ).catch(() => null),
      json(`/api/system/jobs/${encodeURIComponent(requestId)}`).catch(() => null),
      op.originalUrl
        ? json(
            `/api/requests?urlPattern=${encodeURIComponent(op.originalUrl.split('?')[0])}&limit=1`
          ).catch(() => null)
        : null,
      json(
        `/api/requests?userId=${op.userId}&dateFrom=${Date.now() - 24 * 3600e3}&limit=500`
      ).catch(() => null),
    ]);
    logs = l?.logs ?? [];
    jobs = j?.jobs ?? [];
    related = {
      sameUrl: same ? Math.max(0, (same.total ?? 1) - 1) : null,
      user: user
        ? {
            total: user.total,
            failed: (user.requests ?? []).filter(r => r.status === 'error').length,
          }
        : null,
    };
  }

  $effect(() => {
    if (id) load(id);
  });

  const STEP_LABELS = {
    pending: 'received',
    running: 'started',
    success: 'delivered',
    error: 'failed',
  };

  // One timeline from the operation's status steps plus every log line stamped with this request.
  const timeline = $derived.by(() => {
    if (!op) return null;
    const events = [
      ...(trace?.logs ?? []).map(s => ({
        at: s.timestamp,
        label:
          s.step === 'created'
            ? `received /${op.type}`
            : s.status === 'error'
              ? `failed: ${s.message}`
              : (STEP_LABELS[s.status] ?? s.message),
        kind: s.status === 'error' ? 'err' : s.status === 'success' ? 'ok' : 'step',
        group: 'bot',
      })),
      ...logs.map(l => ({
        at: l.timestamp,
        label: l.message,
        kind: l.level === 'ERROR' ? 'err' : l.level === 'WARN' ? 'warn' : 'log',
        component: l.component,
        group: l.metadata?.worker ?? 'bot',
      })),
    ].sort((a, b) => a.at - b.at);
    if (!events.length) return null;
    const start = events[0].at;
    const end = Math.max(events.at(-1).at, op.latestTimestamp ?? 0, start + 1);
    const span = end - start;
    const groups = [];
    events.forEach((e, i) => {
      const next = events[i + 1]?.at ?? end;
      const row = {
        ...e,
        left: ((e.at - start) / span) * 100,
        width: Math.max(0.6, ((next - e.at) / span) * 100),
        took: next - e.at,
        offset: e.at - start,
      };
      if (groups.at(-1)?.group !== e.group) groups.push({ group: e.group, start: e.at, rows: [] });
      groups.at(-1).rows.push(row);
    });
    return { span, groups };
  });

  const job = $derived(jobs.at(-1));
  // Auto-timeouts record their reason only as a trace step, not on the operation.
  const failure = $derived(op?.error || trace?.errorSteps?.at(-1)?.message || '');
  const statusTitle = $derived(
    !op
      ? ''
      : op.status === 'success'
        ? op.sourceUrl && !op.fileSize
          ? 'Delivered as a link'
          : 'Delivered'
        : op.status === 'error'
          ? 'Failed'
          : op.status
  );
  const statusKind = $derived(
    op?.status === 'success' ? 'ok' : op?.status === 'error' ? 'bad' : 'info'
  );
  const description = $derived(
    op
      ? [
          op.originalUrl ? urlLabel(op.originalUrl) : 'attachment',
          op.fileSize && formatBytes(op.fileSize),
          op.performanceMetrics?.duration &&
            `${formatDuration(op.performanceMetrics.duration)} end to end`,
          formatRelativeTime(op.timestamp),
        ]
          .filter(Boolean)
          .join(' · ')
      : ''
  );
  const workerLabel = (g, i) => (g === 'bot' ? 'Bot (gateway)' : `Attempt ${i} · ${g}`);
  const stamp = t =>
    new Date(t).toLocaleTimeString([], { hour12: false }) + '.' + String(t % 1000).padStart(3, '0');
  const took = ms => (ms < 1000 ? `${ms}ms` : formatDuration(ms));
  const plus = ms => (ms < 1000 ? `+${ms}ms` : `+${(ms / 1000).toFixed(2)}s`);

  async function ban() {
    banStatus = '';
    const res = await fetch('/api/bans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: op.userId, reason: banReason.trim() }),
    }).catch(() => null);
    banStatus = res?.ok ? 'banned' : 'could not ban';
    if (res?.ok) banOpen = false;
  }

  function copyLink() {
    navigator.clipboard?.writeText(location.href);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }
</script>

<PageHeader
  title={op ? `/${op.type}` : 'Request'}
  crumbs={[{ label: 'Requests', page: 'requests' }]}
  {description}
>
  {#if op}
    <span class="pill {statusKind}"
      >{#if op.status === 'success'}<Check size={12} />{:else if op.status === 'error'}<X
          size={12}
        />{:else}<Loader size={12} />{/if}{statusTitle}</span
    >
    {#if job && job.attempts > 1}<span class="chip warn">retried {job.attempts - 1}×</span>{/if}
    {#if /timed out/i.test(failure)}<span class="chip bad">timed out</span>{/if}
  {/if}
  {#snippet actions()}
    <button class="btn" onclick={() => navigate('logs', { op: id })}
      ><TerminalSquare size={14} />View logs</button
    >
    <button class="btn" onclick={copyLink}
      ><Copy size={14} />{copied ? 'Copied' : 'Copy link'}</button
    >
  {/snippet}
</PageHeader>

<div class="request">
  {#if error}
    <div class="panel empty big"><b>Not found</b>{error}</div>
  {:else if !op}
    <div class="panel">
      <div class="skel-rows">
        <span class="skeleton" style="width:40%;height:20px"></span>
        <span class="skeleton" style="width:60%"></span>
        <span class="skeleton" style="width:30%"></span>
      </div>
    </div>
  {:else}
    <div class="grid">
      <div class="stack">
        <section class="panel">
          <div class="ph">
            <span>Timeline</span>
            <span class="meta"
              >each step, placed on the request's <b>{timeline ? took(timeline.span) : '—'}</b
              ></span
            >
          </div>
          {#if timeline}
            <div class="timeline">
              {#each timeline.groups as g, gi (gi)}
                <div class="tg">
                  <span class="sq" class:w={g.group !== 'bot'}></span>
                  <b
                    >{workerLabel(
                      g.group,
                      timeline.groups.slice(0, gi + 1).filter(x => x.group !== 'bot').length
                    )}</b
                  >
                  <span class="mono dim">{stamp(g.start)}</span>
                </div>
                {#each g.rows as r, ri (ri)}
                  <div class="trow" title={r.component ? `${r.component}: ${r.label}` : r.label}>
                    <span class="off mono dim">{plus(r.offset)}</span>
                    <span
                      class="lbl ellipsis"
                      class:err={r.kind === 'err'}
                      class:warn={r.kind === 'warn'}>{r.label}</span
                    >
                    <span class="track"
                      ><span class="seg-bar {r.kind}" style="left:{r.left}%; width:{r.width}%"
                      ></span></span
                    >
                    <span class="num dim">{took(r.took)}</span>
                  </div>
                {/each}
              {/each}
            </div>
            {#if !logs.length}
              <div class="hint">
                Step-by-step detail (link resolving, downloading, uploading) appears for requests
                made after this webui's bot update is deployed.
              </div>
            {/if}
          {:else}
            <div class="empty">no steps recorded</div>
          {/if}
        </section>

        {#if op.status === 'error'}
          <section class="panel accent-danger">
            <div class="ph"><span>Why it failed</span></div>
            <div class="pb why">{failure || 'no error message was recorded'}</div>
            {#if op.stackTrace}
              <details class="stack-trace">
                <summary>stack trace</summary>
                <pre>{op.stackTrace}</pre>
              </details>
            {/if}
          </section>
        {/if}
      </div>

      <div class="stack side">
        <section class="panel">
          <div class="ph"><span>Details</span></div>
          <dl class="dl">
            <dt>User</dt>
            <dd>
              <span class="user-cell"
                ><Avatar id={op.userId} size={20} /><button
                  class="linkish mono"
                  onclick={() => navigate('user-profile', { userId: op.userId })}
                  >{shortId(op.userId)}</button
                ></span
              >
              {#if related.user}<span class="dim"> · {related.user.total} in 24h</span>{/if}
            </dd>
            <dt>Started</dt>
            <dd>
              {new Date(op.timestamp).toLocaleString()}
              <span class="dim">({formatRelativeTime(op.timestamp)})</span>
            </dd>
            <dt>Where</dt>
            <dd>
              {trace?.context?.commandSource ?? 'slash'} command · {trace?.context?.inputType ??
                (op.originalUrl ? 'url' : 'attachment')}
            </dd>
            <dt>Source</dt>
            <dd>{hostOf(op.originalUrl) ?? 'attachment'}</dd>
            {#if op.originalUrl}<dt>Link</dt>
              <dd>
                <a class="mono break" href={op.originalUrl} target="_blank" rel="noreferrer"
                  >{urlLabel(op.originalUrl)} <ExternalLink size={11} /></a
                >
              </dd>{/if}
            {#if op.sourceUrl}<dt>Output</dt>
              <dd>
                <a class="mono break" href={op.sourceUrl} target="_blank" rel="noreferrer"
                  >{urlLabel(op.sourceUrl)} <ExternalLink size={11} /></a
                >
              </dd>{/if}
            <dt>Size</dt>
            <dd>{op.fileSize ? formatBytes(op.fileSize) : '—'}</dd>
            {#if job}
              <dt>Job</dt>
              <dd class="mono">
                #{job.id} · {job.attempts} attempt{job.attempts === 1 ? '' : 's'} · {job.worker ??
                  '—'}
              </dd>
            {/if}
            <dt>Request id</dt>
            <dd class="mono break">{op.id}</dd>
          </dl>
        </section>

        <section class="panel">
          <div class="ph"><span>Related</span></div>
          {#if op.originalUrl}
            <button
              class="lrow rel"
              onclick={() => navigate('requests', { urlPattern: op.originalUrl.split('?')[0] })}
            >
              <span class="grow">Same link, asked again</span><span class="mono dim"
                >{related.sameUrl ?? '…'}</span
              >
            </button>
          {/if}
          <button
            class="lrow rel"
            onclick={() => navigate('requests', { userId: op.userId, range: '24h' })}
          >
            <span class="grow">This user, last 24h</span>
            <span class="mono dim"
              >{related.user
                ? `${related.user.total} requests · ${related.user.failed} failed`
                : '…'}</span
            >
          </button>
          <button class="lrow rel" onclick={() => navigate('logs', { op: op.id })}>
            <span class="grow">Log lines for this request</span><span class="mono dim"
              >{logs.length}</span
            >
          </button>
        </section>

        <section class="panel pb actions-panel">
          <button class="btn danger" onclick={() => (banOpen = !banOpen)}
            ><Ban size={14} />Ban this user</button
          >
          {#if banOpen}
            <div class="banform">
              <input
                class="field"
                bind:value={banReason}
                placeholder="Reason (shown on appeal)"
                maxlength="200"
              />
              <button class="btn danger" disabled={!banReason.trim()} onclick={ban}
                >Confirm ban</button
              >
            </div>
          {/if}
          {#if banStatus}<span class="dim small">{banStatus}</span>{/if}
        </section>
      </div>
    </div>
  {/if}
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 380px;
    gap: var(--gap);
    align-items: start;
  }
  .timeline {
    padding: 12px 20px 16px;
  }
  .tg {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 0 6px;
    font-size: var(--fs);
  }
  .tg b {
    font-weight: 600;
    color: var(--text-bright);
  }
  .tg .mono {
    font-size: var(--fs-sm);
  }
  .sq {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    background: var(--text-dim);
  }
  .sq.w {
    background: var(--chart-1);
  }
  .trow {
    display: grid;
    grid-template-columns: 64px 240px 1fr 64px;
    align-items: center;
    gap: 12px;
    height: 30px;
    padding: 0 6px;
    margin: 0 -6px;
    border-radius: 6px;
    font-size: var(--fs);
  }
  .trow:hover {
    background: var(--row-hover);
  }
  .off {
    font-size: var(--fs-xs);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .lbl {
    color: var(--text-soft);
  }
  .lbl.err {
    color: var(--danger-text);
  }
  .lbl.warn {
    color: var(--warning-text);
  }
  .track {
    position: relative;
    height: 10px;
    border-radius: 3px;
    background: var(--card-3);
  }
  .seg-bar {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 3px;
    background: var(--chart-muted);
  }
  .seg-bar.ok {
    background: var(--success);
  }
  .seg-bar.err {
    background: var(--danger);
  }
  .seg-bar.warn {
    background: var(--warning);
  }
  .seg-bar.log {
    background: var(--chart-1);
  }
  .hint {
    margin: 0 20px 16px;
    padding: 10px 12px;
    border-radius: var(--radius);
    background: var(--card-2);
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .why {
    font-size: var(--fs);
    line-height: 1.6;
    color: var(--danger-text);
    font-family: var(--mono);
    overflow-wrap: anywhere;
  }
  .stack-trace {
    margin: 0 20px 16px;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .stack-trace pre {
    margin: 8px 0 0;
    padding: 10px;
    max-height: 280px;
    overflow: auto;
    background: var(--card-2);
    border-radius: var(--radius);
    font: var(--fs-xs) / 1.5 var(--mono);
    white-space: pre-wrap;
  }
  .dl {
    margin: 0;
    padding: 10px 20px 14px;
    display: grid;
    grid-template-columns: 96px 1fr;
    gap: 12px;
    font-size: var(--fs);
  }
  .dl dt {
    color: var(--text-muted);
  }
  .dl dd {
    margin: 0;
    min-width: 0;
  }
  .dl a {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .break {
    overflow-wrap: anywhere;
  }
  .rel {
    cursor: pointer;
  }
  .rel .mono {
    font-size: var(--fs-sm);
  }
  .actions-panel {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .banform {
    width: 100%;
    display: flex;
    gap: 8px;
  }
  .banform .field {
    flex: 1;
  }
  @media (max-width: 1100px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 640px) {
    .trow {
      grid-template-columns: 1fr 56px;
    }
    .trow .track,
    .trow .off {
      display: none;
    }
  }
</style>
