<script>
  import { onDestroy } from 'svelte';
  import { Check, X, Loader, Copy, TerminalSquare, Ban } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { headerActions } from '../stores/header.js';
  import {
    formatBytes,
    formatDuration,
    formatRelativeTime,
    hostOf,
    urlLabel,
  } from '../utils/format.js';

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
      error = 'this request is not in the history any more (requests are kept for 7 days)';
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
          ? 'delivered as a link'
          : 'delivered'
        : op.status === 'error'
          ? 'failed'
          : op.status
  );
  const workerLabel = (g, i) => (g === 'bot' ? 'Bot (gateway)' : `Attempt ${i} · ${g}`);
  const stamp = t =>
    new Date(t).toLocaleTimeString([], { hour12: false }) + '.' + String(t % 1000).padStart(3, '0');
  const took = ms => (ms < 1000 ? `${ms}ms` : formatDuration(ms));

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

  headerActions.set(actions);
  onDestroy(() => headerActions.set(null));
</script>

{#snippet actions()}
  <button class="btn" onclick={() => navigate('logs', { op: id })}
    ><TerminalSquare size={13} />View logs</button
  >
  <button class="btn" onclick={copyLink}><Copy size={13} />{copied ? 'Copied' : 'Copy link'}</button
  >
{/snippet}

<div class="request">
  <div class="crumbs">
    <button class="linkish" onclick={() => navigate('requests')}>Requests</button>
    <span class="dim">/</span>
    <span class="mono">{id}</span>
  </div>

  {#if error}
    <div class="panel empty">{error}</div>
  {:else if !op}
    <div class="panel empty">loading…</div>
  {:else}
    <div class="grid">
      <div class="stack">
        <div class="head">
          <div class="icon {op.status}">
            {#if op.status === 'success'}<Check size={20} />{:else if op.status === 'error'}<X
                size={20}
              />{:else}<Loader size={20} />{/if}
          </div>
          <div class="grow">
            <div class="row">
              <h2>/{op.type} {statusTitle}</h2>
              {#if job && job.attempts > 1}<span class="chip warn">retried {job.attempts - 1}×</span
                >{/if}
              {#if /timed out/i.test(failure)}<span class="chip bad">timed out</span>{/if}
            </div>
            <div class="sub mono ellipsis">
              {op.originalUrl ? urlLabel(op.originalUrl) : 'attachment'}
              {#if op.fileSize}
                · {formatBytes(op.fileSize)}{/if}
              {#if op.performanceMetrics?.duration}
                · {formatDuration(op.performanceMetrics.duration)} end to end{/if}
            </div>
          </div>
        </div>

        <section class="panel">
          <div class="ph">
            <span>Timeline</span>
            <span class="meta"
              >each step, placed on the request's {timeline ? took(timeline.span) : '—'}</span
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
                    <span class="lbl ellipsis" class:err={r.kind === 'err'}>{r.label}</span>
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
          <section class="panel">
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
              <button
                class="linkish mono"
                onclick={() => navigate('user-profile', { userId: op.userId })}>{op.userId}</button
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
            {#if op.sourceUrl}<dt>Output</dt>
              <dd>
                <a class="mono break" href={op.sourceUrl} target="_blank" rel="noreferrer"
                  >{urlLabel(op.sourceUrl)}</a
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
              class="rel"
              onclick={() => navigate('requests', { urlPattern: op.originalUrl.split('?')[0] })}
            >
              <span>Same link, asked again</span><span class="mono dim"
                >{related.sameUrl ?? '…'}</span
              >
            </button>
          {/if}
          <button
            class="rel"
            onclick={() => navigate('requests', { userId: op.userId, range: '24h' })}
          >
            <span>This user, last 24h</span>
            <span class="mono dim"
              >{related.user
                ? `${related.user.total} requests · ${related.user.failed} failed`
                : '…'}</span
            >
          </button>
          <button class="rel" onclick={() => navigate('logs', { op: op.id })}>
            <span>Log lines for this request</span><span class="mono dim">{logs.length}</span>
          </button>
        </section>

        <section class="panel pb actions-panel">
          <button class="btn danger" onclick={() => (banOpen = !banOpen)}
            ><Ban size={13} />Ban this user</button
          >
          {#if banOpen}
            <div class="banform">
              <input
                class="field"
                bind:value={banReason}
                placeholder="reason (shown on appeal)"
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
  .request {
    max-width: 1400px;
    margin: 0 auto;
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    font-size: 13px;
  }
  .linkish {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
    text-align: left;
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 380px;
    gap: 16px;
    align-items: start;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .icon {
    width: 42px;
    height: 42px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: var(--surface-2);
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .icon.success {
    background: var(--success-bg);
    color: var(--success);
  }
  .icon.error {
    background: var(--danger-bg);
    color: var(--danger);
  }
  h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--text-bright);
  }
  .sub {
    margin-top: 4px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .timeline {
    padding: 10px 16px 14px;
  }
  .tg {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 0 4px;
    font-size: 13px;
  }
  .tg b {
    font-weight: 500;
  }
  .tg .mono {
    font-size: 12px;
  }
  .sq {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    background: var(--text-dim);
  }
  .sq.w {
    background: var(--chart-series-1);
  }
  .trow {
    display: grid;
    grid-template-columns: 220px 1fr 64px;
    align-items: center;
    gap: 12px;
    height: 30px;
    font-size: 13px;
  }
  .lbl {
    padding-left: 16px;
    color: #d4d3cf;
  }
  .lbl.err {
    color: #f4b4b4;
  }
  .track {
    position: relative;
    height: 10px;
    border-radius: 3px;
    background: #1c1e23;
  }
  .seg-bar {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 3px;
    background: #4a5578;
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
    background: var(--chart-series-1);
  }
  .hint {
    margin: 0 16px 14px;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--surface-2);
    font-size: 12px;
    color: var(--text-muted);
  }
  .why {
    font-size: 13px;
    line-height: 1.6;
    color: #f0c9c9;
  }
  .stack-trace {
    margin: 0 16px 14px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .stack-trace pre {
    margin: 8px 0 0;
    padding: 10px;
    max-height: 280px;
    overflow: auto;
    background: var(--bg-deep);
    border-radius: 8px;
    font: 11px/1.5 var(--mono);
    white-space: pre-wrap;
  }
  .dl {
    margin: 0;
    padding: 8px 16px 12px;
    display: grid;
    grid-template-columns: 96px 1fr;
    gap: 10px 12px;
    font-size: 13px;
  }
  .dl dt {
    color: var(--text-dim);
  }
  .dl dd {
    margin: 0;
    min-width: 0;
  }
  .break {
    overflow-wrap: anywhere;
  }
  .dl a {
    color: var(--accent);
  }
  .rel {
    width: 100%;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 11px 16px;
    border: 0;
    border-top: 1px solid var(--line);
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .rel:first-of-type {
    border-top: 0;
  }
  .rel:hover {
    background: #191a1f;
  }
  .rel .mono {
    font-size: 12px;
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
  .small {
    font-size: 12px;
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
    .trow .track {
      display: none;
    }
  }
</style>
