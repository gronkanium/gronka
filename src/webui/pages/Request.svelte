<script>
  import { getJson, getJsonOrNull } from '../utils/api.js';
  import { tick } from 'svelte';
  import {
    Check,
    X,
    Loader,
    Copy,
    SquareTerminal,
    Ban,
    ExternalLink,
    ChevronRight,
    ChevronLeft,
    ChevronsDownUp,
    ChevronsUpDown,
    Search,
    Link,
    ArrowUpRight,
    TriangleAlert,
  } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import {
    formatBytes,
    formatDuration,
    formatRelativeTime,
    formatDateTime,
    formatTime,
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

  const id = $derived($currentRoute.params.requestId);

  async function load(requestId) {
    error = '';
    op = null;
    collapsed = {};
    try {
      const data = await getJson(`/api/operations/${encodeURIComponent(requestId)}`);
      op = data.operation;
      trace = data.trace;
    } catch {
      error = 'This request is not in the history any more. Requests are kept for 7 days.';
      return;
    }
    const start = op.timestamp;
    const [l, j, same, user] = await Promise.all([
      getJson(
        `/api/logs?op=${encodeURIComponent(requestId)}&orderDesc=false&limit=500&startTime=${start - 60e3}&endTime=${start + 20 * 60e3}`
      ).catch(() => null),
      getJsonOrNull(`/api/system/jobs/${encodeURIComponent(requestId)}`),
      op.originalUrl
        ? getJson(
            `/api/requests?urlPattern=${encodeURIComponent(op.originalUrl.split('?')[0])}&limit=1`
          ).catch(() => null)
        : null,
      getJson(
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
        component: 'operation',
        source: 'trace',
        raw: s,
      })),
      ...logs.map(l => ({
        at: l.timestamp,
        label: l.message,
        kind: l.level === 'ERROR' ? 'err' : l.level === 'WARN' ? 'warn' : 'log',
        component: l.component,
        group: l.metadata?.worker ?? 'bot',
        source: 'log',
        level: l.level,
        raw: l,
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
        index: i,
        left: ((e.at - start) / span) * 100,
        width: Math.max(0.6, ((next - e.at) / span) * 100),
        took: next - e.at,
        offset: e.at - start,
      };
      if (groups.at(-1)?.group !== e.group) groups.push({ group: e.group, start: e.at, rows: [] });
      groups.at(-1).rows.push(row);
    });
    return { span, start, groups };
  });

  // The waterfall tree: one parent row per group (bot gateway, each worker attempt), spans under it.
  const tree = $derived.by(() => {
    const groups = [];
    const spans = [];
    if (!timeline) return { groups, spans };
    let attempt = 0;
    timeline.groups.forEach((g, gi) => {
      const bot = g.group === 'bot';
      if (!bot) attempt++;
      const last = g.rows.at(-1);
      const offset = g.rows[0].offset;
      const kids = g.rows.map((r, ri) => ({
        ...r,
        type: 'span',
        key: String(r.index),
        gi,
        bot,
        worker: bot ? (r.raw?.metadata?.worker ?? null) : g.group,
        last: ri === g.rows.length - 1,
        tone: r.kind === 'err' ? 'err' : r.kind === 'warn' ? 'warn' : bot ? 'bot' : 'worker',
      }));
      spans.push(...kids);
      groups.push({
        type: 'group',
        key: `g${gi}`,
        gi,
        bot,
        worker: bot ? null : g.group,
        label: bot ? 'Bot gateway' : `Attempt ${attempt} · ${g.group}`,
        at: g.start,
        offset,
        took: last.offset + last.took - offset,
        kids,
        errors: kids.filter(k => k.tone === 'err').length,
        tone: bot ? 'bot' : 'worker',
      });
    });
    return { groups, spans };
  });
  const byKey = $derived(new Map([...tree.groups, ...tree.spans].map(r => [r.key, r])));

  let collapsed = $state({});
  const visible = $derived(tree.groups.flatMap(g => (collapsed[g.gi] ? [g] : [g, ...g.kids])));
  const allCollapsed = $derived(tree.groups.length > 0 && tree.groups.every(g => collapsed[g.gi]));
  function toggle(gi) {
    collapsed[gi] = !collapsed[gi];
  }
  function toggleAll() {
    const to = !allCollapsed;
    collapsed = Object.fromEntries(tree.groups.map(g => [g.gi, to]));
  }

  // Selection lives in the URL (?span=12 or ?span=g1) so a span can be linked to.
  const selKey = $derived($currentRoute.params.$span ?? null);
  const selected = $derived(selKey != null ? (byKey.get(selKey) ?? null) : null);
  function select(key) {
    const r = key != null ? byKey.get(key) : null;
    if (r?.type === 'span') collapsed[r.gi] = false;
    navigate('request', r ? { requestId: id, span: r.key } : { requestId: id });
  }

  let treeEl = $state(null);
  function reveal(key) {
    tick().then(() =>
      treeEl?.querySelector(`[data-key="${key}"]`)?.scrollIntoView({ block: 'nearest' })
    );
  }
  $effect(() => {
    if (selKey != null && treeEl) reveal(selKey);
  });

  function onKey(e) {
    if (!op || !visible.length || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (
      t instanceof HTMLElement &&
      (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
    )
      return;
    if (e.key === 'Escape') {
      if (selKey != null) {
        e.preventDefault();
        select(null);
      }
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    // With nothing selected the arrows keep scrolling the page unless the waterfall has focus.
    if (selKey == null && !treeEl?.contains(document.activeElement)) return;
    e.preventDefault();
    const i = visible.findIndex(r => r.key === selKey);
    const cur = visible[i];
    if (e.key === 'ArrowDown') select(visible[Math.min(visible.length - 1, i + 1)].key);
    else if (e.key === 'ArrowUp') select(visible[Math.max(0, i - 1)].key);
    else if (!cur) return;
    else if (e.key === 'ArrowLeft') {
      collapsed[cur.gi] = true;
      if (cur.type === 'span') select(`g${cur.gi}`);
    } else if (cur.type === 'group') {
      if (collapsed[cur.gi]) collapsed[cur.gi] = false;
      else if (cur.kids.length) select(cur.kids[0].key);
    }
  }

  // Find in trace
  let find = $state('');
  let matchAt = $state(0);
  const q = $derived(find.trim().toLowerCase());
  const matches = $derived(
    q
      ? tree.spans
          .filter(s =>
            `${s.label} ${s.component ?? ''} ${s.worker ?? ''}`.toLowerCase().includes(q)
          )
          .map(s => s.key)
      : []
  );
  const matchSet = $derived(new Set(matches));
  const matchIdx = $derived(Math.min(matchAt, Math.max(0, matches.length - 1)));
  const currentMatch = $derived(matches[matchIdx] ?? null);
  function goMatch(i) {
    if (!matches.length) return;
    matchAt = (i + matches.length) % matches.length;
    const r = byKey.get(matches[matchAt]);
    if (r) collapsed[r.gi] = false;
    reveal(matches[matchAt]);
  }
  function onFindKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      goMatch(matchIdx + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (find) find = '';
      else e.currentTarget.blur();
    }
  }
  function parts(text, needle) {
    const s = String(text ?? '');
    if (!needle) return [{ t: s }];
    const lo = s.toLowerCase();
    const out = [];
    let i = 0;
    for (;;) {
      const j = lo.indexOf(needle, i);
      if (j < 0) {
        if (i < s.length) out.push({ t: s.slice(i) });
        return out;
      }
      if (j > i) out.push({ t: s.slice(i, j) });
      out.push({ t: s.slice(j, j + needle.length), m: true });
      i = j + needle.length;
    }
  }

  // Geometry: bars are placed in percent, the duration label needs the track's pixel width.
  let trackW = $state(0);
  let rulerTrack = $state(null);
  let bodyEl = $state(null);
  function geo(r) {
    const span = timeline?.span || 1;
    const l = (r.offset / span) * 100;
    const w = (r.took / span) * 100;
    const px = Math.max(2, (w / 100) * trackW);
    const room = trackW - (l / 100) * trackW - px;
    return { l, w, where: px > 64 ? 'in' : room >= 56 ? 'right' : 'left' };
  }

  let hover = $state(null);
  let guide = $state(null);
  function onMove(e) {
    const r = rulerTrack?.getBoundingClientRect();
    const b = bodyEl?.getBoundingClientRect();
    if (r && b && timeline && e.clientX >= r.left && e.clientX <= r.right) {
      const x = e.clientX - r.left;
      guide = { x, left: r.left - b.left + x, ms: (x / r.width) * timeline.span };
    } else guide = null;
    const el = e.target instanceof Element ? e.target.closest('[data-key]') : null;
    hover = el ? { key: el.dataset.key, x: e.clientX, y: e.clientY } : null;
  }
  function onLeave() {
    hover = null;
    guide = null;
  }
  const hovered = $derived(hover ? (byKey.get(hover.key) ?? null) : null);
  const tipPos = $derived.by(() => {
    if (!hover) return { x: 0, y: 0 };
    const w = typeof window === 'undefined' ? 1e4 : window.innerWidth;
    const h = typeof window === 'undefined' ? 1e4 : window.innerHeight;
    return {
      x: hover.x + 290 > w ? hover.x - 290 : hover.x + 14,
      y: hover.y + 130 > h ? hover.y - 124 : hover.y + 18,
    };
  });

  // Formatting
  const fmtDur = ms =>
    ms < 1000
      ? `${Math.round(ms)}ms`
      : ms < 10e3
        ? `${(ms / 1000).toFixed(2)}s`
        : ms < 60e3
          ? `${(ms / 1000).toFixed(1)}s`
          : formatDuration(ms);
  const plus = ms => `+${fmtDur(ms)}`;
  const plusFine = ms => (ms < 1000 ? `+${ms.toFixed(1)}ms` : `+${(ms / 1000).toFixed(2)}s`);
  const pctOf = ms => {
    const p = timeline ? (ms / timeline.span) * 100 : 0;
    return p > 0 && p < 0.1 ? '<0.1%' : `${p.toFixed(1)}%`;
  };
  const ticks = $derived(
    timeline
      ? [0, 1, 2, 3, 4].map(i => {
          const v = (timeline.span * i) / 4;
          const label =
            i === 0
              ? '0'
              : timeline.span < 1000
                ? `${Math.round(v)}ms`
                : `${(v / 1000).toFixed(timeline.span < 2000 ? 2 : 1)}s`;
          return { i, label };
        })
      : []
  );
  const LEVEL = { ERROR: 'ERR', WARN: 'WARN', INFO: 'INFO', DEBUG: 'DBG', TRACE: 'TRC' };
  const levelOf = r =>
    r.source === 'trace' ? 'STEP' : (LEVEL[r.level] ?? String(r.level ?? 'LOG').slice(0, 5));

  // Header facts
  const job = $derived(jobs.at(-1));
  // Auto-timeouts record their reason only as a trace step, not on the operation.
  const failure = $derived(op?.error || trace?.errorSteps?.at(-1)?.message || '');
  const status = $derived(
    !op
      ? null
      : op.status === 'success'
        ? { kind: 'ok', label: 'Delivered' }
        : op.status === 'error'
          ? { kind: 'bad', label: 'Failed' }
          : { kind: 'info', label: op.status === 'pending' ? 'Queued' : 'Running' }
  );
  const workers = $derived([...new Set(tree.groups.filter(g => !g.bot).map(g => g.worker))]);
  const attempts = $derived(
    job?.attempts ?? (workers.length ? tree.groups.filter(g => !g.bot).length : null)
  );
  const errorSpans = $derived(tree.spans.filter(s => s.tone === 'err'));
  const totalMs = $derived(op?.performanceMetrics?.duration || timeline?.span || 0);

  // Drawer
  function attrs(r) {
    if (r?.type !== 'span') return [];
    const raw = r.raw ?? {};
    const base =
      r.source === 'log'
        ? { id: raw.id, level: raw.level, component: raw.component, ...(raw.metadata ?? {}) }
        : {
            source: 'operation trace',
            ...Object.fromEntries(Object.entries(raw).filter(([k]) => k !== 'message')),
          };
    return Object.entries(base)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
  }
  const selAttrs = $derived(attrs(selected));
  const selMessage = $derived(
    selected?.type === 'span' ? String(selected.raw?.message || selected.label || '') : ''
  );
  const slowest = $derived(
    selected?.type === 'group'
      ? selected.kids.reduce((a, b) => (b.took > a.took ? b : a), selected.kids[0])
      : null
  );
  const logsHref = $derived(op ? `#/logs?op=${encodeURIComponent(op.id)}` : '#/logs');

  let copiedKey = $state(null);
  let copyTimer;
  function copy(text, key) {
    navigator.clipboard?.writeText(String(text)).catch(() => {});
    copiedKey = key;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copiedKey = null), 1500);
  }

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
</script>

