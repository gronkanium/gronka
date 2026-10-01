<script>
  import { onDestroy } from 'svelte';
  import { Search, Users as UsersIcon, ArrowUpRight } from 'lucide-svelte';
  import { navigate } from '../utils/router.js';
  import { userMetrics } from '../stores/sse-store.js';
  import { formatDate, formatRelativeTime } from '../utils/format.js';
  import PageHeader from '../components/PageHeader.svelte';
  import DataTable from '../components/DataTable.svelte';
  import Avatar from '../components/Avatar.svelte';

  const PAGE = 50;
  const COLUMNS = [
    { key: 'user_id', label: 'User', width: 'minmax(0, 1fr)', sortable: true },
    { key: 'total_commands', label: 'Requests', width: '84px', align: 'right', sortable: true },
    { key: 'failed_commands', label: 'Failed', width: '72px', align: 'right', sortable: true },
    { key: 'rate', label: 'Success', width: '150px', sm: false },
    {
      key: 'last_command_at',
      label: 'Last seen',
      width: '92px',
      align: 'right',
      sortable: true,
      sm: false,
    },
  ];
  const VIEWS = [
    ['total_commands', 'Most active'],
    ['last_command_at', 'Recently seen'],
    ['failed_commands', 'Most failures'],
  ];

  let users = $state([]);
  let total = $state(0);
  let loading = $state(true);
  let error = $state('');
  let search = $state('');
  let sortBy = $state('total_commands');
  let sortDesc = $state(true);
  let offset = $state(0);
  let stats = $state(null);
  let topUser = $state(null);
  let picked = $state(null);
  let innerWidth = $state(1400);
  const split = $derived(innerWidth > 1100);

  const rate = u =>
    u.total_commands
      ? Math.round(((u.total_commands - u.failed_commands) / u.total_commands) * 100)
      : 0;
  const get = url =>
    fetch(url)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error())))
      .catch(() => null);

  async function load() {
    loading = true;
    error = '';
    const q = new URLSearchParams({
      sortBy,
      sortDesc: String(sortDesc),
      limit: String(PAGE),
      offset: String(offset),
    });
    if (search.trim()) q.set('search', search.trim());
    const data = await get(`/api/users?${q}`);
    if (!data) error = 'could not load users';
    users = data?.users ?? [];
    total = data?.total ?? 0;
    loading = false;
  }

  async function loadStats() {
    const [st, top] = await Promise.all([
      get('/api/stats'),
      get('/api/users?sortBy=total_commands&sortDesc=true&limit=1'),
    ]);
    stats = st;
    topUser = top?.users?.[0] ?? null;
  }

  $effect(() => {
    sortBy;
    sortDesc;
    offset;
    load();
  });
  loadStats();

  // Live metric updates: refresh what's on screen, debounced since they arrive per command.
  let soon;
  const unsub = userMetrics.subscribe(map => {
    if (!map?.size) return;
    clearTimeout(soon);
    soon = setTimeout(() => {
      load();
      loadStats();
    }, 1500);
  });
  onDestroy(() => {
    unsub();
    clearTimeout(soon);
  });

  function onsort(key, desc) {
    sortBy = key;
    sortDesc = desc;
    offset = 0;
  }
  function submitSearch() {
    offset = 0;
    load();
  }
  const selected = $derived(users.find(u => u.user_id === picked) ?? users[0] ?? null);
  const openRow = u =>
    split ? (picked = u.user_id) : navigate('user-profile', { userId: u.user_id });

  // Same as Issues: the panes fill the viewport below the header, so measure where they start.
  let gridEl = $state();
  let gridTop = $state(0);
  $effect(() => {
    if (!gridEl) return;
    const measure = () =>
      (gridTop = Math.round(gridEl.getBoundingClientRect().top + window.scrollY));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(gridEl.parentElement ?? gridEl);
    return () => ro.disconnect();
  });
  const rateTone = r =>
    r >= 90 ? 'var(--chart-1)' : r >= 75 ? 'var(--chart-3)' : 'var(--chart-4)';
