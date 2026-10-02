<script>
  import { poll } from '../utils/poll.js';
  import { createCopier } from '../utils/copier.svelte.js';
  import { getJson, getJsonOrNull } from '../utils/api.js';
  import { tick, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import {
    SquareTerminal,
    Copy,
    Check,
    BellOff,
    CircleCheck,
    RotateCcw,
    ChevronDown,
    X,
  } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { alerts as liveAlerts } from '../stores/sse-store.js';
  import { issueStates, setIssueState } from '../stores/nav.js';
  import {
    groupIssues,
    stateOf,
    isOpen,
    isNew,
    inTab,
    buckets,
    abbr,
    KIND_LABEL,
  } from '../issues.js';
  import { formatRelativeTime, formatDateTime, shortId, urlLabel } from '../utils/format.js';
  import PageHeader from '../components/PageHeader.svelte';
  import DataTable from '../components/DataTable.svelte';
  import Sparkline from '../components/Sparkline.svelte';
  import Chart from '../components/Chart.svelte';
  import Avatar from '../components/Avatar.svelte';

  const HOUR = 3600e3;
  const DAY = 24 * HOUR;
  // The alerts API returns at most this many rows per reason.
  const LIMIT = 500;
  const TABS = [
    ['open', 'Open'],
    ['defects', 'Defects'],
    ['upstream', 'Upstream'],
    ['user', 'User errors'],
    ['muted', 'Muted'],
    ['resolved', 'Resolved'],
  ];
  const KIND_HELP = {
    user: 'A reply to something the user sent. Nothing to fix unless it keeps catching valid links.',
    upstream: 'A site refused or no longer has the content. Worth a look if it spikes.',
    defect: 'Not a user error or a site refusing, so treat it as ours until proven otherwise.',
  };
  const BADGE = {
    regressed: ['warn', 'Regressed'],
    muted: ['idle', 'Muted'],
    resolved: ['ok', 'Resolved'],
  };
  const EMPTY_HINT = {
    open: 'No failures in the last 7 days.',
    defects: 'No open failures that look like ours.',
    upstream: 'No open failures from sites refusing.',
    user: 'No open failures caused by what users sent.',
    muted: 'Muted issues wait here until the mute ends.',
    resolved: 'Resolved issues come back to Open if they happen again.',
  };
  // Trend periods: bucket unit and count. 7d reuses the per-group 7-day fetch.
  const PERIODS = { '24h': { unit: 'hour', n: 24 }, '7d': { unit: 'day', n: 7 } };
  const plural = n => (n > 1 ? ` ${n} issues` : '');
  const ACTIONS = {
    resolve: {
      make: () => ({ state: 'resolved', at: Date.now() }),
      done: n => `Resolved${plural(n)}`,
    },
    mute24: {
      make: () => ({ state: 'muted', until: Date.now() + DAY }),
      done: n => `Muted${plural(n)} for 24 hours`,
    },
    mute7: {
      make: () => ({ state: 'muted', until: Date.now() + 7 * DAY }),
      done: n => `Muted${plural(n)} for 7 days`,
    },
    reopen: { make: () => null, done: n => `Reopened${plural(n)}` },
  };

  let groups = $state([]);
  let variantCounts = $state({});
  let loaded = $state(false);
  let loadError = $state('');
  let now = $state(Date.now());
  let error = $state('');
  let saving = $state(false);
  const copier = createCopier();
  let muteOpen = $state(false);
  let toast = $state(null);
  let sort = $state({ key: 'n', desc: true });
  let listW = $state(0);
  let period = $state(readPeriod());
  const checked = new SvelteSet();
  const leaving = new SvelteSet();

  function readPeriod() {
    try {
      return localStorage.getItem('issues.trend') === '7d' ? '7d' : '24h';
    } catch {
      return '24h';
    }
  }
  function setPeriod(p) {
    period = p;
    try {
      localStorage.setItem('issues.trend', p);
    } catch {
      // per-viewer convenience only
    }
  }

  const tab = $derived(
    TABS.some(([t]) => t === $currentRoute.params.$tab) ? $currentRoute.params.$tab : 'open'
  );
  const selectedKey = $derived($currentRoute.params.$issue || '');

  async function load() {
    const r = await getJsonOrNull('/api/alerts/summary?reasonLimit=300');
    now = Date.now();
    if (!r) {
      if (!loaded) loadError = 'Could not load issues';
      else error = 'Could not refresh';
      loaded = true;
      return;
    }
    const byReason = r.byReason ?? [];
    groups = groupIssues(byReason);
    variantCounts = Object.fromEntries(byReason.map(x => [x.reason, x.count]));
    loadError = '';
    if (error === 'Could not refresh') error = '';
    loaded = true;
  }
  $effect(() => {
    load();
    const stopPoll = poll(load, 60_000);
    // A new failure alert refreshes the list (debounced: alerts arrive in bursts).
    let soon;
    const unsub = liveAlerts.subscribe(list => {
      if (!list.some(a => a.severity === 'error')) return;
      clearTimeout(soon);
      soon = setTimeout(load, 2000);
    });
    return () => {
      stopPoll();
      clearTimeout(soon);
      clearTimeout(toastTimer);
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

  const usersOf = g => g?.users;

  const alertsFor = (g, extra = '') =>
    Promise.all(
      g.members.map(reason =>
        getJson(`/api/alerts?reason=${encodeURIComponent(reason)}&limit=${LIMIT}${extra}`)
          .then(d => d.alerts ?? [])
          .catch(() => null)
      )
    );

  const bucketLabel = (at, unit) =>
    unit === 'day'
      ? new Date(at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
      : formatDateTime(at);

  function trendOf(g) {
    const { unit, n } = PERIODS[period];
    const b = buckets(g.times, unit, n, now);
    return {
      values: b.map(x => x.n),
      tips: b.map(x => `${bucketLabel(x.at, unit)} · ${x.n} event${x.n === 1 ? '' : 's'}`),
    };
  }

  const SORTS = { n: g => g.count, users: g => usersOf(g) ?? -1, last: g => g.lastSeen };
  const visible = $derived.by(() => {
    const by = SORTS[sort.key] ?? SORTS.n;
    const dir = sort.desc ? 1 : -1;
    const fresh = g => (sort.key === 'n' && isNew(g, now) ? 1 : 0);
    return [...lists[tab]].sort(
      (a, b) => fresh(b) - fresh(a) || (by(b) - by(a)) * dir || b.count - a.count
    );
  });
  const trends = $derived(Object.fromEntries(visible.map(g => [g.key, trendOf(g)])));

  // The panes fill the viewport below the page header; measure where the grid starts so a change
  // in the shell above (a top bar, a wrapped description) does not push them off screen.
  let gridEl = $state();
  let gridTop = $state(0);
  $effect(() => {
    if (!gridEl) return;
    const measure = () =>
      (gridTop = Math.round(gridEl.getBoundingClientRect().top + window.scrollY));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(gridEl.parentElement ?? gridEl);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  });

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

  // Columns give way as the list narrows, so the issue title keeps room to breathe.
  const show = $derived({
    sel: !listW || listW >= 480,
    trend: !listW || listW >= 560,
    users: !listW || listW >= 470,
    last: !listW || listW >= 400,
  });
  const trendW = $derived(!listW || listW >= 720 ? 120 : 88);
  const columns = $derived(
    [
      show.sel && { key: 'sel', label: '', width: '18px' },
      { key: 'issue', label: 'Issue' },
      show.trend && {
        key: 'trend',
        label: period === '24h' ? 'Last 24 hours' : 'Last 7 days',
        width: `${trendW}px`,
      },
      { key: 'n', label: 'Events', width: '56px', align: 'right', sortable: true },
      show.users && { key: 'users', label: 'Users', width: '48px', align: 'right', sortable: true },
      show.last && {
        key: 'last',
        label: 'Last seen',
        width: '72px',
        align: 'right',
        sortable: true,
      },
    ].filter(Boolean)
  );

  // Selection for bulk actions; switching tabs starts over.
  $effect(() => {
    void tab;
    untrack(() => checked.clear());
  });
  const picked = $derived(visible.filter(g => checked.has(g.key)));
  const allChecked = $derived(visible.length > 0 && picked.length === visible.length);
  function toggleCheck(key) {
    if (checked.has(key)) checked.delete(key);
    else checked.add(key);
  }
  function toggleAll() {
    if (allChecked) checked.clear();
    else visible.forEach(g => checked.add(g.key));
  }

  // Detail: every kept event for the recent requests list and first seen.
  let occ = $state([]);
  let occOps = $state({});
  let occLoading = $state(false);
  let opsLoaded = $state(false);
  let occKey = '';
  const selSig = $derived(selected ? `${selected.key}|${selected.lastSeen}` : '');
  $effect(() => {
    if (!selSig) {
      occ = [];
      occKey = '';
      return;
    }
    const g = untrack(() => selected);
    if (occKey !== g.key) {
      occ = [];
      occOps = {};
      opsLoaded = false;
      occLoading = true;
    }
    let stale = false;
    alertsFor(g).then(async parts => {
      if (stale) return;
      const list = parts.flatMap(x => x ?? []).sort((a, b) => b.timestamp - a.timestamp);
      occ = list;
      occKey = g.key;
      occLoading = false;
      const recent = list.slice(0, 8).filter(a => a.operation_id);
      const ops = await Promise.all(
        recent.map(a => getJsonOrNull(`/api/operations/${encodeURIComponent(a.operation_id)}`))
      );
      if (stale) return;
      const map = {};
      ops.forEach((o, i) => o?.operation && (map[recent[i].operation_id] = o.operation));
      occOps = map;
      opsLoaded = true;
    });
    return () => (stale = true);
  });

  const week = $derived(selected);
  const hourly = $derived(week ? buckets(week.times, 'hour', 168, now) : []);
  const last24 = $derived(week ? week.times.filter(t => t > now - DAY).length : null);
  const firstSeen = $derived(occ.length ? occ.at(-1).timestamp : null);
  const selState = $derived(selected ? $issueStates[selected.key] : null);
  const stateNote = $derived.by(() => {
    if (!selected || !selState) return '';
    if (selected.state === 'muted') return `until ${formatDateTime(selState.until)}`;
    if (selected.state === 'resolved') return formatDateTime(selState.at);
    if (selected.state === 'regressed') return `seen again after ${formatDateTime(selState.at)}`;
    return '';
  });
  const variants = $derived(
    selected
      ? [...selected.members].sort((a, b) => (variantCounts[b] ?? 0) - (variantCounts[a] ?? 0))
      : []
  );

  const logSearch = g =>
    g.key
      .split('#')[0]
      .replace(/[\s,.(:]+$/, '')
      .slice(0, 60);
  const meta = g =>
    [
      g.commands.map(c => `/${c}`).join(', '),
      g.members.length > 1 && `${g.members.length} variants`,
    ]
      .filter(Boolean)
      .join(' · ');
  const wait = ms => new Promise(r => setTimeout(r, ms));

  let toastTimer;
  function showToast(text, undo) {
    clearTimeout(toastTimer);
    toast = { text, undo };
    toastTimer = setTimeout(() => (toast = null), 6000);
  }

  // Apply a state change to issues: rows that leave this list fade out first, the selection moves
  // to the next row, and a toast offers to undo.
  async function apply(list, action) {
    if (!list.length || saving) return;
    const { make, done } = ACTIONS[action];
    const next = make();
    error = '';
    muteOpen = false;
    const before = $issueStates;
    const prev = list.map(g => [g.key, before[g.key] ?? null]);
    const after = { ...before };
    for (const g of list) {
      if (next) after[g.key] = next;
      else delete after[g.key];
    }
    const out = list.filter(g => !inTab(tab, g, stateOf(g, after))).map(g => g.key);
    const cur = selected?.key;
    let moveTo;
    if (cur && out.includes(cur)) {
      const i = visible.findIndex(g => g.key === cur);
      const stays = g => !out.includes(g.key);
      moveTo =
        (visible.slice(i + 1).find(stays) ?? visible.slice(0, i).reverse().find(stays))?.key ??
        null;
    }
    saving = true;
    out.forEach(k => leaving.add(k));
    try {
      if (out.length) await wait(300);
      for (const g of list) await setIssueState(g.key, next);
    } catch {
      error = 'Could not save';
      return;
    } finally {
      saving = false;
      out.forEach(k => leaving.delete(k));
    }
    list.forEach(g => checked.delete(g.key));
    if (moveTo !== undefined) {
      if (wide && moveTo) pick(moveTo, false);
      else navigate('issues', tab === 'open' ? {} : { tab });
    }
    showToast(done(list.length), async () => {
      toast = null;
      try {
        for (const [key, s] of prev) await setIssueState(key, s);
        if (moveTo !== undefined && cur) pick(cur, false);
      } catch {
        error = 'Could not undo';
      }
    });
  }

  function pick(key, scroll = true) {
    muteOpen = false;
    copier.clear();
    navigate('issues', { ...(tab === 'open' ? {} : { tab }), issue: key });
    if (scroll && !wide)
      tick().then(() => document.querySelector('.detail')?.scrollIntoView({ block: 'start' }));
  }
  function close() {
    navigate('issues', tab === 'open' ? {} : { tab });
  }
  function move(d) {
    if (!visible.length) return;
    const i = visible.findIndex(g => g.key === selected?.key);
    const j =
      i < 0 ? (d > 0 ? 0 : visible.length - 1) : Math.max(0, Math.min(visible.length - 1, i + d));
    pick(visible[j].key, false);
    tick().then(() =>
      document.querySelector('.issues-list .tr.sel')?.scrollIntoView({ block: 'nearest' })
    );
  }

  // A click anywhere on a row opens it; the title is the row's keyboard-focusable control.
  function onListClick(e) {
    if (e.target.closest('input, a, .ck, .bar, .tr.head')) return;
    const key = e.target.closest('.issue-row')?.querySelector('[data-key]')?.dataset.key;
    if (!key) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) toggleCheck(key);
    else pick(key);
  }

  function onKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const typing =
      t?.isContentEditable ||
      t?.matches?.('input:not([type="checkbox"]):not([type="radio"]), textarea, select');
    if (typing) return;
    if (muteOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const items = [...document.querySelectorAll('.mute-menu [role="menuitem"]')];
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      return;
    }
    if (e.key === 'Escape') {
      if (muteOpen) muteOpen = false;
      else if (checked.size) checked.clear();
      else if (!wide && selectedKey) close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'r' && selected && selected.state !== 'resolved') {
      e.preventDefault();
      apply([selected], 'resolve');
    } else if (k === 'm' && selected && selected.state !== 'muted') {
      e.preventDefault();
      apply([selected], 'mute24');
    }
  }
  function onWindowClick(e) {
    if (muteOpen && !e.target.closest?.('.mute')) muteOpen = false;
  }
  async function toggleMute() {
    muteOpen = !muteOpen;
    if (muteOpen) {
      await tick();
      document.querySelector('.mute-menu [role="menuitem"]')?.focus();
    }
  }
</script>

<svelte:window onkeydown={onKey} onclick={onWindowClick} />

<PageHeader title="Issues" description="Failures from the last 7 days, grouped by cause.">
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

<div class="grid" bind:this={gridEl} style:--grid-top={gridTop ? `${gridTop}px` : null}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="issues-list"
    class:selecting={picked.length > 0}
    bind:clientWidth={listW}
    onclick={onListClick}
  >
    <DataTable
      {columns}
      rows={visible}
      rowKey="key"
      loading={!loaded}
      error={loadError}
      onretry={load}
      selected={selected?.key}
      rowClass={g => `issue-row${leaving.has(g.key) ? ' leaving' : ''}`}
      {sort}
      onsort={(key, desc) => (sort = { key, desc })}
      label="issues"
    >
      {#snippet toolbar()}
        <div class="bar">
          {#if show.sel}<label class="ck" title={allChecked ? 'Clear selection' : 'Select all'}>
              <input
                type="checkbox"
                checked={allChecked}
                disabled={!visible.length}
                onchange={toggleAll}
                aria-label="select all issues"
                {@attach el => {
                  el.indeterminate = picked.length > 0 && !allChecked;
                }}
              />
            </label>{/if}
          {#if picked.length}
            <div class="bulk">
              <b>{picked.length} selected</b>
              <span class="sep">·</span>
              <button
                class="btn sm"
                disabled={saving || !picked.some(g => g.state !== 'resolved')}
                onclick={() =>
                  apply(
                    picked.filter(g => g.state !== 'resolved'),
                    'resolve'
                  )}><CircleCheck size={13} />Resolve</button
              >
              <button class="btn sm" disabled={saving} onclick={() => apply(picked, 'mute7')}
                ><BellOff size={13} />Mute 7d</button
              >
              {#if picked.some(g => g.state !== 'open')}
                <button
                  class="btn sm"
                  disabled={saving}
                  onclick={() =>
                    apply(
                      picked.filter(g => g.state !== 'open'),
                      'reopen'
                    )}><RotateCcw size={13} />Reopen</button
                >
              {/if}
              <button
                class="icon-btn sm"
                title="Clear selection (Esc)"
                aria-label="clear selection"
                onclick={() => checked.clear()}><X size={14} /></button
              >
            </div>
          {:else}
            <span class="count"
              >{loaded
                ? `${visible.length} ${visible.length === 1 ? 'issue' : 'issues'}`
                : ''}</span
            >
            {#if show.trend}
              <div class="seg xs" role="group" aria-label="trend period">
                {#each ['24h', '7d'] as p (p)}
                  <button
                    class:on={period === p}
                    aria-pressed={period === p}
                    title={p === '24h' ? 'Hourly, last 24 hours' : 'Daily, last 7 days'}
                    onclick={() => setPeriod(p)}>{p}</button
                  >
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      {/snippet}
      {#snippet emptyState()}
        <div class="empty big">
          <span class="ic ok"><CircleCheck size={20} /></span>
          <b>{tab === 'open' ? 'Nothing open' : 'No issues in this list'}</b>
          {EMPTY_HINT[tab]}
        </div>
      {/snippet}
      {#snippet row(g)}
        {@const tr = trends[g.key]}
        {@const users = usersOf(g)}
        {#if show.sel}
          <label class="ck">
            <input
              type="checkbox"
              checked={checked.has(g.key)}
              onchange={() => toggleCheck(g.key)}
              aria-label="select {g.title}"
            />
          </label>
        {/if}
        <span class="cause">
          <span class="l1">
            <button class="ttl ellipsis" data-key={g.key} title={g.title}>{g.title}</button>
            <span class="chip {g.kind}">{KIND_LABEL[g.kind]}</span>
            {#if g.state === 'open' && isNew(g, now)}
              <span class="pill sm bad">New</span>
            {/if}
            {#if BADGE[g.state]}
              <span class="pill sm {BADGE[g.state][0]}">{BADGE[g.state][1]}</span>
            {/if}
          </span>
          <span class="l2 ellipsis">{meta(g)}</span>
        </span>
        {#if show.trend}
          <span class="trend">
            <Sparkline
              values={tr?.values ?? []}
              tips={tr?.tips}
              width={trendW}
              height={36}
              gap={period === '7d' ? 4 : 1.5}
              color="var(--text-dim)"
              baseline="var(--border)"
            />
          </span>
        {/if}
        <span class="num strong" title="{g.count.toLocaleString()} events in the last 7 days"
          >{abbr(g.count)}</span
        >
        {#if show.users}
          <span class="num" title={users == null ? '' : `${users.toLocaleString()} users`}>
            {#if users == null}<span class="skeleton cell-skel"></span>{:else}{abbr(users)}{/if}
          </span>
        {/if}
        {#if show.last}
          <span class="num dim" title="Last seen {formatDateTime(g.lastSeen, { seconds: true })}"
            >{formatRelativeTime(g.lastSeen)}</span
          >
        {/if}
      {/snippet}
    </DataTable>
  </div>

  {#if selected}
    {@const badge = BADGE[selected.state]}
    <section class="panel detail" aria-label="selected issue">
      <div class="dscroll">
        <header class="dhead">
          <div class="row">
            <span class="chip {selected.kind}">{KIND_LABEL[selected.kind]}</span>
            {#if badge}<span class="pill sm {badge[0]}">{badge[1]}</span>{/if}
            {#if stateNote}<span class="dim small ellipsis">{stateNote}</span>{/if}
            {#if !wide}
              <button
                class="icon-btn sm right"
                title="Close (Esc)"
                aria-label="close"
                onclick={close}><X size={15} /></button
              >
            {/if}
          </div>
          <h2>{selected.title}</h2>
          <p class="help">{KIND_HELP[selected.kind]}</p>
          <p class="basis">Classified {selected.basis}.</p>
          <dl class="seen">
            <div>
              <dt>First seen</dt>
              {#if firstSeen}
                <dd>
                  <b>{formatRelativeTime(firstSeen)}</b>
                  <span>{formatDateTime(firstSeen)}</span>
                </dd>
              {:else}
                <dd><span class="skeleton seen-skel"></span></dd>
              {/if}
            </div>
            <div>
              <dt>Last seen</dt>
              <dd>
                <b>{formatRelativeTime(selected.lastSeen)}</b>
                <span>{formatDateTime(selected.lastSeen)}</span>
              </dd>
            </div>
          </dl>
        </header>

        <section class="sect">
          <div class="sh">
            <span>Events, last 7 days</span>
            <span class="dim">hourly</span>
          </div>
          {#if week}
            <Chart
              type="bar"
              height={100}
              data={hourly}
              bucket={HOUR}
              padLeft={28}
              series={[{ key: 'n', label: 'events', color: 'var(--chart-1)' }]}
            />
          {:else}
            <div class="skeleton chart-skel"></div>
          {/if}
        </section>

        <div class="counters">
          <div>
            <span class="k">Events</span>
            <span class="v" title={selected.count.toLocaleString()}>{abbr(selected.count)}</span>
          </div>
          <div>
            <span class="k">Last 24h</span>
            <span class="v"
              >{#if week}{abbr(last24)}{:else}<span class="skeleton v-skel"></span>{/if}</span
            >
          </div>
          <div>
            <span class="k">Users</span>
            <span class="v"
              >{#if week}{abbr(week.users)}{:else}<span class="skeleton v-skel"></span>{/if}</span
            >
          </div>
        </div>

        {#if variants.length > 1}
          <section class="sect">
            <div class="sh"><span>Variants</span><span class="dim">{variants.length}</span></div>
            <ul class="variants">
              {#each variants as m (m)}
                <li>
                  <span class="mono ellipsis" title={m}>{m}</span>
                  <span class="num dim">{abbr(variantCounts[m] ?? 0)}</span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <section class="sect flush">
          <div class="sh"><span>Recent requests</span></div>
          {#each occ.slice(0, 8) as a (a.id)}
            {@const o = occOps[a.operation_id]}
            <div class="orow">
              <span class="t" title={formatDateTime(a.timestamp, { seconds: true })}
                >{formatRelativeTime(a.timestamp)}</span
              >
              {#if a.operation_id}
                <a
                  class="mono ellipsis url"
                  class:dim={!o}
                  href="#/requests/{a.operation_id}"
                  title={o?.originalUrl ?? ''}
                  >{o ? urlLabel(o.originalUrl) : opsLoaded ? 'no longer kept' : '…'}</a
                >
              {:else}
                <span class="mono ellipsis dim">not linked to a request</span>
              {/if}
              {#if a.user_id}
                <a class="user-cell" href="#/users/{a.user_id}" title="user {a.user_id}"
                  ><Avatar id={a.user_id} size={18} /><span class="id">{shortId(a.user_id)}</span
                  ></a
                >
              {:else}
                <span></span>
              {/if}
            </div>
          {:else}
            {#if occLoading}
              <div class="skel-rows" aria-hidden="true">
                {#each [80, 64, 72] as w (w)}<span class="skeleton" style="width:{w}%"
                  ></span>{/each}
              </div>
            {:else}
              <div class="none-yet">No events kept for this issue.</div>
            {/if}
          {/each}
        </section>
      </div>

      <footer class="foot">
        <button
          class="icon-btn sm"
          title="Search logs for this issue"
          aria-label="search logs for this issue"
          onclick={() => navigate('logs', { search: logSearch(selected), range: '7d' })}
          ><SquareTerminal size={15} /></button
        >
        <button
          class="icon-btn sm"
          title={copier.copied ? 'Copied' : 'Copy message'}
          aria-label="copy message"
          onclick={() => copier.copy(selected.members[0])}
          >{#if copier.copied}<Check size={15} />{:else}<Copy size={15} />{/if}</button
        >
        <span class="grow"></span>
        {#if selected.state !== 'open'}
          <button class="btn sm" disabled={saving} onclick={() => apply([selected], 'reopen')}
            ><RotateCcw size={13} />Reopen</button
          >
        {/if}
        {#if selected.state !== 'muted'}
          <div class="mute">
            <button
              class="btn sm"
              disabled={saving}
              aria-haspopup="menu"
              aria-expanded={muteOpen}
              title="Mute (M mutes for 24 hours)"
              onclick={toggleMute}><BellOff size={13} />Mute<ChevronDown size={13} /></button
            >
            {#if muteOpen}
              <div class="pop mute-menu" role="menu" aria-label="mute for">
                <button role="menuitem" onclick={() => apply([selected], 'mute24')}
                  >For 24 hours<kbd>M</kbd></button
                >
                <button role="menuitem" onclick={() => apply([selected], 'mute7')}
                  >For 7 days</button
                >
              </div>
            {/if}
          </div>
        {/if}
        {#if selected.state !== 'resolved'}
          <button
            class="btn sm primary"
            disabled={saving}
            title="Resolve (R)"
            onclick={() => apply([selected], 'resolve')}><CircleCheck size={13} />Resolve</button
          >
        {/if}
      </footer>
    </section>
  {:else if wide}
    <section class="panel detail placeholder" aria-label="selected issue">
      {#if loaded}
        <div class="empty">
          <b>No issue selected</b>
          {visible.length ? 'Pick one from the list.' : 'Nothing to look at in this list.'}
          <div class="keys">
            <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span><kbd>R</kbd> resolve</span>
            <span><kbd>M</kbd> mute 24h</span>
            <span><kbd>Esc</kbd> clear</span>
          </div>
        </div>
      {:else}
        <div class="skel-rows loading" aria-hidden="true">
          {#each [40, 90, 70, 100, 60] as w (w)}<span class="skeleton" style="width:{w}%"
            ></span>{/each}
        </div>
      {/if}
    </section>
  {/if}
</div>

{#if toast}
  <div class="toast" role="status" aria-live="polite">
    <CircleCheck size={15} />
    <span>{toast.text}</span>
    <span class="tsep">·</span>
    <button class="undo" onclick={toast.undo}>Undo</button>
  </div>
{/if}

<style>
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 440px;
    grid-template-rows: minmax(0, 1fr);
    gap: var(--gap);
    height: calc(100vh - var(--grid-top, 170px) - 48px);
    min-height: 420px;
  }
  .issues-list {
    min-width: 0;
    height: 100%;
  }

  /* DataTable fills the column; its body scrolls under the toolbar and sticky header. */
  .issues-list :global(.tbl) {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .issues-list :global(.tbl > .body) {
    flex: 1;
    min-height: 0;
    overscroll-behavior: contain;
  }
  .issues-list :global(.tbl .tr) {
    gap: 12px;
    padding: 0 16px;
  }
  .issues-list :global(.tr.issue-row) {
    height: 64px;
    cursor: pointer;
    transition:
      background 0.08s,
      opacity 0.3s ease;
  }
  .issues-list :global(.tr.issue-row:hover:not(.sel)) {
    background: var(--row-hover);
  }
  .issues-list :global(.tr.issue-row.leaving) {
    opacity: 0;
    pointer-events: none;
  }

  /* toolbar: aligned to the table's columns (DataTable sets --cols on the panel) */
  .bar {
    display: grid;
    grid-template-columns: var(--cols);
    gap: 12px;
    align-items: center;
    height: 44px;
    padding: 0 16px;
    border-bottom: 1px solid var(--line);
    font-size: var(--fs);
    color: var(--text-muted);
  }
  .bar .count {
    font-variant-numeric: tabular-nums;
  }
  .bulk {
    grid-column: 2 / -1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
  }
  .bulk b {
    font-weight: 600;
    color: var(--text-bright);
    white-space: nowrap;
  }
  .bulk .sep {
    color: var(--text-dim);
    margin: 0 2px;
  }
  .seg.xs {
    padding: 2px;
    justify-self: start;
  }
  .seg.xs button {
    height: 22px;
    padding: 0 9px;
    font-size: var(--fs-sm);
  }

  /* row checkbox: shown on hover, focus, when checked or while selecting */
  .ck {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    cursor: pointer;
  }
  .ck input {
    width: 14px;
    height: 14px;
    margin: 0;
    cursor: pointer;
    accent-color: var(--accent-strong);
    opacity: 0;
    transition: opacity 0.1s;
  }
  .bar .ck input,
  .ck input:checked,
  .ck input:focus-visible,
  .selecting .ck input,
  .issues-list :global(.tr.issue-row:hover .ck input) {
    opacity: 1;
  }
  @media (hover: none) {
    .ck input {
      opacity: 1;
    }
  }
  .bar .ck input:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .cause {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .l1 {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .ttl {
    min-width: 0;
    flex: 0 1 auto;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: var(--fs-md);
    font-weight: 600;
    line-height: 20px;
    color: var(--text-bright);
    text-align: left;
    cursor: pointer;
  }
  .l2 {
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .trend {
    display: flex;
    align-items: center;
  }
  .cell-skel {
    display: inline-block;
    width: 18px;
    height: 10px;
  }
  .empty .ic.ok {
    background: var(--success-bg);
    color: var(--success-text);
  }

  /* detail */
  .detail {
    position: sticky;
    top: 24px;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .dscroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .dhead {
    padding: 18px 20px 16px;
    border-bottom: 1px solid var(--line);
  }
  h2 {
    margin: 12px 0 6px;
    font-size: var(--fs-lg);
    font-weight: 600;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .help {
    margin: 0;
    font-size: var(--fs);
    line-height: 1.5;
    color: var(--text-muted);
  }
  .basis {
    margin: 4px 0 0;
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }
  .seen {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin: 16px 0 0;
  }
  .seen dt {
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-muted);
  }
  .seen dd {
    margin: 4px 0 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .seen dd b {
    font-size: var(--fs-md);
    font-weight: 600;
    color: var(--text-bright);
  }
  .seen dd span {
    font-size: var(--fs-sm);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .seen-skel {
    display: block;
    width: 70px;
    height: 14px;
    margin-top: 3px;
  }
  .sect {
    padding: 14px 20px 16px;
    border-bottom: 1px solid var(--line);
  }
  .sect.flush {
    padding: 14px 0 4px;
    border-bottom: 0;
  }
  .sh {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-muted);
  }
  .flush .sh {
    padding: 0 20px;
    margin-bottom: 6px;
  }
  .chart-skel {
    display: block;
    height: 100px;
  }
  .note {
    margin-top: 4px;
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  .counters {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    border-bottom: 1px solid var(--line);
  }
  .counters > div {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 14px 20px;
  }
  .counters > div + div {
    border-left: 1px solid var(--line);
  }
  .counters .k {
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-muted);
  }
  .counters .v {
    font-size: var(--fs-xl);
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--text-bright);
    font-variant-numeric: tabular-nums;
  }
  .v-skel {
    display: block;
    width: 36px;
    height: 20px;
    margin-top: 3px;
  }
  .variants {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .variants li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    font-size: var(--fs-sm);
    color: var(--text-soft);
  }
  .orow {
    display: grid;
    grid-template-columns: 64px minmax(0, 1fr) 104px;
    gap: 10px;
    align-items: center;
    height: 36px;
    padding: 0 20px;
    border-top: 1px solid var(--line);
    font-size: var(--fs-sm);
  }
  .orow:hover {
    background: var(--row-hover);
  }
  .orow .t {
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .orow .url {
    color: var(--text);
  }
  .orow .url:hover {
    color: var(--accent);
  }
  .orow .user-cell:hover {
    text-decoration: none;
  }
  .orow .user-cell:hover .id {
    color: var(--accent);
  }
  .none-yet {
    padding: 12px 20px;
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px 10px 14px;
    border-top: 1px solid var(--line);
    background: var(--card);
  }
  .mute {
    position: relative;
  }
  .mute-menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
    z-index: 20;
    min-width: 168px;
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .mute-menu button {
    height: 32px;
    padding: 0 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font-size: var(--fs);
    text-align: left;
  }
  .mute-menu button:hover,
  .mute-menu button:focus-visible {
    background: var(--card-3);
    outline: 0;
  }
  .placeholder {
    display: grid;
    place-items: center;
  }
  .placeholder .loading {
    width: 100%;
    align-self: start;
    padding: 24px 20px;
  }
  .keys {
    margin-top: 16px;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px 14px;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .keys kbd + kbd {
    margin-left: 3px;
  }
  .keys span kbd:last-of-type {
    margin-right: 5px;
  }

  /* centred on wide screens so it never covers the detail pane's actions */
  @media (min-width: 641px) {
    .toast {
      left: 0;
      right: 0;
      width: max-content;
      margin: 0 auto;
    }
  }
  .toast .tsep {
    opacity: 0.5;
  }
  .undo {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  @media (max-width: 1100px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: none;
      height: auto;
      min-height: 0;
    }
    .issues-list :global(.tbl) {
      height: auto;
    }
    .detail {
      position: static;
      height: auto;
    }
    .dscroll {
      overflow: visible;
    }
  }
  @media (max-width: 640px) {
    .tabs {
      overflow-x: auto;
    }
    .orow {
      grid-template-columns: 56px minmax(0, 1fr) 28px;
    }
    .orow .user-cell .id {
      display: none;
    }
  }
</style>
