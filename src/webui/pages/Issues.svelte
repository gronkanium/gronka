<script>
  import { tick } from 'svelte';
  import {
    TerminalSquare,
    Copy,
    BellOff,
    CheckCircle2,
    RotateCcw,
    PartyPopper,
  } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { alerts as liveAlerts } from '../stores/sse-store.js';
  import { issueStates, setIssueState } from '../stores/nav.js';
  import { groupIssues, stateOf, isOpen, KIND_LABEL } from '../issues.js';
  import { formatRelativeTime, shortId, urlLabel } from '../utils/format.js';
  import PageHeader from '../components/PageHeader.svelte';
  import DataTable from '../components/DataTable.svelte';
  import Sparkline from '../components/Sparkline.svelte';
  import Avatar from '../components/Avatar.svelte';

  const DAY = 24 * 3600e3;
  const TABS = [
    ['open', 'Open'],
    ['defects', 'Defects'],
    ['upstream', 'Upstream'],
    ['user', 'User errors'],
    ['muted', 'Muted'],
    ['resolved', 'Resolved'],
  ];
  const KIND_COLOR = {
    defect: 'var(--chart-3)',
    upstream: 'var(--chart-1)',
    user: 'var(--chart-muted)',
  };
  const KIND_HELP = {
    user: 'A reply to something the user sent. Nothing to fix unless it keeps catching valid links.',
    upstream: 'A site refused or no longer has the content. Worth a look if it spikes.',
    defect: 'Not a user error or a site refusing, so treat it as ours until proven otherwise.',
  };

  let groups = $state([]);
  let loaded = $state(false);
  let occ = $state([]);
  let occOps = $state({});
  let opsLoaded = $state(false);
  let saving = $state(false);
  let error = $state('');
  let copied = $state(false);

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
  let wide = $state(true);
  $effect(() => {
    const mq = matchMedia('(min-width: 1101px)');
    const sync = () => (wide = mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  });
  // On a phone the detail sits under the list, so only show it for an explicit pick.
  const selected = $derived(
    withState.find(g => g.key === selectedKey) ?? (wide ? (visible[0] ?? null) : null)
  );

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
  const today = $derived(occ.filter(a => a.timestamp > Date.now() - DAY).length);
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
    if (!wide)
      tick().then(() => document.querySelector('.detail')?.scrollIntoView({ block: 'start' }));
  }
  function copy(text) {
    navigator.clipboard?.writeText(text);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }

  const columns = [
    { key: 'cause', label: 'cause' },
    { key: 'kind', label: 'kind', width: '96px', sm: false },
    { key: 'trend', label: '7 days', width: '80px', sm: false },
    { key: 'n', label: 'events', width: '64px', align: 'right' },
    { key: 'last', label: 'last seen', width: '88px', align: 'right', sm: false },
  ];
</script>

<PageHeader
  title="Issues"
  description="Failures from the last 7 days, grouped by cause and sorted by how often they happen."