</script>

<PageHeader title="Users" description="Everyone who has run a command" />

<div class="users stack">
  <section class="kpis" style="--kpi-cols: 4">
    <div class="kpi">
      <div class="k">Users, ever</div>
      <div class="v">{stats?.ever_active_users?.toLocaleString() ?? '—'}</div>
      <div class="s">one row per Discord id</div>
    </div>
    <div class="kpi">
      <div class="k">Active, 7 days</div>
      <div class="v">{stats?.active_users_7d?.toLocaleString() ?? '—'}</div>
      {#if stats?.ever_active_users}<span class="d plain"
          >{Math.round((stats.active_users_7d / stats.ever_active_users) * 100)}% of everyone</span
        >{/if}
      <div class="s">ran at least one command</div>
    </div>
    <div class="kpi">
      <div class="k">Active, 30 days</div>
      <div class="v">{stats?.active_users_30d?.toLocaleString() ?? '—'}</div>
      {#if stats?.ever_active_users}<span class="d plain"
          >{Math.round((stats.active_users_30d / stats.ever_active_users) * 100)}% of everyone</span
        >{/if}
      <div class="s">ran at least one command</div>
    </div>
    <div class="kpi">
      <div class="k">Top user</div>
      <div class="v">{topUser?.total_commands.toLocaleString() ?? '—'}</div>
      <div class="s">requests, all time</div>
    </div>
  </section>

  <div
    class="grid"
    class:split
    bind:this={gridEl}
    style:--grid-top={gridTop ? `${gridTop}px` : null}
  >
    <div class="list">
      <DataTable
        columns={COLUMNS}
        rows={users}
        rowKey="user_id"
        {loading}
        {error}
        onretry={load}
        selected={split ? selected?.user_id : null}
        sort={{ key: sortBy, desc: sortDesc }}
        {onsort}
        onrow={openRow}
        pager={{ offset, limit: PAGE, total, onpage: o => (offset = o) }}
        skeleton={10}
        label="users"
      >
        {#snippet toolbar()}
          <div class="bar">
            <div class="seg" role="tablist" aria-label="views">
              {#each VIEWS as [key, label] (key)}
                <button
                  role="tab"
                  aria-selected={sortBy === key && sortDesc}
                  class:on={sortBy === key && sortDesc}
                  onclick={() => onsort(key, true)}>{label}</button
                >
              {/each}
            </div>
            <span class="dim small tnum count"><b>{total.toLocaleString()}</b> users</span>
            <label class="searchbox users-search">
              <Search size={14} />
              <input
                bind:value={search}
                onkeydown={e => e.key === 'Enter' && submitSearch()}
                placeholder="Find a user id"
                aria-label="find a user id"
              />
            </label>
          </div>
        {/snippet}
        {#snippet emptyState()}
          <div class="empty">
            <span class="ic"><UsersIcon size={20} /></span>
            <b>No users found</b>
            {search ? 'No id contains that text' : 'Nobody has run a command yet'}
          </div>
        {/snippet}
        {#snippet row(u)}
          <span class="user-cell"
            ><Avatar id={u.user_id} size={22} /><span class="id">{u.user_id}</span></span
          >
          <span class="num strong">{u.total_commands.toLocaleString()}</span>
          <span class="num" class:warn-text={u.failed_commands > 0} class:muted={!u.failed_commands}
            >{u.failed_commands.toLocaleString()}</span
          >
          <span class="ratecell hide-sm">
            <span class="bar-track"
              ><span style="width:{rate(u)}%; background:{rateTone(rate(u))}"></span></span
            >
            <span class="num muted">{rate(u)}%</span>
          </span>
          <span class="num dim hide-sm"
            >{u.last_command_at ? formatRelativeTime(u.last_command_at) : '—'}</span
          >
        {/snippet}
      </DataTable>
    </div>

    {#if split}
      <aside class="panel detail" aria-label="selected user">
        {#if selected}
          {@const u = selected}
          <div class="dhead">
            <Avatar id={u.user_id} size={56} />
            <div class="who">
              <span class="mono uid">{u.user_id}</span>
              <span class="dim small"
                >last seen {u.last_command_at
                  ? formatRelativeTime(u.last_command_at)
                  : 'never'}</span
              >
            </div>
          </div>
          <div class="dscroll">
            <div class="big-rate">
              <span class="v tnum">{rate(u)}%</span>
              <span class="dim small"
                >of {u.total_commands.toLocaleString()} requests delivered</span
              >
              <span class="bar-track"
                ><span style="width:{rate(u)}%; background:{rateTone(rate(u))}"></span></span
              >
            </div>
            <div class="facts">
              <div>
                <span class="k">Delivered</span><b class="tnum"
                  >{(u.total_commands - u.failed_commands).toLocaleString()}</b
                >
              </div>
              <div>
                <span class="k">Failed</span><b class="tnum" class:warn-text={u.failed_commands > 0}
                  >{u.failed_commands.toLocaleString()}</b
                >
              </div>
              <div>
                <span class="k">First seen</span><b class="tnum">{formatDate(u.first_used)}</b>
              </div>
            </div>
          </div>
          <div class="dfoot">
            <button
              class="btn primary"
              onclick={() => navigate('user-profile', { userId: u.user_id })}
              ><ArrowUpRight size={14} />Open profile</button
            >
          </div>
        {:else}
          <div class="skel-rows">
            {#each Array(5) as _, i (i)}<span class="skeleton" style="width:{80 - i * 8}%"
              ></span>{/each}
          </div>
        {/if}
      </aside>
    {/if}
  </div>
</div>

<svelte:window bind:innerWidth />

<style>
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--gap);
  }
  .grid.split {
    grid-template-columns: minmax(0, 1fr) 360px;
    grid-template-rows: minmax(0, 1fr);
    height: calc(100vh - var(--grid-top, 330px) - 48px);
    min-height: 480px;
  }
  .list {
    min-width: 0;
  }
  .split .list,
  .split .list :global(.tbl) {
    height: 100%;
  }
  .split .list :global(.tbl) {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .split .list :global(.tbl > .body) {
    flex: 1;
    min-height: 0;
    overscroll-behavior: contain;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 10px 16px;
    border-bottom: 1px solid var(--line);
  }
  .bar .seg {
    max-width: 100%;
    overflow-x: auto;
  }
  .bar .seg button {
    font-size: var(--fs-sm);
    white-space: nowrap;
  }
  .count {
    margin-left: auto;
  }
  .count b {
    color: var(--text);
  }
  .users-search {
    width: 200px;
    height: 28px;
  }
  .ratecell {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ratecell .bar-track {
    flex: 1;
    height: 6px;
  }
  .ratecell .num {
    width: 40px;
  }
  .detail {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
  }
  .dhead {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 20px;
    border-bottom: 1px solid var(--line);
  }
  .who {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .uid {
    font-size: var(--fs-md);
    font-weight: 600;
    color: var(--text-bright);
    overflow-wrap: anywhere;
  }
  .dscroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .big-rate {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 18px 20px;
    border-bottom: 1px solid var(--line);
  }
  .big-rate .v {
    font-size: 28px;
    font-weight: 600;
    color: var(--text-bright);
    letter-spacing: -0.02em;
  }
  .big-rate .bar-track {
    height: 6px;
    margin-top: 4px;
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    border-bottom: 1px solid var(--line);
  }
  .facts > div {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 14px 20px;
  }
  .facts > div + div {
    border-left: 1px solid var(--line);
  }
  .facts .k {
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .facts b {
    font-size: var(--fs-md);
    color: var(--text-bright);
  }
  .dfoot {
    padding: 12px 20px;
    border-top: 1px solid var(--line);
    display: flex;
    justify-content: flex-end;
  }
</style>