<svelte:window onkeydown={onKey} />

{#snippet cv(text, full, key, href = null)}
  <span class="cv">
    {#if href}
      <a class="cv-t" {href} target="_blank" rel="noreferrer" title={full}
        ><span class="ellipsis">{text}</span><ExternalLink size={11} /></a
      >
    {:else}
      <span class="cv-t ellipsis" title={full}>{text}</span>
    {/if}
    <button
      class="cv-b"
      class:done={copiedKey === key}
      title={copiedKey === key ? 'Copied' : 'Copy'}
      aria-label="Copy {key}"
      onclick={() => copy(full, key)}
      >{#if copiedKey === key}<Check size={12} />{:else}<Copy size={12} />{/if}</button
    >
  </span>
{/snippet}

{#snippet summary()}
  <dl class="summary">
    <div>
      <dt>Started</dt>
      <dd
        title="{formatDateTime(op.timestamp, { seconds: true })} · {new Date(
          op.timestamp
        ).toISOString()}"
      >
        {formatDateTime(op.timestamp, { seconds: true })}
        <span class="dim ago">{formatRelativeTime(op.timestamp)}</span>
      </dd>
    </div>
    <div>
      <dt>Duration</dt>
      <dd class="tnum">{totalMs ? fmtDur(totalMs) : '—'}</dd>
    </div>
    <div>
      <dt>Attempts</dt>
      <dd class="tnum" class:warn-text={attempts > 1}>{attempts ?? '—'}</dd>
    </div>
    <div>
      <dt>{workers.length > 1 ? 'Workers' : 'Worker'}</dt>
      <dd class="mono">{workers.length ? workers.join(', ') : (job?.worker ?? '—')}</dd>
    </div>
    <div>
      <dt>Size</dt>
      <dd class="tnum">{op.fileSize ? formatBytes(op.fileSize) : '—'}</dd>
    </div>
    <div>
      <dt>Source</dt>
      <dd>{hostOf(op.originalUrl) ?? 'attachment'}</dd>
    </div>
    <div>
      <dt>Errors</dt>
      <dd>
        {#if errorSpans.length}
          <button
            class="linkish err-link"
            title="Jump to the first error"
            onclick={() => select(errorSpans[0].key)}
            >{errorSpans.length}<ArrowUpRight size={13} /></button
          >
        {:else}
          <span class="dim">0</span>
        {/if}
      </dd>
    </div>
  </dl>
{/snippet}

<PageHeader
  title={op ? `/${op.type}` : 'Request'}
  crumbs={[{ label: 'Requests', page: 'requests' }]}
  description={op ? (op.originalUrl ? urlLabel(op.originalUrl) : 'attachment') : ''}
  below={op ? summary : null}
>
  {#if status}
    <span class="pill nodot status-pill {status.kind}"
      >{#if status.kind === 'ok'}<Check size={14} />{:else if status.kind === 'bad'}<X
          size={14}
        />{:else}<span class="spin"><Loader size={14} /></span>{/if}{status.label}</span
    >
    {#if /timed out/i.test(failure)}<span class="pill nodot status-pill bad">Timed out</span>{/if}
  {/if}
  {#snippet actions()}
    <button class="btn" onclick={() => navigate('logs', { op: id })}
      ><SquareTerminal size={14} />View logs</button
    >
    <button class="btn" onclick={() => copy(location.href, 'page-link')}
      >{#if copiedKey === 'page-link'}<Check size={14} />Copied{:else}<Link size={14} />Copy link{/if}</button
    >
  {/snippet}
</PageHeader>

<div class="request">
  {#if error}
    <div class="panel empty big"><b>Not found</b>{error}</div>
  {:else if !op}
    <div class="layout">
      <div class="panel wf-area">
        <div class="skel-rows">
          <span class="skeleton" style="width:30%;height:18px"></span>
          {#each [70, 55, 80, 40, 65, 50] as w, i (i)}
            <span class="skeleton" style="width:{w}%"></span>
          {/each}
        </div>
      </div>
      <div class="panel side-area">
        <div class="skel-rows">
          <span class="skeleton" style="width:40%;height:18px"></span>
          <span class="skeleton" style="width:80%"></span>
          <span class="skeleton" style="width:60%"></span>
        </div>
      </div>
    </div>
  {:else}
    <div class="layout">
      <section class="panel wf-area">
        <div class="ph wf-ph">
          <span>Trace</span>
          {#if timeline}
            <span class="sub">{tree.spans.length} spans · {fmtDur(timeline.span)}</span>
          {/if}
          <div class="aside">
            <label class="searchbox find" class:has={q}>
              <Search size={14} />
              <input
                bind:value={find}
                oninput={() => goMatch(0)}
                onkeydown={onFindKey}
                placeholder="Find in trace"
                aria-label="Find in trace"
                spellcheck="false"
              />
              {#if q}
                <span class="find-n mono" aria-live="polite"
                  >{matches.length ? `${matchIdx + 1} of ${matches.length}` : 'no match'}</span
                >
              {/if}
            </label>
            <button
              class="icon-btn sm"
              aria-label="Previous match"
              title="Previous match (Shift+Enter)"
              disabled={!matches.length}
              onclick={() => goMatch(matchIdx - 1)}><ChevronLeft size={15} /></button
            >
            <button
              class="icon-btn sm"
              aria-label="Next match"
              title="Next match (Enter)"
              disabled={!matches.length}
              onclick={() => goMatch(matchIdx + 1)}><ChevronRight size={15} /></button
            >
          </div>
        </div>

        {#if timeline}
          <div class="wf">
            <div class="wf-head">
              <div class="tcell head-tree">
                <button
                  class="icon-btn sm"
                  title={allCollapsed ? 'Expand all' : 'Collapse all'}
                  aria-label={allCollapsed ? 'Expand all' : 'Collapse all'}
                  onclick={toggleAll}
                  >{#if allCollapsed}<ChevronsUpDown size={14} />{:else}<ChevronsDownUp
                      size={14}
                    />{/if}</button
                >
                <span class="hlabel">Span</span>
              </div>
              <div class="bcell">
                <div class="ruler" bind:this={rulerTrack} bind:clientWidth={trackW}>
                  {#each ticks as t (t.i)}
                    <span
                      class="tick t{t.i}"
                      class:minor={t.i % 2 === 1 && trackW < 240}
                      style="left:{t.i * 25}%">{t.label}</span
                    >
                  {/each}
                  {#if guide}
                    <span class="gbadge" style="left:{guide.x}px">{plusFine(guide.ms)}</span>
                  {/if}
                </div>
              </div>
            </div>

            <div
              class="wf-body"
              role="tree"
              tabindex="0"
              aria-label="Request trace"
              aria-activedescendant={selKey != null ? `wf-${selKey}` : undefined}
              bind:this={treeEl}
              onmousemove={onMove}
              onmouseleave={onLeave}
            >
              <div class="rows" bind:this={bodyEl}>
                {#each visible as row (row.key)}
                  {@const g = geo(row)}
                  {@const isSel = row.key === selKey}
                  {@const isGroup = row.type === 'group'}
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <div
                    id="wf-{row.key}"
                    data-key={row.key}
                    role="treeitem"
                    tabindex="-1"
                    aria-level={isGroup ? 1 : 2}
                    aria-selected={isSel}
                    aria-expanded={isGroup ? !collapsed[row.gi] : undefined}
                    class="wrow t-{row.tone}"
                    class:group={isGroup}
                    class:sel={isSel}
                    class:match={isGroup
                      ? q && collapsed[row.gi] && row.kids.some(k => matchSet.has(k.key))
                      : matchSet.has(row.key)}
                    class:cur={currentMatch === row.key}
                    class:faded={q && !isGroup && !matchSet.has(row.key)}
                    onclick={() => select(isSel ? null : row.key)}
                  >
                    <div class="tcell">
                      {#if isGroup}
                        <button
                          class="chev"
                          class:open={!collapsed[row.gi]}
                          aria-label={collapsed[row.gi] ? 'Expand group' : 'Collapse group'}
                          onclick={e => {
                            e.stopPropagation();
                            toggle(row.gi);
                          }}><ChevronRight size={14} /></button
                        >
                        <span class="sw"></span>
                        <span class="gname ellipsis" title={row.label}>{row.label}</span>
                        <button
                          class="count mono"
                          class:filled={collapsed[row.gi]}
                          title="{row.kids.length} spans · click to {collapsed[row.gi]
                            ? 'expand'
                            : 'collapse'}"
                          onclick={e => {
                            e.stopPropagation();
                            toggle(row.gi);
                          }}>{row.kids.length}</button
                        >
                        {#if row.errors}
                          <span
                            class="errmark"
                            title="{row.errors} error{row.errors === 1 ? '' : 's'}"
                          ></span>
                        {/if}
                      {:else}
                        <span class="conn" class:last={row.last}></span>
                        <span class="sw"></span>
                        <span
                          class="msg ellipsis"
                          title={row.component ? `${row.component}: ${row.label}` : row.label}
                          >{#each parts(row.label, q) as p, pi (pi)}{#if p.m}<mark>{p.t}</mark
                              >{:else}{p.t}{/if}{/each}</span
                        >
                      {/if}
                    </div>
                    <div class="bcell">
                      <div class="track">
                        <span class="bar" style="left:{g.l}%;width:{g.w}%"
                          ><span class="d {g.where}">{fmtDur(row.took)}</span></span
                        >
                      </div>
                    </div>
                  </div>
                {/each}
                {#if guide}<span class="guide" style="left:{guide.left}px"></span>{/if}
              </div>
            </div>
          </div>
          {#if !logs.length}
            <div class="hint">
              Step-by-step detail (link resolving, downloading, uploading) appears for requests made
              after this webui's bot update is deployed.
            </div>
          {/if}
        {:else}
          <div class="empty">no steps recorded</div>
        {/if}
      </section>

      <aside class="side-area">
        {#if selected}
          <section class="panel drawer" aria-label="Span detail">
            <div class="ph dph">
              <span class="sw t-{selected.tone}"></span>
              {#if selected.type === 'group'}
                <span class="grow ellipsis" title={selected.label}>{selected.label}</span>
              {:else}
                <span class="chip lvl {selected.tone}">{levelOf(selected)}</span>
                <span class="grow ellipsis mono dcomp" title={selected.component}
                  >{selected.component ?? 'span'}</span
                >
              {/if}
              <button
                class="icon-btn sm"
                title={copiedKey === 'span-link' ? 'Copied' : 'Copy link to this span'}
                aria-label="Copy link to this span"
                onclick={() => copy(location.href, 'span-link')}
                >{#if copiedKey === 'span-link'}<Check size={14} />{:else}<Link
                    size={14}
                  />{/if}</button
              >
              <button
                class="icon-btn sm"
                title="Close (Esc)"
                aria-label="Close span detail"
                onclick={() => select(null)}><X size={15} /></button
              >
            </div>

            <div class="dsec">
              <div class="section-label">Overview</div>
              <dl class="ov">
                {#if selected.type === 'span'}
                  <dt>Component</dt>
                  <dd class="mono ellipsis">{selected.component ?? '—'}</dd>
                {/if}
                <dt>Worker</dt>
                <dd class="mono ellipsis">
                  {selected.worker ?? (selected.bot ? 'bot (gateway)' : '—')}
                </dd>
                <dt>Started at</dt>
                <dd class="mono" title={formatDateTime(selected.at, { seconds: true })}>
                  {formatTime(selected.at, { millis: true })}
                </dd>
                <dt>Offset</dt>
                <dd class="mono">{plus(selected.offset)}</dd>
                <dt>Duration</dt>
                <dd class="mono">{fmtDur(selected.took)}</dd>
                <dt>% of trace</dt>
                <dd class="pct">
                  <span class="mono">{pctOf(selected.took)}</span>
                  <span class="pbar"
                    ><span
                      class="t-{selected.tone}"
                      style="width:{Math.min(100, (selected.took / timeline.span) * 100)}%"
                    ></span></span
                  >
                </dd>
                {#if selected.type === 'group'}
                  <dt>Spans</dt>
                  <dd class="mono">{selected.kids.length}</dd>
                  <dt>Errors</dt>
                  <dd class="mono" class:error-text={selected.errors}>{selected.errors}</dd>
                {/if}
              </dl>
            </div>

            {#if selected.type === 'span'}
              <div class="dsec">
                <div class="dsec-h">
                  <span class="section-label">Message</span>
                  <button class="btn ghost sm" onclick={() => copy(selMessage, 'msg')}
                    >{#if copiedKey === 'msg'}<Check size={13} />Copied{:else}<Copy
                        size={13}
                      />Copy{/if}</button
                  >
                </div>
                <pre class="msgblock" class:err={selected.tone === 'err'}>{selMessage}</pre>
              </div>

              {#if selAttrs.length}
                <div class="dsec flush">
                  <div class="section-label pad">Attributes</div>
                  <dl class="kv">
                    {#each selAttrs as [k, v] (k)}
                      <div class="kvr">
                        <dt class="ellipsis" title={k}>{k}</dt>
                        <dd>{@render cv(v, v, `attr-${k}`)}</dd>
                      </div>
                    {/each}
                  </dl>
                </div>
              {/if}
            {:else if slowest}
              <div class="dsec">
                <div class="section-label">Slowest span</div>
                <button class="slowest" onclick={() => select(slowest.key)}>
                  <span class="sw t-{slowest.tone}"></span>
                  <span class="grow ellipsis" title={slowest.label}>{slowest.label}</span>
                  <span class="mono dim">{fmtDur(slowest.took)}</span>
                </button>
              </div>
            {/if}

            <div class="pf dfoot">
              <span class="mono dim">span {selected.key}</span>
              <a class="right view-logs" href={logsHref}>View in logs<ArrowUpRight size={13} /></a>
            </div>
          </section>
        {:else}
          <div class="stack">
            <section class="panel">
              <div class="ph">
                <span>Details</span>
                <span class="meta keys"
                  ><kbd>↑</kbd><kbd>↓</kbd> spans <kbd>←</kbd><kbd>→</kbd> groups</span
                >
              </div>
              <dl class="dl">
                <dt>User</dt>
                <dd class="user-row">
                  <span class="user-cell"
                    ><Avatar id={op.userId} size={20} /><button
                      class="linkish mono"
                      title={op.userId}
                      onclick={() => navigate('user-profile', { userId: op.userId })}
                      >{shortId(op.userId)}</button
                    ></span
                  >
                  {#if related.user}<span class="dim nowrap">· {related.user.total} in 24h</span
                    >{/if}
                  <button
                    class="cv-b"
                    class:done={copiedKey === 'user'}
                    title={copiedKey === 'user' ? 'Copied' : 'Copy user id'}
                    aria-label="Copy user id"
                    onclick={() => copy(op.userId, 'user')}
                    >{#if copiedKey === 'user'}<Check size={12} />{:else}<Copy
                        size={12}
                      />{/if}</button
                  >
                </dd>
                <dt>Started</dt>
                <dd>
                  {formatDateTime(op.timestamp, { seconds: true })}
                  <span class="dim">({formatRelativeTime(op.timestamp)})</span>
                </dd>
                <dt>Where</dt>
                <dd>
                  {trace?.context?.commandSource ?? 'slash'} command · {trace?.context?.inputType ??
                    (op.originalUrl ? 'url' : 'attachment')}
                </dd>
                <dt>Source</dt>
                <dd>{hostOf(op.originalUrl) ?? 'attachment'}</dd>
                {#if op.originalUrl}
                  <dt>Link</dt>
                  <dd>
                    {@render cv(urlLabel(op.originalUrl), op.originalUrl, 'link', op.originalUrl)}
                  </dd>
                {/if}
                {#if op.sourceUrl}
                  <dt>Output</dt>
                  <dd>
                    {@render cv(urlLabel(op.sourceUrl), op.sourceUrl, 'output', op.sourceUrl)}
                  </dd>
                {/if}
                <dt>Size</dt>
                <dd>
                  {op.fileSize
                    ? formatBytes(op.fileSize)
                    : op.sourceUrl && op.status === 'success'
                      ? 'sent as a link'
                      : '—'}
                </dd>
                {#if job}
                  <dt>Job</dt>
                  <dd
                    class="mono ellipsis"
                    title="#{job.id} · {job.attempts} attempts · {job.worker ?? '—'}"
                  >
                    #{job.id} · {job.attempts} attempt{job.attempts === 1 ? '' : 's'} · {job.worker ??
                      '—'}
                  </dd>
                {/if}
                <dt>Request id</dt>
                <dd>{@render cv(op.id, op.id, 'request id')}</dd>
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
        {/if}
      </aside>

      {#if op.status === 'error'}
        <section class="panel accent-danger why-area">
          <div class="ph">
            <span class="why-ic"><TriangleAlert size={15} /></span>
            <span>Why it failed</span>
            <div class="aside">
              {#if errorSpans.length}
                <button class="btn ghost sm" onclick={() => select(errorSpans.at(-1).key)}
                  >Show in trace</button
                >
              {/if}
              {#if failure}
                <button class="btn ghost sm" onclick={() => copy(failure, 'failure')}
                  >{#if copiedKey === 'failure'}<Check size={13} />Copied{:else}<Copy
                      size={13}
                    />Copy{/if}</button
                >
              {/if}
            </div>
          </div>
          <div class="pb why">{failure || 'no error message was recorded'}</div>
          {#if op.stackTrace}
            <details class="stack-trace">
              <summary
                ><span class="st-chev"><ChevronRight size={14} /></span>Stack trace
                <span class="dim mono">{op.stackTrace.split('\n').length} lines</span></summary
              >
              <pre>{op.stackTrace}</pre>
            </details>
          {/if}
        </section>
      {/if}
    </div>
  {/if}
</div>

{#if hovered && timeline}
  <div class="tip pop" style="left:{tipPos.x}px; top:{tipPos.y}px" role="tooltip">
    <div class="tip-name">
      <span class="sw t-{hovered.tone}"></span>
      <span class="tip-label">{hovered.label}</span>
    </div>
    {#if hovered.component && hovered.type === 'span'}
      <div class="tip-sub mono">{hovered.component}</div>
    {/if}
    <dl class="tip-grid">
      <dt>Duration</dt>
      <dd>{fmtDur(hovered.took)}</dd>
      <dt>% of total</dt>
      <dd>{pctOf(hovered.took)}</dd>
      <dt>Start</dt>
      <dd>{plus(hovered.offset)}</dd>
    </dl>
  </div>
{/if}

<style>
  /* ---------- page layout ---------- */
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 380px;
    grid-template-rows: auto 1fr;
    grid-template-areas:
      'wf side'
      'why side';
    gap: var(--gap);
    align-items: start;
  }
  .wf-area {
    grid-area: wf;
  }
  .side-area {
    grid-area: side;
    min-width: 0;
    position: sticky;
    top: 72px;
  }
  .why-area {
    grid-area: why;
  }

  /* ---------- header ---------- */
  .status-pill {
    height: 26px;
    padding: 0 10px 0 8px;
    font-size: var(--fs);
    font-weight: 600;
    letter-spacing: 0;
    align-self: center;
  }
  .spin {
    display: inline-flex;
    animation: spin 1.4s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .summary {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 12px 36px;
  }
  .summary > div {
    min-width: 0;
  }
  .summary dt {
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 3px;
  }
  .summary dd {
    margin: 0;
    font-size: var(--fs);
    color: var(--text-bright);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .summary dd.mono {
    font-size: var(--fs-sm);
    line-height: 18px;
  }
  .summary dd .ago {
    margin-left: 4px;
  }
  .err-link {
    color: var(--danger-text);
    font-weight: 600;
  }

  /* ---------- waterfall card ---------- */
  .wf-ph {
    flex-wrap: wrap;
    padding-top: 8px;
    padding-bottom: 8px;
  }
  .find {
    height: 30px;
    width: 240px;
    box-shadow: none;
  }
  .find-n {
    flex-shrink: 0;
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
  .wf {
    --tree-col: minmax(280px, 40%);
    max-height: min(72vh, 760px);
    overflow: auto;
    overscroll-behavior: contain;
    border-radius: 0 0 var(--radius-lg) var(--radius-lg);
  }
  .wf-head,
  .wrow {
    display: grid;
    grid-template-columns: var(--tree-col) minmax(0, 1fr);
  }
  .wf-head {
    position: sticky;
    top: 0;
    z-index: 3;
    height: 24px;
    background: var(--card-2);
    border-bottom: 1px solid var(--line);
  }
  .tcell {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px 0 8px;
    border-right: 1px solid var(--line);
    height: 100%;
  }
  .bcell {
    min-width: 0;
    padding: 0 16px;
    height: 100%;
  }
  .head-tree {
    gap: 4px;
  }
  .head-tree .icon-btn {
    width: 20px;
    height: 20px;
  }
  .hlabel {
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .ruler {
    position: relative;
    height: 100%;
  }
  .tick {
    position: absolute;
    top: 0;
    line-height: 24px;
    font: 10px / 24px var(--mono);
    color: var(--text-muted);
    transform: translateX(-50%);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .tick.t0 {
    transform: none;
  }
  .tick.minor {
    display: none;
  }
  .tick.t4 {
    transform: translateX(-100%);
  }
  .gbadge {
    position: absolute;
    top: 3px;
    height: 18px;
    padding: 0 5px;
    transform: translateX(-50%);
    border-radius: 4px;
    background: var(--text-bright);
    color: var(--card);
    font: 10px / 18px var(--mono);
    white-space: nowrap;
    pointer-events: none;
    z-index: 1;
  }
  .wf-body {
    outline: none;
  }
  .wf-body:focus-visible {
    box-shadow: inset 0 0 0 2px var(--focus);
  }
  .rows {
    position: relative;
    padding-bottom: 6px;
  }
  .guide {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--chart-crosshair);
    pointer-events: none;
    z-index: 2;
  }

  /* rows */
  .wrow {
    height: 26px;
    font-size: var(--fs);
    cursor: pointer;
    outline: none;
    scroll-margin-top: 28px;
  }
  .wrow:hover {
    background: var(--row-hover);
  }
  .wrow.match {
    background: var(--warning-bg);
  }
  .wrow.cur {
    box-shadow: inset 0 0 0 1px var(--warning-border);
  }
  .wrow.sel {
    background: var(--row-selected);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .wrow.faded .msg,
  .wrow.faded .bar {
    opacity: 0.45;
  }
  .t-bot {
    --c: var(--text-muted);
  }
  .t-worker {
    --c: var(--chart-1);
  }
  .t-err {
    --c: var(--danger);
  }
  .t-warn {
    --c: var(--warning);
  }
  .sw {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex-shrink: 0;
    background: var(--c);
  }
  .chev {
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--text-muted);
    display: grid;
    place-items: center;
    flex-shrink: 0;
    transition: transform 0.12s;
  }
  .chev:hover {
    background: var(--card-3);
    color: var(--text-bright);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .gname {
    font-weight: 600;
    color: var(--text-bright);
    min-width: 0;
  }
  .count {
    flex-shrink: 0;
    min-width: 20px;
    height: 16px;
    padding: 0 4px;
    border: 1px solid var(--border-2);
    border-radius: 4px;
    background: var(--card);
    color: var(--text-muted);
    font-size: 10px;
    line-height: 14px;
  }
  .count.filled {
    background: var(--text-soft);
    border-color: var(--text-soft);
    color: var(--card);
  }
  .errmark {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--danger);
    flex-shrink: 0;
  }
  .conn {
    position: relative;
    width: 32px;
    height: 100%;
    flex-shrink: 0;
    margin-right: -2px;
  }
  .conn::before,
  .conn::after {
    content: '';
    position: absolute;
    background: var(--border);
  }
  .conn::before {
    left: 7.5px;
    top: 0;
    bottom: 0;
    width: 1px;
  }
  .conn.last::before {
    bottom: 50%;
  }
  .conn::after {
    left: 8px;
    top: 50%;
    width: 18px;
    height: 1px;
  }
  .msg {
    min-width: 0;
    color: var(--text-soft);
  }
  .t-err .msg {
    color: var(--danger-text);
  }
  .t-warn .msg {
    color: var(--warning-text);
  }
  .wrow.sel .msg {
    color: var(--text-bright);
  }
  .t-err.sel .msg {
    color: var(--danger-text);
  }
  mark {
    background: var(--warning-border);
    color: inherit;
    border-radius: 2px;
  }

  /* bars */
  .track {
    position: relative;
    height: 100%;
    background: linear-gradient(to right, var(--chart-grid) 1px, transparent 1px) 0 0 / 25% 100%;
    box-shadow: inset -1px 0 var(--chart-grid);
  }
  .bar {
    position: absolute;
    top: 7px;
    height: 12px;
    min-width: 2px;
    border-radius: 2px;
    background: var(--c);
    display: flex;
    align-items: center;
  }
  .wrow.group .bar {
    background: color-mix(in srgb, var(--c) 22%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 55%, transparent);
  }
  .wrow.sel .bar {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
  .d {
    font: 11px / 12px var(--mono);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: var(--text-muted);
    pointer-events: none;
  }
  .d.in {
    padding-left: 6px;
    color: var(--on-accent);
    overflow: hidden;
  }
  .wrow.group .d.in {
    color: var(--text-soft);
  }
  .d.right {
    position: absolute;
    left: calc(100% + 6px);
  }
  .d.left {
    position: absolute;
    right: calc(100% + 6px);
  }
  .hint {
    margin: 0 20px 16px;
    padding: 10px 12px;
    border-radius: var(--radius);
    background: var(--card-2);
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }

  /* ---------- tooltip ---------- */
  .tip {
    position: fixed;
    z-index: 300;
    width: max-content;
    max-width: 276px;
    padding: 10px 12px;
    pointer-events: none;
    font-size: var(--fs-sm);
  }
  .tip-name {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    color: var(--text-bright);
    font-weight: 500;
  }
  .tip-name .sw {
    margin-top: 4px;
  }
  .tip-label {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .tip-sub {
    margin: 2px 0 0 16px;
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
  .tip-grid {
    margin: 8px 0 0 16px;
    display: grid;
    grid-template-columns: auto auto;
    column-gap: 16px;
    row-gap: 2px;
  }
  .tip-grid dt {
    color: var(--text-muted);
  }
  .tip-grid dd {
    margin: 0;
    font-family: var(--mono);
    text-align: right;
    color: var(--text-bright);
  }

  /* ---------- copyable values ---------- */
  .cv {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: 100%;
  }
  .cv-t {
    min-width: 0;
    font-family: var(--mono);
    font-size: var(--fs-sm);
  }
  a.cv-t {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  a.cv-t :global(svg) {
    flex-shrink: 0;
  }
  .cv-b {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--text-dim);
    display: inline-grid;
    place-items: center;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .cv:hover .cv-b,
  .user-row:hover .cv-b,
  .cv-b:focus-visible,
  .cv-b.done {
    opacity: 1;
  }
  .cv-b:hover {
    background: var(--card-3);
    color: var(--text-bright);
  }
  .cv-b.done {
    color: var(--success-text);
  }
  @media (hover: none) {
    .cv-b {
      opacity: 1;
    }
  }

  /* ---------- details (nothing selected) ---------- */
  .keys {
    gap: 4px;
    font-size: var(--fs-xs);
  }
  .keys kbd + kbd {
    margin-left: -2px;
  }
  .keys kbd:nth-of-type(3) {
    margin-left: 6px;
  }
  .dl {
    margin: 0;
    padding: 10px 20px 14px;
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    gap: 12px;
    font-size: var(--fs);
    align-items: center;
  }
  .dl dt {
    color: var(--text-muted);
  }
  .dl dd {
    margin: 0;
    min-width: 0;
  }
  .user-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
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
    min-width: 0;
  }

  /* ---------- span drawer ---------- */
  .drawer {
    max-height: calc(100vh - 88px);
    overflow: auto;
    display: flex;
    flex-direction: column;
  }
  .dph {
    gap: 8px;
    padding-right: 10px;
    position: sticky;
    top: 0;
    background: var(--card);
    z-index: 1;
  }
  .dph .sw {
    width: 10px;
    height: 10px;
  }
  .dcomp {
    font-size: var(--fs);
    font-weight: 500;
  }
  .lvl {
    font-family: var(--mono);
    letter-spacing: 0.04em;
  }
  .lvl.err {
    color: var(--danger-text);
    border-color: var(--danger-border);
    background: var(--danger-bg);
  }
  .lvl.warn {
    color: var(--warning-text);
    border-color: var(--warning-border);
    background: var(--warning-bg);
  }
  .lvl.worker {
    color: var(--accent);
    border-color: var(--accent-border);
    background: var(--accent-bg);
  }
  .dsec {
    padding: 14px 20px;
    border-bottom: 1px solid var(--line);
  }
  .dsec.flush {
    padding: 14px 0 8px;
  }
  .section-label.pad {
    padding: 0 20px;
  }
  .dsec-h {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: -4px 0 6px;
  }
  .dsec > .section-label {
    margin-bottom: 8px;
  }
  .ov {
    margin: 0;
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    row-gap: 8px;
    column-gap: 12px;
    font-size: var(--fs);
  }
  .ov dt {
    color: var(--text-muted);
  }
  .ov dd {
    margin: 0;
    min-width: 0;
    color: var(--text-bright);
  }
  .ov dd.mono {
    font-size: var(--fs-sm);
  }
  .pct {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .pct .mono {
    font-size: var(--fs-sm);
    min-width: 44px;
  }
  .pbar {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: var(--card-3);
    overflow: hidden;
  }
  .pbar span {
    display: block;
    height: 100%;
    min-width: 2px;
    background: var(--c);
  }
  .msgblock {
    margin: 0;
    padding: 10px 12px;
    max-height: 220px;
    overflow: auto;
    background: var(--card-2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    font: var(--fs-sm) / 18px var(--mono);
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .msgblock.err {
    color: var(--danger-text);
    background: var(--danger-bg-subtle);
    border-color: var(--danger-border);
  }
  .kv {
    margin: 8px 0 0;
  }
  .kvr {
    display: grid;
    grid-template-columns: 112px minmax(0, 1fr);
    gap: 12px;
    align-items: center;
    min-height: 28px;
    padding: 0 12px 0 20px;
  }
  .kvr:nth-child(odd) {
    background: var(--card-2);
  }
  .kvr dt {
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .kvr dd {
    margin: 0;
    min-width: 0;
    color: var(--text);
  }
  .slowest {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card);
    font-size: var(--fs);
    text-align: left;
  }
  .slowest:hover {
    background: var(--row-hover);
  }
  .slowest .mono {
    font-size: var(--fs-sm);
  }
  .dfoot {
    margin-top: auto;
    border-top: 0;
  }
  .dfoot .mono {
    font-size: var(--fs-xs);
  }
  .view-logs {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 500;
  }

  /* ---------- why it failed ---------- */
  .why-ic {
    display: inline-flex;
    color: var(--danger);
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
  .stack-trace summary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    list-style: none;
    font-weight: 500;
    color: var(--text-soft);
  }
  .stack-trace summary::-webkit-details-marker {
    display: none;
  }
  .stack-trace summary .mono {
    font-size: var(--fs-xs);
    font-weight: 400;
  }
  .st-chev {
    display: inline-flex;
    transition: transform 0.12s;
  }
  .stack-trace[open] .st-chev {
    transform: rotate(90deg);
  }
  .stack-trace pre {
    margin: 8px 0 0;
    padding: 10px 12px;
    max-height: 320px;
    overflow: auto;
    background: var(--card-2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    font: var(--fs-xs) / 1.6 var(--mono);
    color: var(--text-soft);
    white-space: pre;
  }

  /* ---------- responsive ---------- */
  @media (max-width: 1100px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: none;
      grid-template-areas: 'wf' 'side' 'why';
    }
    .side-area {
      position: static;
    }
    .drawer {
      max-height: none;
    }
  }
  @media (max-width: 760px) {
    .wf {
      --tree-col: minmax(0, 58%);
    }
    .wf-ph .aside {
      width: 100%;
      margin-left: 0;
      gap: 4px;
    }
    .wf-ph .find {
      flex: 1;
      width: auto;
      min-width: 0;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      column-gap: 12px;
    }
    .summary > div:first-child {
      grid-column: span 2;
    }
    .summary dd {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .keys {
      display: none;
    }
  }
  @media (hover: none) {
    .keys {
      display: none;
    }
  }
</style>