>
  {#snippet actions()}
    {#if error}<span class="error-text small">{error}</span>{/if}
    <span class="pill" class:warn={lists.defects.length} class:ok={!lists.defects.length}
      >{lists.defects.length
        ? `${lists.defects.length} defect${lists.defects.length === 1 ? '' : 's'} open`
        : 'No open defects'}</span
    >
  {/snippet}
  {#snippet below()}
    <div class="tabs" role="tablist">
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
  {/snippet}
</PageHeader>

<div class="grid">
  <DataTable
    {columns}
    rows={visible}
    rowKey="key"
    loading={!loaded}
    selected={selected?.key}
    onrow={g => pick(g.key)}
    label="issues"
  >
    {#snippet emptyState()}
      <div class="empty">
        <span class="ic"><PartyPopper size={20} /></span>
        <b>Nothing here</b>
        {tab === 'open' ? 'No open failures in the last 7 days.' : 'No issues in this list.'}
      </div>
    {/snippet}
    {#snippet row(g)}
      <span class="cause">
        <span class="row">
          <span class="ellipsis title">{g.title}</span>
          {#if g.state === 'regressed'}<span class="pill sm bad">regressed</span>{/if}
        </span>
        <span class="meta ellipsis">
          {[
            g.commands.map(c => `/${c}`).join(', '),
            g.members.length > 1 && `${g.members.length} variants`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <span class="hide-sm"><span class="chip {g.kind}">{KIND_LABEL[g.kind]}</span></span>
      <span class="hide-sm">
        <Sparkline
          values={sparks[g.key] ?? []}
          width={64}
          height={20}
          color={KIND_COLOR[g.kind]}
          title="events per day, last 7 days"
        />
      </span>
      <span class="num strong">{g.count.toLocaleString()}</span>
      <span class="num dim hide-sm">{formatRelativeTime(g.lastSeen)}</span>
    {/snippet}
  </DataTable>

  {#if selected}
    <section class="panel detail" aria-label="selected issue">
      <div class="pb top">
        <div class="row">
          <span class="chip {selected.kind}">{KIND_LABEL[selected.kind]}</span>
          {#if selected.state !== 'open'}<span class="pill sm">{selected.state}</span>{/if}
          {#if firstSeen}<span class="dim small right"
              >first seen {new Date(firstSeen).toLocaleDateString([], {
                month: 'short',
                day: 'numeric',
              })}</span
            >{/if}
        </div>
        <h2>{selected.title}</h2>
        <p class="muted">{KIND_HELP[selected.kind]}</p>
        <p class="dim small basis">Classified {selected.basis}.</p>
      </div>
      <div class="stats">
        <div>
          <div class="k">events</div>
          <div class="v">{selected.count.toLocaleString()}</div>
        </div>
        <div>
          <div class="k">last 24h</div>
          <div class="v">{occ.length ? today : '…'}</div>
        </div>
        <div>
          <div class="k">users</div>
          <div class="v">{occ.length ? users : '…'}</div>
        </div>
        <div>
          <div class="k">last seen</div>
          <div class="v small-v">{formatRelativeTime(selected.lastSeen)}</div>
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
            <span class="user-cell"
              ><Avatar id={a.user_id} size={18} /><span class="id">{shortId(a.user_id)}</span></span
            >
          </button>
        {:else}
          <div class="empty">loading…</div>
        {/each}
      </div>
      <div class="foot">
        {#if selected.state === 'muted' || selected.state === 'resolved' || selected.state === 'regressed'}
          <button class="btn sm" disabled={saving} onclick={() => setState(selected, null)}
            ><RotateCcw size={13} />Reopen</button
          >
        {/if}
        {#if selected.state !== 'muted'}
          <button
            class="btn sm"
            disabled={saving}
            onclick={() => setState(selected, { state: 'muted', until: Date.now() + DAY })}
            ><BellOff size={13} />Mute 24h</button
          >
          <button
            class="btn sm"
            disabled={saving}
            onclick={() => setState(selected, { state: 'muted', until: Date.now() + 7 * DAY })}
            >Mute 7d</button
          >
        {/if}
        {#if selected.state !== 'resolved'}
          <button
            class="btn sm primary"
            disabled={saving}
            onclick={() => setState(selected, { state: 'resolved', at: Date.now() })}
            ><CheckCircle2 size={13} />Resolve</button
          >
        {/if}
        <span class="right"></span>
        <button
          class="btn sm ghost"
          onclick={() => navigate('logs', { search: logSearch(selected), range: '7d' })}
          ><TerminalSquare size={13} />Logs</button
        >
        <button class="btn sm ghost" onclick={() => copy(selected.members[0])}
          ><Copy size={13} />{copied ? 'Copied' : 'Copy'}</button
        >
      </div>
    </section>
  {/if}
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 440px;
    gap: var(--gap);
    align-items: start;
  }
  .cause {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: 8px 0;
  }
  .title {
    font-size: var(--fs);
    font-weight: 500;
    color: var(--text-bright);
  }
  .meta {
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }
  .detail {
    position: sticky;
    top: 24px;
  }
  .top {
    border-bottom: 1px solid var(--line);
  }
  h2 {
    margin: 12px 0 6px;
    font-size: var(--fs-lg);
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .top p {
    margin: 0;
    line-height: 1.5;
    font-size: var(--fs);
  }
  .basis {
    margin-top: 6px !important;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--line);
  }
  .k {
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .v {
    margin-top: 4px;
    font-size: var(--fs-xl);
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--text-bright);
    font-variant-numeric: tabular-nums;
  }
  .v.small-v {
    font-size: var(--fs-md);
    font-weight: 500;
    margin-top: 8px;
  }
  .pad {
    padding: 14px 20px 6px;
  }
  .variants {
    padding-top: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .occ {
    border-bottom: 1px solid var(--line);
  }
  .orow {
    width: 100%;
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr) 100px;
    gap: 10px;
    align-items: center;
    padding: 9px 20px;
    border: 0;
    border-top: 1px solid var(--line);
    background: none;
    color: var(--text);
    font: inherit;
    font-size: var(--fs-sm);
    text-align: left;
    cursor: pointer;
  }
  .orow:hover:not(:disabled) {
    background: var(--row-hover);
  }
  .orow:disabled {
    cursor: default;
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 12px 20px;
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
    .tabs {
      overflow-x: auto;
    }
  }
</style>
