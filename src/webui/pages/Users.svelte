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
    { key: 'user_id', label: 'user', width: 'minmax(0, 1.4fr)', sortable: true },
    { key: 'total_commands', label: 'requests', width: '96px', align: 'right', sortable: true },
    {
      key: 'successful_commands',
      label: 'delivered',
      width: '96px',
      align: 'right',
      sortable: true,
      sm: false,
    },
    { key: 'failed_commands', label: 'failed', width: '80px', align: 'right', sortable: true },
    { key: 'rate', label: 'success', width: '130px', sm: false },
    {
      key: 'total_file_size',
      label: 'data',
      width: '96px',
      align: 'right',
      sortable: true,
      sm: false,
    },
    { key: 'last_command_at', label: 'last seen', width: '100px', align: 'right', sm: false },
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
      active: top.slice(0, 5),
      data: (data?.users ?? []).slice(0, 5),
      success: top
        .filter(u => u.total_commands >= 5)
        .sort((a, b) => rate(b) - rate(a) || b.total_commands - a.total_commands)
        .slice(0, 5),
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
  const boardMax = list => Math.max(1, ...list.map(u => u.total_commands));
  const rateColor = r =>
    r >= 90 ? 'var(--chart-1)' : r >= 70 ? 'var(--chart-3)' : 'var(--chart-4)';
</script>

<PageHeader
  title="Users"
  description="Everyone who has run a command, with how much they ask for and how often it works."
>
  {#snippet actions()}
    <label class="searchbox users-search">
      <Search size={15} />
      <input
        bind:value={search}
        onkeydown={e => e.key === 'Enter' && submitSearch()}
        placeholder="Find a user id"
        aria-label="find a user id"
      />
    </label>
  {/snippet}
</PageHeader>

{#snippet board(title, note, list, value, share)}
  <section class="panel">
    <div class="ph">
      <span>{title}</span><span class="meta"><span class="dim">{note}</span></span>
    </div>
    {#each list as u, i (u.user_id)}
      <button class="lrow lb" onclick={() => navigate('user-profile', { userId: u.user_id })}>
        <span class="rank">{i + 1}</span>
        <Avatar id={u.user_id} size={28} />
        <span class="grow">
          <span class="mono id ellipsis">{u.user_id}</span>
          <span class="bar-track"><span style="width:{share(u) * 100}%"></span></span>
        </span>
        <span class="mono muted small tnum nowrap">{value(u)}</span>
      </button>
    {:else}
      <div class="empty">—</div>
    {/each}
  </section>
{/snippet}

<div class="users stack">
  <section class="kpis" style="--kpi-cols: 4">
    <div class="kpi">
      <div class="k">Users, ever</div>
      <div class="v">{stats?.ever_active_users?.toLocaleString() ?? '—'}</div>
      <div class="s">one row per Discord id</div>
    </div>
    <div class="kpi">
      <div class="k">Active, 7 days</div>
      <div class="v">
        {stats?.active_users_7d?.toLocaleString() ?? '—'}
        {#if stats?.ever_active_users}<span class="d"
            >{Math.round((stats.active_users_7d / stats.ever_active_users) * 100)}%</span
          >{/if}
      </div>
      <div class="s">ran at least one command</div>
    </div>
    <div class="kpi">
      <div class="k">Active, 30 days</div>
      <div class="v">
        {stats?.active_users_30d?.toLocaleString() ?? '—'}
        {#if stats?.ever_active_users}<span class="d"
            >{Math.round((stats.active_users_30d / stats.ever_active_users) * 100)}%</span
          >{/if}
      </div>
      <div class="s">ran at least one command</div>
    </div>
    <div class="kpi">
      <div class="k">Top user</div>
      <div class="v">{boards.active[0]?.total_commands.toLocaleString() ?? '—'}</div>
      <div class="s">requests, all time</div>
    </div>
  </section>

  <div class="three">
    {@render board(
      'Most active',
      'all time',
      boards.active,
      u => `${u.total_commands.toLocaleString()} requests`,
      u => u.total_commands / boardMax(boards.active)
    )}
    {@render board(
      'Highest success rate',
      '5+ requests',
      boards.success,
      u => `${rate(u)}% of ${u.total_commands}`,
      u => rate(u) / 100
    )}
    {@render board(
      'Most data',
      'processed for them',
      boards.data,
      u => formatBytes(u.total_file_size),
      u => u.total_file_size / Math.max(1, boards.data[0]?.total_file_size ?? 1)
    )}
  </div>

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
    {#snippet header()}<span class="tnum"><b>{total.toLocaleString()}</b> users</span>{/snippet}
    {#snippet emptyState()}
      <div class="empty">
        <span class="ic"><UsersIcon size={20} /></span>
        <b>No users found</b>
        {search ? 'No id contains that text.' : 'Nobody has run a command yet.'}
      </div>
    {/snippet}
    {#snippet row(u)}
      <span class="user-cell"
        ><Avatar id={u.user_id} size={24} /><span class="id">{u.user_id}</span></span
      >
      <span class="num strong">{u.total_commands.toLocaleString()}</span>
      <span class="num muted hide-sm">{u.successful_commands.toLocaleString()}</span>
      <span class="num" class:warn-text={u.failed_commands > 0} class:muted={!u.failed_commands}
        >{u.failed_commands.toLocaleString()}</span
      >
      <span class="ratecell hide-sm">
        <span class="bar-track"
          ><span style="width:{rate(u)}%; background:{rateColor(rate(u))}"></span></span
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

<style>
  .users-search {
    width: 260px;
  }
  .lb {
    padding: 10px 20px;
  }
  .lb .grow {
    display: flex;
    flex-direction: column;
    gap: 6px;
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
  @media (max-width: 700px) {
    .users-search {
      width: 100%;
    }
  }
</style>
