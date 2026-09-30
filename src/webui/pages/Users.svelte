<script>
  import { onDestroy } from 'svelte';
  import { Search } from 'lucide-svelte';
  import { navigate } from '../utils/router.js';
  import { userMetrics } from '../stores/sse-store.js';
  import { headerActions } from '../stores/header.js';
  import { formatBytes, formatRelativeTime } from '../utils/format.js';

  const PAGE = 50;
  const COLUMNS = [
    ['user_id', 'User'],
    ['total_commands', 'Requests'],
    ['successful_commands', 'Delivered'],
    ['failed_commands', 'Failed'],
    ['total_file_size', 'Data'],
    ['last_command_at', 'Last seen'],
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

  function sort(col) {
    if (sortBy === col) sortDesc = !sortDesc;
    else {
      sortBy = col;
      sortDesc = col !== 'user_id';
    }
    offset = 0;
  }
  function submitSearch() {
    offset = 0;
    load();
  }

  headerActions.set(actions);
  onDestroy(() => headerActions.set(null));
</script>

{#snippet actions()}
  <label class="searchbox">
    <Search size={14} />
    <input
      bind:value={search}
      onkeydown={e => e.key === 'Enter' && submitSearch()}
      placeholder="find a user id"
      aria-label="find a user id"
    />
  </label>
{/snippet}

{#snippet board(title, list, value)}
  <section class="panel">
    <div class="ph"><span>{title}</span></div>
    {#each list as u, i (u.user_id)}
      <button class="lb" onclick={() => navigate('user-profile', { userId: u.user_id })}>
        <span class="rank mono">{i + 1}</span>
        <span class="mono ellipsis">{u.user_id}</span>
        <span class="mono muted small">{value(u)}</span>
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
      <div class="s">ran at least one command</div>
    </div>
    <div class="kpi">
      <div class="k">Active, 30 days</div>
      <div class="v">{stats?.active_users_30d?.toLocaleString() ?? '—'}</div>
      <div class="s">ran at least one command</div>
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
      u => `${u.total_commands.toLocaleString()} requests`
    )}
    {@render board(
      'Highest success rate',
      boards.success,
      u => `${rate(u)}% of ${u.total_commands}`
    )}
    {@render board('Most data', boards.data, u => formatBytes(u.total_file_size))}
  </div>

  <section
    class="panel tbl"
    aria-label="users"
    style="--cols: minmax(0, 1.4fr) 90px 90px 80px 70px 96px 100px"
  >
    <div class="tr head">
      {#each COLUMNS.slice(0, 4) as [col, label] (col)}
        <button class="sorter" class:num={col !== 'user_id'} onclick={() => sort(col)}>
          {label}{#if sortBy === col}<span class="arrow">{sortDesc ? '↓' : '↑'}</span>{/if}
        </button>
      {/each}
      <span class="num">Success</span>
      {#each COLUMNS.slice(4) as [col, label] (col)}
        {#if col === 'last_command_at'}
          <span class="num">{label}</span>
        {:else}
          <button class="sorter num" onclick={() => sort(col)}>
            {label}{#if sortBy === col}<span class="arrow">{sortDesc ? '↓' : '↑'}</span>{/if}
          </button>
        {/if}
      {/each}
    </div>
    {#if error}<div class="empty error-text">{error}</div>{/if}
    {#each users as u (u.user_id)}
      <button class="tr" onclick={() => navigate('user-profile', { userId: u.user_id })}>
        <span class="mono ellipsis">{u.user_id}</span>
        <span class="num">{u.total_commands.toLocaleString()}</span>
        <span class="num muted">{u.successful_commands.toLocaleString()}</span>
        <span class="num" class:bad={u.failed_commands > 0}
          >{u.failed_commands.toLocaleString()}</span
        >
        <span class="num muted">{rate(u)}%</span>
        <span class="num muted small">{formatBytes(u.total_file_size)}</span>
        <span class="num dim small"
          >{u.last_command_at ? formatRelativeTime(u.last_command_at) : '—'}</span
        >
      </button>
    {:else}
      <div class="empty">{loading ? 'loading…' : 'no users found'}</div>
    {/each}
    <div class="pager">
      <span class="dim"
        >{total
          ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total.toLocaleString()}`
          : ''}</span
      >
      <span class="row">
        <button
          class="btn sm"
          disabled={offset === 0}
          onclick={() => (offset = Math.max(0, offset - PAGE))}>Previous</button
        >
        <button class="btn sm" disabled={offset + PAGE >= total} onclick={() => (offset += PAGE)}
          >Next</button
        >
      </span>
    </div>
  </section>
</div>

<style>
  .users {
    max-width: 1400px;
    margin: 0 auto;
  }
  .small {
    font-size: 12px;
  }
  .searchbox {
    height: 32px;
    width: 240px;
    padding: 0 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-muted);
  }
  .searchbox input {
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    outline: 0;
    color: var(--text-bright);
    font: inherit;
    font-size: 13px;
  }
  .boards {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
  }
  .lb {
    width: 100%;
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 9px 16px;
    border: 0;
    border-top: 1px solid var(--line);
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .lb:first-of-type {
    border-top: 0;
  }
  .lb:hover {
    background: #191a1f;
  }
  .rank {
    color: var(--text-dim);
    font-size: 12px;
  }
  .sorter {
    background: none;
    border: 0;
    padding: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .sorter:hover {
    color: var(--text);
  }
  .sorter.num {
    text-align: right;
  }
  .arrow {
    margin-left: 4px;
    color: var(--accent);
  }
  .bad {
    color: var(--warning);
  }
  .pager {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-top: 1px solid var(--line);
    font-size: 12px;
  }
  @media (max-width: 1000px) {
    .boards {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 700px) {
    .tbl {
      --cols: minmax(0, 1fr) 70px 70px !important;
    }
    .tbl .tr > :nth-child(n + 4) {
      display: none;
    }
    .searchbox {
      width: 150px;
    }
  }
</style>
