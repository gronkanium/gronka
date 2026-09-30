<script>
  import { onDestroy } from 'svelte';
  import { TerminalSquare, Copy } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { headerActions } from '../stores/header.js';
  import { alerts as liveAlerts } from '../stores/sse-store.js';
  import { formatRelativeTime, shortId, urlLabel } from '../utils/format.js';

  const DAY = 24 * 3600e3;
  // Best guess from the curated message: what the user did wrong, what a site did, or ours to fix.
  const KINDS = [
    [
      'user',
      /not from a supported|no video or image attachment|please provide|invalid url|not a valid|too large|too long|maximum allowed|exceeds the maximum|no video in it|private or internal address|wait \d|rate limit|cooldown|banned|maintenance/i,
    ],
    [
      'upstream',
      /changed its page|is blocking|deleted, private|unavailable|removed|age-restricted|sign-in|login required|members-only|blocked|not available in your/i,
    ],
  ];
  const kindOf = reason => KINDS.find(([, re]) => re.test(reason))?.[0] ?? 'defect';
  const KIND_LABEL = { defect: 'defect', upstream: 'upstream', user: 'user error' };
  const TABS = [
    ['open', 'Open'],
    ['defects', 'Defects'],
    ['upstream', 'Upstream'],
    ['user', 'User errors'],
  ];

  let reasons = $state([]);
  let loaded = $state(false);
  let occ = $state([]);
  let occOps = $state({});
  let opsLoaded = $state(false);
  let now = $state(Date.now());

  const tab = $derived(
    TABS.some(([t]) => t === $currentRoute.params.$tab) ? $currentRoute.params.$tab : 'open'
  );
  const selectedReason = $derived($currentRoute.params.$reason || '');

  async function load() {
    const r = await fetch('/api/alerts/summary?reasonLimit=100')
      .then(x => x.json())
      .catch(() => null);
    now = Date.now();
    reasons = (r?.byReason ?? []).map(i => ({ ...i, kind: kindOf(i.reason) }));
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

  const visible = $derived(
    reasons.filter(i =>
      tab === 'open' ? true : tab === 'defects' ? i.kind === 'defect' : i.kind === tab
    )
  );
  const counts = $derived({
    open: reasons.length,
    defects: reasons.filter(i => i.kind === 'defect').length,
    upstream: reasons.filter(i => i.kind === 'upstream').length,
    user: reasons.filter(i => i.kind === 'user').length,
  });
  const selected = $derived(reasons.find(i => i.reason === selectedReason) ?? visible[0] ?? null);

  // Occurrences of the selected issue, and 7-day sparklines for every row from one query each.
  let sparks = $state({});
  $effect(() => {
    for (const i of visible) {
      if (sparks[i.reason]) continue;
      sparks[i.reason] = [];
      fetch(
        `/api/alerts?reason=${encodeURIComponent(i.reason)}&limit=500&startTime=${Date.now() - 7 * DAY}`
      )
        .then(r => r.json())
        .then(d => {
          const days = Array(7).fill(0);
          for (const a of d.alerts ?? []) {
            const ago = Math.floor((Date.now() - a.timestamp) / DAY);
            if (ago >= 0 && ago < 7) days[6 - ago]++;
          }
          sparks[i.reason] = days;
        })
        .catch(() => {});
    }
  });
  $effect(() => {
    const reason = selected?.reason;
    occ = [];
    occOps = {};
    opsLoaded = false;
    if (!reason) return;
    fetch(`/api/alerts?reason=${encodeURIComponent(reason)}&limit=500`)
      .then(r => r.json())
      .then(async d => {
        if (selected?.reason !== reason) return;
        occ = d.alerts ?? [];
        const recent = occ.slice(0, 8).filter(a => a.operation_id);
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
      })
      .catch(() => {});
  });

  const users = $derived(new Set(occ.map(a => a.user_id).filter(Boolean)).size);
  const firstSeen = $derived(occ.length ? Math.min(...occ.map(a => a.timestamp)) : null);
  const sparkMax = s => Math.max(1, ...(s ?? []));

  function pick(reason) {
    navigate('issues', { ...(tab === 'open' ? {} : { tab }), reason });
  }

  headerActions.set(actions);
  onDestroy(() => headerActions.set(null));
</script>

{#snippet actions()}
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
        {label}<span class="n">{counts[id]}</span>
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
      {#each visible as i (i.reason)}
        {@const on = selected?.reason === i.reason}
        <button class="tr issue" class:sel={on} onclick={() => pick(i.reason)}>
          <span class="accent" class:on></span>
          <span class="cause">
            <span class="row">
              <span class="ellipsis title">{i.reason}</span>
              <span class="chip {i.kind}">{KIND_LABEL[i.kind]}</span>
            </span>
            <span class="meta">{i.commands.map(c => `/${c}`).join(', ')}</span>
          </span>
          <span class="spark" aria-hidden="true">
            {#each sparks[i.reason] ?? [] as v, d (d)}
              <span
                class="sb {i.kind}"
                style="height:{Math.max(2, (v / sparkMax(sparks[i.reason])) * 22)}px"
              ></span>
            {/each}
          </span>
          <span class="num">{i.count}</span>
          <span class="num dim small">{formatRelativeTime(i.lastSeen)}</span>
        </button>
      {:else}
        <div class="empty">{loaded ? 'nothing here, good' : 'loading…'}</div>
      {/each}
    </section>

    {#if selected}
      <section class="panel detail" aria-label="selected issue">
        <div class="pb top">
          <div class="row">
            <span class="chip {selected.kind}">{KIND_LABEL[selected.kind]}</span>
            {#if firstSeen}<span class="mono dim small"
                >first seen {new Date(firstSeen).toLocaleDateString([], {
                  month: 'short',
                  day: 'numeric',
                })}</span
              >{/if}
          </div>
          <h2>{selected.reason}</h2>
          <p class="muted small">
            {#if selected.kind === 'user'}
              A curated reply to something the user sent. Nothing to fix unless it keeps catching
              valid links.
            {:else if selected.kind === 'upstream'}
              The site refused or no longer has the content. Worth a look only if it spikes.
            {:else}
              Not recognised as user error or a site refusing, so treat it as ours until proven
              otherwise.
            {/if}
          </p>
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
        <div class="section-label pad">Commands</div>
        <div class="pad cmds">
          {#each selected.commands as c (c)}<span class="chip">/{c}</span>{/each}
        </div>
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
              <span class="mono ellipsis" class:dim={!o}
                >{o
                  ? urlLabel(o.originalUrl)
                  : !a.operation_id
                    ? '—'
                    : opsLoaded
                      ? 'no longer kept'
                      : '…'}</span
              >
              <span class="mono muted">{shortId(a.user_id)}</span>
            </button>
          {:else}
            <div class="empty">loading…</div>
          {/each}
        </div>
        <div class="foot">
          <button
            class="btn"
            onclick={() => navigate('logs', { search: selected.reason.slice(0, 60), range: '7d' })}
          >
            <TerminalSquare size={13} />Open in logs
          </button>
          <button class="btn" onclick={() => navigator.clipboard?.writeText(selected.reason)}
            ><Copy size={13} />Copy message</button
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
  .cmds {
    display: flex;
    gap: 6px;
    padding-top: 0;
    padding-bottom: 10px;
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
