<script>
  import { onDestroy } from 'svelte';
  import { TerminalSquare, Copy, BellOff, CheckCircle2, RotateCcw } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { headerActions } from '../stores/header.js';
  import { alerts as liveAlerts } from '../stores/sse-store.js';
  import { issueStates, setIssueState } from '../stores/nav.js';
  import { groupIssues, stateOf, isOpen, KIND_LABEL } from '../issues.js';
  import { formatRelativeTime, shortId, urlLabel } from '../utils/format.js';

  const DAY = 24 * 3600e3;
  const TABS = [
    ['open', 'Open'],
    ['defects', 'Defects'],
    ['upstream', 'Upstream'],
    ['user', 'User errors'],
    ['muted', 'Muted'],
    ['resolved', 'Resolved'],
  ];

  let groups = $state([]);
  let loaded = $state(false);
  let occ = $state([]);
  let occOps = $state({});
  let opsLoaded = $state(false);
  let saving = $state(false);
  let error = $state('');

  const tab = $derived(
    TABS.some(([t]) => t === $currentRoute.params.$tab) ? $currentRoute.params.$tab : 'open'
  );
  const selectedKey = $derived($currentRoute.params.$issue || '');

  async function load() {
    const r = await fetch('/api/alerts/summary?reasonLimit=300')
      .then(x => x.json())
      .catch(() => null);
    groups = groupIssues(r?.byReason ?? []);
    loaded = true;
  }
  $effect(() => {
    load();
    const t = setInterval(load, 60_000);
    // A new failure alert refreshes the list (debounced: alerts arrive in bursts).
    let soon;
    const unsub = liveAlerts.subscribe(list => {
      if (!list.some(a => a.severity === 'error')) return;
      clearTimeout(soon);
      soon = setTimeout(load, 2000);
    });
    return () => {
      clearInterval(t);
      clearTimeout(soon);
      unsub();
    };
  });

  const withState = $derived(groups.map(g => ({ ...g, state: stateOf(g, $issueStates) })));
  const open = $derived(withState.filter(g => isOpen(g, $issueStates)));
  const lists = $derived({
    open,
    defects: open.filter(g => g.kind === 'defect'),
    upstream: open.filter(g => g.kind === 'upstream'),
    user: open.filter(g => g.kind === 'user'),
    muted: withState.filter(g => g.state === 'muted'),
    resolved: withState.filter(g => g.state === 'resolved'),
  });
  const visible = $derived(lists[tab]);
  const selected = $derived(withState.find(g => g.key === selectedKey) ?? visible[0] ?? null);

  const alertsFor = (g, extra = '') =>
    Promise.all(
      g.members.map(reason =>
        fetch(`/api/alerts?reason=${encodeURIComponent(reason)}&limit=500${extra}`)
          .then(r => r.json())
          .then(d => d.alerts ?? [])
          .catch(() => [])
      )
    ).then(parts => parts.flat().sort((a, b) => b.timestamp - a.timestamp));

  // 7-day sparkline per row, fetched once per group.
  let sparks = $state({});
  $effect(() => {
    for (const g of visible) {
      if (sparks[g.key]) continue;
      sparks[g.key] = [];
      alertsFor(g, `&startTime=${Date.now() - 7 * DAY}`).then(list => {
        const days = Array(7).fill(0);
        for (const a of list) {
          const ago = Math.floor((Date.now() - a.timestamp) / DAY);
          if (ago >= 0 && ago < 7) days[6 - ago]++;
        }
        sparks[g.key] = days;
      });
    }
  });

  $effect(() => {
    const g = selected;
    occ = [];
    occOps = {};
    opsLoaded = false;
    if (!g) return;
    alertsFor(g).then(async list => {
      if (selected?.key !== g.key) return;
      occ = list;
      const recent = list.slice(0, 8).filter(a => a.operation_id);
      const ops = await Promise.all(
        recent.map(a =>
          fetch(`/api/operations/${encodeURIComponent(a.operation_id)}`)
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null)
        )
      );
      const map = {};
      ops.forEach((o, i) => o?.operation && (map[recent[i].operation_id] = o.operation));
      occOps = map;
      opsLoaded = true;
    });
  });

  const users = $derived(new Set(occ.map(a => a.user_id).filter(Boolean)).size);
  const firstSeen = $derived(occ.length ? Math.min(...occ.map(a => a.timestamp)) : null);
  const sparkMax = s => Math.max(1, ...(s ?? []));
  const logSearch = g =>
    g.key
      .split('#')[0]
      .replace(/[\s,.(:]+$/, '')
      .slice(0, 60);

  async function setState(g, state) {
    saving = true;
    error = '';
    try {
      await setIssueState(g.key, state);
    } catch {
      error = 'could not save';
    } finally {
      saving = false;
    }
  }

  function pick(key) {
    navigate('issues', { ...(tab === 'open' ? {} : { tab }), issue: key });
  }

  headerActions.set(actions);
  onDestroy(() => headerActions.set(null));
</script>

{#snippet actions()}
  {#if error}<span class="error-text small">{error}</span>{/if}
  <span class="dim small">failures grouped by cause, kept 7 days</span>
{/snippet}

<div class="issues">
  <div class="seg tabs" role="tablist">
    {#each TABS as [id, label] (id)}
      <button
        role="tab"
        aria-selected={tab === id}
        class:on={tab === id}
        onclick={() => navigate('issues', id === 'open' ? {} : { tab: id })}
      >
        {label}<span class="n">{lists[id].length}</span>
      </button>
    {/each}
  </div>

  <div class="grid">
    <section
      class="panel tbl"
      aria-label="issues"
      style="--cols: 3px minmax(0, 1fr) 96px 64px 88px"
    >
      <div class="tr head">
        <span></span><span>cause</span><span>7 days</span><span class="num">events</span><span
          class="num">last seen</span
        >
      </div>
      {#each visible as g (g.key)}
        {@const on = selected?.key === g.key}
        <button class="tr issue" class:sel={on} onclick={() => pick(g.key)}>
          <span class="accent" class:on></span>
          <span class="cause">
            <span class="row">
              <span class="ellipsis title">{g.title}</span>
              <span class="chip {g.kind}">{KIND_LABEL[g.kind]}</span>
              {#if g.state === 'regressed'}<span class="chip bad">regressed</span>{/if}
            </span>
            <span class="meta">
              {g.commands.map(c => `/${c}`).join(', ')}{#if g.members.length > 1}
                · {g.members.length} variants{/if}
            </span>
          </span>
          <span class="spark" aria-hidden="true">
            {#each sparks[g.key] ?? [] as v, d (d)}
              <span
                class="sb {g.kind}"
                style="height:{Math.max(2, (v / sparkMax(sparks[g.key])) * 22)}px"
              ></span>
            {/each}
          </span>
          <span class="num">{g.count}</span>
          <span class="num dim small">{formatRelativeTime(g.lastSeen)}</span>
        </button>
      {:else}
        <div class="empty">{loaded ? 'nothing here' : 'loading…'}</div>
      {/each}
    </section>

    {#if selected}
      <section class="panel detail" aria-label="selected issue">
        <div class="pb top">
          <div class="row">
            <span class="chip {selected.kind}">{KIND_LABEL[selected.kind]}</span>
            {#if selected.state !== 'open'}<span class="chip">{selected.state}</span>{/if}
            {#if firstSeen}<span class="mono dim small"
                >first seen {new Date(firstSeen).toLocaleDateString([], {
                  month: 'short',
                  day: 'numeric',
                })}</span
              >{/if}
          </div>
          <h2>{selected.title}</h2>
          <p class="muted small">
            {#if selected.kind === 'user'}
              A reply to something the user sent. Nothing to fix unless it keeps catching valid
              links.
            {:else if selected.kind === 'upstream'}
              A site refused or no longer has the content. Worth a look if it spikes.
            {:else}
              Not a user error or a site refusing, so treat it as ours until proven otherwise.
            {/if}
          </p>
          <p class="dim small basis">Classified {selected.basis}.</p>
        </div>
        <div class="stats">
          <div>
            <div class="k">events</div>
            <div class="v mono">{selected.count}</div>
          </div>
          <div>
            <div class="k">users</div>
            <div class="v mono">{occ.length ? users : '…'}</div>
          </div>
          <div>
            <div class="k">last seen</div>
            <div class="v mono">{formatRelativeTime(selected.lastSeen)}</div>
          </div>
        </div>
        {#if selected.members.length > 1}
          <div class="section-label pad">Variants</div>
          <div class="pad variants">
            {#each selected.members as m (m)}<div class="mono small muted ellipsis" title={m}>
                {m}
              </div>{/each}
          </div>
        {/if}
        <div class="section-label pad">Recent requests</div>
        <div class="occ">
          {#each occ.slice(0, 8) as a (a.id)}
            {@const o = occOps[a.operation_id]}
            <button
              class="orow"
              disabled={!a.operation_id}
              onclick={() => navigate('request', { requestId: a.operation_id })}
            >
              <span class="mono dim"
                >{new Date(a.timestamp).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}</span
              >
              <span class="mono ellipsis" class:dim={!o}>
                {o
                  ? urlLabel(o.originalUrl)
                  : !a.operation_id
                    ? 'not linked to a request'
                    : opsLoaded
                      ? 'no longer kept'
                      : '…'}
              </span>
              <span class="mono muted">{shortId(a.user_id)}</span>
            </button>
          {:else}
            <div class="empty">loading…</div>
          {/each}
        </div>
        <div class="foot">
          {#if selected.state === 'muted' || selected.state === 'resolved' || selected.state === 'regressed'}
            <button class="btn" disabled={saving} onclick={() => setState(selected, null)}
              ><RotateCcw size={13} />Reopen</button
            >
          {/if}
          {#if selected.state !== 'muted'}
            <button
              class="btn"
              disabled={saving}
              onclick={() => setState(selected, { state: 'muted', until: Date.now() + DAY })}
              ><BellOff size={13} />Mute 24h</button
            >
            <button
              class="btn"
              disabled={saving}
              onclick={() => setState(selected, { state: 'muted', until: Date.now() + 7 * DAY })}
              >Mute 7d</button
            >
          {/if}
          {#if selected.state !== 'resolved'}
            <button
              class="btn"
              disabled={saving}
              onclick={() => setState(selected, { state: 'resolved', at: Date.now() })}
              ><CheckCircle2 size={13} />Resolve</button
            >
          {/if}
          <button
            class="btn"
            onclick={() => navigate('logs', { search: logSearch(selected), range: '7d' })}
            ><TerminalSquare size={13} />Logs</button
          >
          <button class="btn" onclick={() => navigator.clipboard?.writeText(selected.members[0])}
            ><Copy size={13} />Copy</button
          >
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .issues {
    max-width: 1400px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .tabs {
    align-self: flex-start;
    flex-wrap: wrap;
  }
  .small {
    font-size: 12px;
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 440px;
    gap: 16px;
    align-items: start;
  }
  .tbl .tr.issue {
    padding-left: 0;
    min-height: 62px;
  }
  .tbl .tr.head {
    padding-left: 0;
  }
  .accent {
    align-self: stretch;
    border-radius: 0 2px 2px 0;
  }
  .accent.on {
    background: var(--chart-series-1);
  }
  .cause {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .title {
    font-size: 13px;
    color: var(--text);
  }
  .meta {
    font-size: 12px;
    color: var(--text-dim);
  }
  .spark {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 24px;
  }
  .sb {
    width: 10px;
    border-radius: 2px;
    background: var(--warning);
  }
  .sb.upstream {
    background: var(--chart-series-1);
  }
  .sb.user {
    background: #3a3c44;
  }
  .detail {
    position: sticky;
    top: 76px;
  }
  .top {
    border-bottom: 1px solid #1f2126;
  }
  h2 {
    margin: 10px 0 6px;
    font-size: 15px;
    font-weight: 600;
    line-height: 1.35;
    color: var(--text-bright);
  }
  .top p {
    margin: 0;
    line-height: 1.5;
  }
  .basis {
    margin-top: 6px !important;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    padding: 14px 16px;
    border-bottom: 1px solid #1f2126;
  }
  .k {
    font-size: 11px;
    color: var(--text-dim);
  }
  .v {
    margin-top: 4px;
    font-size: 16px;
    color: var(--text-bright);
  }
  .pad {
    padding: 12px 16px 6px;
  }
  .variants {
    padding-top: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .occ {
    border-bottom: 1px solid #1f2126;
  }
  .orow {
    width: 100%;
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr) 84px;
    gap: 10px;
    align-items: center;
    padding: 8px 16px;
    border: 0;
    border-top: 1px solid var(--line);
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .orow:hover:not(:disabled) {
    background: #191a1f;
  }
  .orow:disabled {
    cursor: default;
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 16px;
  }
  @media (max-width: 1100px) {
    .grid {
      grid-template-columns: 1fr;
    }
    .detail {
      position: static;
    }
  }
  @media (max-width: 640px) {
    .tbl {
      --cols: 3px minmax(0, 1fr) 44px !important;
    }
    .tbl .tr > :nth-child(3),
    .tbl .tr > :nth-child(5) {
      display: none;
    }
  }
</style>
