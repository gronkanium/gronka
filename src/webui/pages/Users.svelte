<script>
  import { onDestroy } from 'svelte';
  import { Search, Users as UsersIcon } from 'lucide-svelte';
  import { navigate } from '../utils/router.js';
  import { userMetrics } from '../stores/sse-store.js';
  import { formatBytes, formatRelativeTime } from '../utils/format.js';
  import PageHeader from '../components/PageHeader.svelte';
  import DataTable from '../components/DataTable.svelte';
  import Avatar from '../components/Avatar.svelte';

  const PAGE = 50;
  const COLUMNS = [
    { key: 'user_id', label: 'User', width: '240px', sortable: true },
    { key: 'total_commands', label: 'Requests', width: '96px', align: 'right', sortable: true },
    {
      key: 'successful_commands',
      label: 'Delivered',
      width: '96px',
      align: 'right',
      sortable: true,
      sm: false,
    },
    { key: 'failed_commands', label: 'Failed', width: '80px', align: 'right', sortable: true },
    { key: 'rate', label: 'Success', width: 'minmax(160px, 1fr)', sm: false },
    {
      key: 'total_file_size',
      label: 'Data',
      width: '96px',
      align: 'right',
      sortable: true,
      sm: false,
    },
    { key: 'last_command_at', label: 'Last seen', width: '100px', align: 'right', sm: false },
  ];
  const BOARDS = [
    ['active', 'Most active', 'all time'],
    ['success', 'Highest success rate', '5+ requests'],
    ['data', 'Most data', 'processed for them'],
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
  let boards = $state({ active: [], data: [], success: [] });
  let board = $state('active');

  const rate = u =>
    u.total_commands ? Math.round((u.successful_commands / u.total_commands) * 100) : 0;
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

  async function loadBoards() {
    const [s, active, data] = await Promise.all([
      get('/api/stats'),
      get('/api/users?sortBy=total_commands&sortDesc=true&limit=200'),
      get('/api/users?sortBy=total_file_size&sortDesc=true&limit=5'),
    ]);
    stats = s;
    const top = active?.users ?? [];
    boards = {
      active: top.slice(0, 8),
      data: (data?.users ?? []).slice(0, 8),
      success: top
        .filter(u => u.total_commands >= 5)
        .sort((a, b) => rate(b) - rate(a) || b.total_commands - a.total_commands)
        .slice(0, 8),
    };
  }

  $effect(() => {
    sortBy;
    sortDesc;
    offset;
    load();
  });
  loadBoards();

  // Live metric updates: refresh what's on screen, debounced since they arrive per command.
  let soon;
  const unsub = userMetrics.subscribe(map => {
    if (!map?.size) return;
    clearTimeout(soon);
    soon = setTimeout(() => {
      load();
      loadBoards();
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
  const boardList = $derived(boards[board]);
  const boardValue = u =>
    board === 'active'
      ? `${u.total_commands.toLocaleString()} requests`
      : board === 'success'
        ? `${rate(u)}% of ${u.total_commands}`
        : formatBytes(u.total_file_size);
  const boardShare = u =>
    board === 'active'
      ? u.total_commands / Math.max(1, boards.active[0]?.total_commands ?? 1)
      : board === 'success'
        ? rate(u) / 100
        : u.total_file_size / Math.max(1, boards.data[0]?.total_file_size ?? 1);
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
      <div class="v">{boards.active[0]?.total_commands.toLocaleString() ?? '—'}</div>
      <div class="s">requests, all time</div>
    </div>
  </section>

  <div class="two wide-right">
    <section class="panel" aria-label="leaderboards">
      <div class="ph">
        <span>Leaderboard</span>
        <span class="meta"><span class="dim">{BOARDS.find(b => b[0] === board)?.[2]}</span></span>
      </div>
      <div class="seg boards" role="tablist">
        {#each BOARDS as [id, label] (id)}
          <button
            role="tab"
            aria-selected={board === id}
            class:on={board === id}
            onclick={() => (board = id)}>{label}</button
          >
        {/each}
      </div>
      {#each boardList as u, i (u.user_id)}
        <button class="lrow lb" onclick={() => navigate('user-profile', { userId: u.user_id })}>
          <span class="rank">{i + 1}</span>
          <Avatar id={u.user_id} size={26} />
          <span class="grow">
            <span class="mono id ellipsis">{u.user_id}</span>
            <span class="bar-track"><span style="width:{boardShare(u) * 100}%"></span></span>
          </span>
          <span class="mono muted small tnum nowrap">{boardValue(u)}</span>
        </button>
      {:else}
        <div class="skel-rows">
          {#each Array(6) as _, i (i)}<span class="skeleton" style="width:{80 - i * 6}%"
            ></span>{/each}
        </div>
      {/each}
    </section>

    <DataTable
      title="All users"
      columns={COLUMNS}
      rows={users}
      rowKey="user_id"
      {loading}
      {error}
      onretry={load}
      sort={{ key: sortBy, desc: sortDesc }}
      {onsort}
      onrow={u => navigate('user-profile', { userId: u.user_id })}
      pager={{ offset, limit: PAGE, total, onpage: o => (offset = o) }}
      skeleton={10}
      label="users"
    >
      {#snippet header()}
        <span class="tnum"><b>{total.toLocaleString()}</b> users</span>
        <label class="searchbox users-search">
          <Search size={14} />
          <input
            bind:value={search}
            onkeydown={e => e.key === 'Enter' && submitSearch()}
            placeholder="Find a user id"
            aria-label="find a user id"
          />
        </label>
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
        <span class="num muted hide-sm">{u.successful_commands.toLocaleString()}</span>
        <span class="num" class:warn-text={u.failed_commands > 0} class:muted={!u.failed_commands}
          >{u.failed_commands.toLocaleString()}</span
        >
        <span class="ratecell hide-sm">
          <span class="bar-track"
            ><span style="width:{rate(u)}%; background:{rateTone(rate(u))}"></span></span
          >
          <span class="num muted">{rate(u)}%</span>
        </span>
        <span class="num muted hide-sm">{formatBytes(u.total_file_size)}</span>
        <span class="num dim hide-sm"
          >{u.last_command_at ? formatRelativeTime(u.last_command_at) : '—'}</span
        >
      {/snippet}
    </DataTable>
  </div>
</div>

<style>
  .users-search {
    width: 200px;
    height: 28px;
  }
  .boards {
    margin: 12px 16px 4px;
    display: flex;
  }
  .boards button {
    flex: 1;
    justify-content: center;
    padding: 0 6px;
    font-size: var(--fs-sm);
  }
  .lb {
    padding: 9px 20px;
  }
  .lb .grow {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .lb .id {
    font-size: var(--fs-sm);
    color: var(--text-bright);
  }
  .lb .bar-track {
    height: 4px;
  }
  .lb .bar-track > span {
    background: var(--chart-1-soft);
  }
  .lb:hover .bar-track > span {
    background: var(--chart-1);
  }
  .rank {
    width: 16px;
    color: var(--text-dim);
    font-size: var(--fs-sm);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
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
</style>
