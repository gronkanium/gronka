<script>
  import { getJson, getJsonOrNull, sendJson } from '../utils/api.js';
  import { tick } from 'svelte';
  import {
    Check,
    X,
    Loader,
    Copy,
    SquareTerminal,
    Ban,
    ChevronRight,
    ChevronLeft,
    ChevronsDownUp,
    ChevronsUpDown,
    Search,
    Link,
    ArrowUpRight,
    TriangleAlert,
    User,
    List,
  } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import {
    formatBytes,
    formatRelativeTime,
    formatDateTime,
    hostOf,
    urlLabel,
    shortId,
  } from '../utils/format.js';
  import PageHeader from '../components/PageHeader.svelte';
  import Avatar from '../components/Avatar.svelte';
  import CopyValue from '../components/CopyValue.svelte';
  import SpanDrawer from '../components/SpanDrawer.svelte';
  import { createCopier } from '../utils/copier.svelte.js';
  import { buildTimeline, buildTree, highlight, fmtDur, plus, plusFine, pctOf } from '../trace.js';

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
    logs = [];
    jobs = [];
    related = { sameUrl: null, user: null };
    collapsed = {};
    try {
      const data = await getJson(`/api/operations/${encodeURIComponent(requestId)}`);
      if (requestId !== id) return;
      op = data.operation;
      trace = data.trace;
    } catch {
      if (requestId !== id) return;
      error = 'This request is not in the history any more. Requests are kept for 7 days.';
      return;
    }
    const start = op.timestamp;
    const userQuery = `/api/requests?userId=${op.userId}&dateFrom=${Date.now() - 24 * 3600e3}&limit=1`;
    const [l, j, same, user, userFailed] = await Promise.all([
      getJsonOrNull(
        `/api/logs?op=${encodeURIComponent(requestId)}&orderDesc=false&limit=500&startTime=${start - 60e3}&endTime=${start + 20 * 60e3}`
      ),
      getJsonOrNull(`/api/system/jobs/${encodeURIComponent(requestId)}`),
      op.originalUrl
        ? getJsonOrNull(
            `/api/requests?urlPattern=${encodeURIComponent(op.originalUrl.split('?')[0])}&limit=1`
          )
        : null,
      getJsonOrNull(userQuery),
      getJsonOrNull(`${userQuery}&status=error`),
    ]);
    if (requestId !== id) return;
    logs = l?.logs ?? [];
    jobs = j?.jobs ?? [];
    related = {
      sameUrl: same ? Math.max(0, (same.total ?? 1) - 1) : null,
      user: user && userFailed ? { total: user.total, failed: userFailed.total } : null,
    };
  }

  $effect(() => {
    if (id) load(id);
  });

  const timeline = $derived(buildTimeline(op, trace, logs));
  const tree = $derived(buildTree(timeline));
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

  const logsHref = $derived(op ? `#/logs?op=${encodeURIComponent(op.id)}` : '#/logs');

  const copier = createCopier();

  async function ban() {
    banStatus = '';
    const res = await sendJson('/api/bans', 'POST', {
      userId: op.userId,
      reason: banReason.trim(),
    }).catch(() => null);
    banStatus = res?.ok ? 'banned' : 'could not ban';
    if (res?.ok) banOpen = false;
  }
</script>

<svelte:window onkeydown={onKey} />

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
    <button class="btn" onclick={() => copier.copy(location.href, 'page-link')}
      >{#if copier.copied === 'page-link'}<Check size={14} />Copied{:else}<Link size={14} />Copy
        link{/if}</button
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
                          >{#each highlight(row.label, q) as p, pi (pi)}{#if p.m}<mark>{p.t}</mark
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
          <SpanDrawer {selected} span={timeline.span} {logsHref} onselect={select} />
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
                <dd>
                  <CopyValue full={op.userId} label="user id">
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
                  </CopyValue>
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
                    <CopyValue
                      text={urlLabel(op.originalUrl)}
                      full={op.originalUrl}
                      label="link"
                      href={op.originalUrl}
                    />
                  </dd>
                {/if}
                {#if op.sourceUrl}
                  <dt>Output</dt>
                  <dd>
                    <CopyValue
                      text={urlLabel(op.sourceUrl)}
                      full={op.sourceUrl}
                      label="output"
                      href={op.sourceUrl}
                    />
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
                <dd><CopyValue text={op.id} label="request id" /></dd>
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
              <button class="btn" onclick={() => navigate('user-profile', { userId: op.userId })}
                ><User size={14} />View profile</button
              >
              <button class="btn" onclick={() => navigate('requests', { userId: op.userId })}
                ><List size={14} />Their requests</button
              >
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
                <button class="btn ghost sm" onclick={() => copier.copy(failure, 'failure')}
                  >{#if copier.copied === 'failure'}<Check size={13} />Copied{:else}<Copy
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
      <dd>{pctOf(hovered.took, timeline.span)}</dd>
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
