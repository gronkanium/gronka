<script>
  import { onDestroy } from 'svelte';
  import { Search } from 'lucide-svelte';
  import { navigate } from '../utils/router.js';
  import { userMetrics } from '../stores/sse-store.js';
  import { useHeaderActions } from '../stores/header.js';
  import { formatBytes, formatRelativeTime } from '../utils/format.js';
  import DataTable from '../components/DataTable.svelte';

  const PAGE = 50;
  const COLUMNS = [
    { key: 'user_id', label: 'user', width: 'minmax(0, 1.4fr)', sortable: true },
    { key: 'total_commands', label: 'requests', width: '90px', align: 'right', sortable: true },
    {
      key: 'successful_commands',
      label: 'delivered',
      width: '90px',
      align: 'right',
      sortable: true,
      sm: false,
    },
    { key: 'failed_commands', label: 'failed', width: '80px', align: 'right', sortable: true },
    { key: 'rate', label: 'success', width: '110px', align: 'right', sm: false },
    {
      key: 'total_file_size',
      label: 'data',
      width: '90px',
      align: 'right',
      sortable: true,
      sm: false,
    },
    { key: 'last_command_at', label: 'last seen', width: '96px', align: 'right', sm: false },
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
      data: data?.users ?? [],
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

  useHeaderActions(actions);
</script>

{#snippet actions()}
  <label class="searchbox users-search">
    <Search size={14} />
    <input
      bind:value={search}
      onkeydown={e => e.key === 'Enter' && submitSearch()}
      placeholder="find a user id"
      aria-label="find a user id"
    />
  </label>
{/snippet}

{#snippet board(title, list, value, share)}
  <section class="panel">
    <div class="ph"><span>{title}</span></div>
    {#each list as u, i (u.user_id)}
      <button class="lrow lb" onclick={() => navigate('user-profile', { userId: u.user_id })}>
        <span class="rank mono">{i + 1}</span>
        <span class="grow">
          <span class="mono ellipsis">{u.user_id}</span>
          <span class="bar-track"><span style="width:{share(u) * 100}%"></span></span>
        </span>
        <span class="mono muted small tnum">{value(u)}</span>
      </button>
    {:else}
      <div class="empty">—</div>
    {/each}
  </section>
{/snippet}

<div class="users stack">
  <section class="panel kpis" style="--kpi-cols: 4">
    <div class="kpi">
      <div class="k">Users, ever</div>
      <div class="v">{stats?.ever_active_users?.toLocaleString() ?? '—'}</div>
      <div class="s">one row per Discord id</div>
    </div>
    <div class="kpi">
      <div class="k">Active, 7 days</div>
      <div class="v">{stats?.active_users_7d?.toLocaleString() ?? '—'}</div>
      <div class="s">
        {stats?.ever_active_users
          ? `${Math.round((stats.active_users_7d / stats.ever_active_users) * 100)}% of everyone`
          : 'ran at least one command'}
      </div>
    </div>
    <div class="kpi">
      <div class="k">Active, 30 days</div>
      <div class="v">{stats?.active_users_30d?.toLocaleString() ?? '—'}</div>
      <div class="s">
        {stats?.ever_active_users
          ? `${Math.round((stats.active_users_30d / stats.ever_active_users) * 100)}% of everyone`
          : 'ran at least one command'}
      </div>
    </div>
    <div class="kpi">
      <div class="k">Top user</div>
      <div class="v">{boards.active[0]?.total_commands.toLocaleString() ?? '—'}</div>
      <div class="s">requests, all time</div>
    </div>
  </section>

  <div class="boards">
    {@render board(
      'Most active',
      boards.active,
      u => `${u.total_commands.toLocaleString()} requests`,
      u => u.total_commands / boardMax(boards.active)
    )}
    {@render board(
      'Highest success rate',
      boards.success,
      u => `${rate(u)}% of ${u.total_commands}`,
      u => rate(u) / 100
    )}
    {@render board(
      'Most data',
      boards.data,
      u => formatBytes(u.total_file_size),
      u => u.total_file_size / Math.max(1, boards.data[0]?.total_file_size ?? 1)
    )}
  </div>

  <DataTable
    columns={COLUMNS}
    rows={users}
    rowKey="user_id"
    {loading}
    {error}
    onretry={load}
    empty="no users found"
    sort={{ key: sortBy, desc: sortDesc }}
    {onsort}
    onrow={u => navigate('user-profile', { userId: u.user_id })}
    pager={{ offset, limit: PAGE, total, onpage: o => (offset = o) }}
    skeleton={10}
    label="users"
  >
    {#snippet row(u)}
      <span class="mono ellipsis">{u.user_id}</span>
      <span class="num">{u.total_commands.toLocaleString()}</span>
      <span class="num muted hide-sm">{u.successful_commands.toLocaleString()}</span>
      <span class="num" class:warn-text={u.failed_commands > 0} class:muted={!u.failed_commands}
        >{u.failed_commands.toLocaleString()}</span
      >
      <span class="ratecell hide-sm">
        <span class="bar-track"
          ><span
            style="width:{rate(u)}%; background:{rate(u) >= 90
              ? 'var(--chart-1)'
              : rate(u) >= 70
                ? 'var(--warning)'
                : 'var(--danger)'}"
          ></span></span
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
    width: 240px;
  }
  .boards {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--gap);
    align-items: start;
  }
  .lb .grow {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .lb .bar-track {
    height: 3px;
  }
  .lb .bar-track > span {
    background: var(--chart-muted);
  }
  .lb:hover .bar-track > span {
    background: var(--chart-1);
  }
  .rank {
    width: 18px;
    color: var(--text-dim);
    font-size: var(--fs-sm);
  }
  .ratecell {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ratecell .bar-track {
    flex: 1;
    height: 4px;
  }
  .ratecell .num {
    width: 38px;
  }
  @media (max-width: 1000px) {
    .boards {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 700px) {
    .users-search {
      width: 150px;
    }
  }
</style>
