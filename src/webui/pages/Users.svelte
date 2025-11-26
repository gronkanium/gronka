<script>
  import { onMount } from 'svelte';
  import { navigate } from '../utils/router.js';
  import { userMetrics as wsUserMetrics, connected as wsConnected } from '../stores/websocket-store.js';
  import ResponsiveGrid from '../components/ResponsiveGrid.svelte';

  let users = [];
  let total = 0;
  let loading = true;
  let error = null;

  let searchQuery = '';
  let sortBy = 'total_commands';
  let sortDesc = true;
  let limit = 50;
  let offset = 0;

  async function fetchUsers() {
    loading = true;
    error = null;
    try {
      const params = new URLSearchParams({
        sortBy,
        sortDesc: sortDesc.toString(),
        limit: limit.toString(),
        offset: offset.toString(),
      });

      if (searchQuery) params.append('search', searchQuery);

      const response = await fetch(`/api/users?${params}`);
      if (!response.ok) throw new Error('failed to fetch users');

      const data = await response.json();
      users = data.users || [];
      total = data.total || 0;
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  function handleSearch() {
    offset = 0;
    fetchUsers();
  }

  function handleSort(field) {
    if (sortBy === field) {
      sortDesc = !sortDesc;
    } else {
      sortBy = field;
      sortDesc = true;
    }
    offset = 0;
    fetchUsers();
  }

  function handlePrevPage() {
    if (offset > 0) {
      offset = Math.max(0, offset - limit);
      fetchUsers();
    }
  }

  function handleNextPage() {
    if (offset + limit < total) {
      offset += limit;
      fetchUsers();
    }
  }

  function viewUserProfile(userId) {
    navigate('users', { userId });
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  function calculateSuccessRate(user) {
    if (!user.total_commands) return 0;
    return ((user.successful_commands / user.total_commands) * 100).toFixed(1);
  }

  // Handle user metrics update from WebSocket
  function handleUserMetricsUpdate(userId, metrics) {
    // Find user in current list
    const userIndex = users.findIndex(u => u.user_id === userId);
    
    if (userIndex !== -1) {
      // Update existing user
      users[userIndex] = { ...users[userIndex], ...metrics };
      users = [...users]; // Trigger reactivity
      
      // Re-sort if needed
      if (sortBy) {
        users.sort((a, b) => {
          const aVal = a[sortBy] || 0;
          const bVal = b[sortBy] || 0;
          return sortDesc ? bVal - aVal : aVal - bVal;
        });
      }
    } else {
      // New user detected
      // Increment total count
      total += 1;
      
      // If we're on the first page and the user matches search/filters, add them to the list
      if (offset === 0 && (!searchQuery || (metrics.username && metrics.username.toLowerCase().includes(searchQuery.toLowerCase())))) {
        // Create user object from metrics
        const newUser = {
          user_id: userId,
          username: metrics.username || 'Unknown',
          total_commands: metrics.total_commands || 0,
          successful_commands: metrics.successful_commands || 0,
          failed_commands: metrics.failed_commands || 0,
          total_convert: metrics.total_convert || 0,
          total_download: metrics.total_download || 0,
          total_optimize: metrics.total_optimize || 0,
          total_info: metrics.total_info || 0,
          total_file_size: metrics.total_file_size || 0,
          last_command_at: metrics.last_command_at || null,
          updated_at: metrics.updated_at || Date.now(),
        };
        
        // Add to list and re-sort
        users = [...users, newUser];
        if (sortBy) {
          users.sort((a, b) => {
            const aVal = a[sortBy] || 0;
            const bVal = b[sortBy] || 0;
            return sortDesc ? bVal - aVal : aVal - bVal;
          });
        }
        
        // Keep only limit users if we exceed it
        if (users.length > limit) {
          users = users.slice(0, limit);
        }
      } else {
        // Not on first page or doesn't match filters, just refresh to get accurate data
        fetchUsers();
      }
    }
  }

  onMount(() => {
    // Initial fetch
    fetchUsers();
    
    // Subscribe to WebSocket user metrics (connection managed by App.svelte)
    const unsubscribe = wsUserMetrics.subscribe(metricsMap => {
      // Process each updated user
      if (metricsMap && metricsMap.size > 0) {
        metricsMap.forEach((metrics, userId) => {
          handleUserMetricsUpdate(userId, metrics);
        });
      }
    });
    
    return () => {
      unsubscribe();
    };
  });

  $: leaderboardMostActive = [...users].sort((a, b) => b.total_commands - a.total_commands).slice(0, 5);
  $: leaderboardHighestSuccess = [...users]
    .filter(u => u.total_commands >= 5)
    .sort((a, b) => calculateSuccessRate(b) - calculateSuccessRate(a))
    .slice(0, 5);
  $: leaderboardLargestFiles = [...users]
    .filter(u => u.total_file_size > 0)
    .sort((a, b) => b.total_file_size - a.total_file_size)
    .slice(0, 5);
</script>

<div class="users-container">
  <ResponsiveGrid columns={{ mobile: 1, tablet: 2, desktop: 3 }} gap="1rem">
    <div class="stat-card">
      <div class="stat-value">{total}</div>
      <div class="stat-label">total users</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{users.reduce((sum, u) => sum + u.total_commands, 0).toLocaleString()}</div>
      <div class="stat-label">total commands</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{formatBytes(users.reduce((sum, u) => sum + (u.total_file_size || 0), 0))}</div>
      <div class="stat-label">total data processed</div>
    </div>
  </ResponsiveGrid>

  <ResponsiveGrid columns={{ mobile: 1, tablet: 1, desktop: 3 }} gap="1rem">
    <div class="leaderboard-card">
      <h3>most active users</h3>
      <ul>
        {#each leaderboardMostActive as user, index}
          <li>
            <span class="rank">{index + 1}</span>
            <span class="username">{user.username}</span>
            <span class="value">{user.total_commands} commands</span>
          </li>
        {/each}
      </ul>
    </div>

    <div class="leaderboard-card">
      <h3>highest success rate</h3>
      <ul>
        {#each leaderboardHighestSuccess as user, index}
          <li>
            <span class="rank">{index + 1}</span>
            <span class="username">{user.username}</span>
            <span class="value">{calculateSuccessRate(user)}%</span>
          </li>
        {/each}
      </ul>
    </div>

    <div class="leaderboard-card">
      <h3>largest data processed</h3>
      <ul>
        {#each leaderboardLargestFiles as user, index}
          <li>
            <span class="rank">{index + 1}</span>
            <span class="username">{user.username}</span>
            <span class="value">{formatBytes(user.total_file_size)}</span>
          </li>
        {/each}
      </ul>
    </div>
  </ResponsiveGrid>

  <div class="users-table-section">
    <div class="table-header">
      <div class="search-box">
        <input
          type="text"
          bind:value={searchQuery}
          on:keydown={e => e.key === 'Enter' && handleSearch()}
          placeholder="search users..."
        />
        <button on:click={handleSearch}>search</button>
      </div>
    </div>

    {#if loading && users.length === 0}
      <div class="loading">loading users...</div>
    {:else if error}
      <div class="error">error: {error}</div>
      <button on:click={fetchUsers}>retry</button>
    {:else if users.length === 0}
      <div class="empty">no users found</div>
    {:else}
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>
                <button on:click={() => handleSort('username')}>
                  username {sortBy === 'username' ? (sortDesc ? '↓' : '↑') : ''}
                </button>
              </th>
              <th>
                <button on:click={() => handleSort('total_commands')}>
                  total {sortBy === 'total_commands' ? (sortDesc ? '↓' : '↑') : ''}
                </button>
              </th>
              <th>
                <button on:click={() => handleSort('successful_commands')}>
                  success {sortBy === 'successful_commands' ? (sortDesc ? '↓' : '↑') : ''}
                </button>
              </th>
              <th>
                <button on:click={() => handleSort('failed_commands')}>
                  failed {sortBy === 'failed_commands' ? (sortDesc ? '↓' : '↑') : ''}
                </button>
              </th>
              <th>success rate</th>
              <th>
                <button on:click={() => handleSort('total_file_size')}>
                  data {sortBy === 'total_file_size' ? (sortDesc ? '↓' : '↑') : ''}
                </button>
              </th>
              <th>actions</th>
            </tr>
          </thead>
          <tbody>
            {#each users as user}
              <tr>
                <td class="username-cell">{user.username}</td>
                <td class="number-cell">{user.total_commands}</td>
                <td class="number-cell success">{user.successful_commands}</td>
                <td class="number-cell error">{user.failed_commands}</td>
                <td class="number-cell">{calculateSuccessRate(user)}%</td>
                <td class="number-cell">{formatBytes(user.total_file_size)}</td>
                <td class="actions-cell">
                  <button class="view-btn" on:click={() => viewUserProfile(user.user_id)}>
                    view
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="pagination">
        <div class="pagination-info">
          showing {offset + 1}-{Math.min(offset + limit, total)} of {total}
        </div>
        <div class="pagination-controls">
          <button on:click={handlePrevPage} disabled={offset === 0}>
            previous
          </button>
          <button on:click={handleNextPage} disabled={offset + limit >= total}>
            next
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .users-container {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }


  .stat-card {
    padding: 1.5rem;
    background-color: #222;
    border: 1px solid #333;
    border-radius: 4px;
  }

  .stat-value {
    font-size: 2rem;
    font-weight: 600;
    color: #51cf66;
    margin-bottom: 0.5rem;
  }

  .stat-label {
    font-size: 0.9rem;
    color: #aaa;
  }


  .leaderboard-card {
    padding: 1.5rem;
    background-color: #222;
    border: 1px solid #333;
    border-radius: 4px;
  }

  .leaderboard-card h3 {
    margin: 0 0 1rem 0;
    font-size: 1rem;
    font-weight: 500;
    color: #fff;
    border-bottom: 1px solid #333;
    padding-bottom: 0.5rem;
  }

  .leaderboard-card ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .leaderboard-card li {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid #2a2a2a;
  }

  .leaderboard-card li:last-child {
    border-bottom: none;
  }

  .rank {
    font-weight: 600;
    color: #51cf66;
    min-width: 1.5rem;
  }

  .username {
    flex: 1;
    color: #e0e0e0;
  }

  .value {
    color: #aaa;
    font-size: 0.9rem;
  }

  .users-table-section {
    background-color: #222;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 1.5rem;
  }

  .table-header {
    margin-bottom: 1rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .search-box {
    display: flex;
    gap: 0.5rem;
  }

  .search-box input {
    padding: 0.5rem 0.75rem;
    background-color: #2a2a2a;
    border: 1px solid #444;
    color: #fff;
    font-size: 0.9rem;
    border-radius: 3px;
    min-width: 250px;
  }

  .search-box button {
    padding: 0.5rem 1rem;
    background-color: #444;
    color: #fff;
    border: 1px solid #555;
    cursor: pointer;
    font-size: 0.9rem;
    border-radius: 3px;
  }

  .search-box button:hover {
    background-color: #555;
  }

  .table-container {
    overflow-x: auto;
    margin-bottom: 1rem;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }

  thead {
    background-color: #2a2a2a;
  }

  th {
    padding: 0.75rem 1rem;
    text-align: left;
    font-weight: 500;
    color: #aaa;
    border-bottom: 1px solid #333;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  th:first-child {
    text-align: left;
  }

  th:nth-child(2),
  th:nth-child(3),
  th:nth-child(4),
  th:nth-child(5),
  th:nth-child(6) {
    text-align: right;
  }

  th:last-child {
    text-align: center;
  }

  th button {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 0;
    text-transform: inherit;
    width: 100%;
    text-align: inherit;
  }

  th button:hover {
    color: #fff;
  }

  tbody tr {
    border-bottom: 1px solid #2a2a2a;
  }

  tbody tr:hover {
    background-color: #2a2a2a;
  }

  td {
    padding: 0.75rem 1rem;
    color: #e0e0e0;
  }

  .username-cell {
    font-weight: 500;
    text-align: left;
  }

  .number-cell {
    text-align: right;
    font-family: monospace;
  }

  .number-cell.success {
    color: #51cf66;
  }

  .number-cell.error {
    color: #ff6b6b;
  }

  .actions-cell {
    text-align: center;
  }

  .view-btn {
    padding: 0.4rem 0.8rem;
    background-color: #444;
    color: #fff;
    border: 1px solid #555;
    cursor: pointer;
    font-size: 0.85rem;
    border-radius: 3px;
  }

  .view-btn:hover {
    background-color: #555;
  }

  .pagination {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 0;
  }

  .pagination-info {
    font-size: 0.85rem;
    color: #aaa;
  }

  .pagination-controls {
    display: flex;
    gap: 0.5rem;
  }

  .pagination-controls button {
    padding: 0.4rem 0.8rem;
    font-size: 0.85rem;
    background-color: #444;
    color: #fff;
    border: 1px solid #555;
    cursor: pointer;
    border-radius: 3px;
  }

  .pagination-controls button:hover:not(:disabled) {
    background-color: #555;
  }

  .pagination-controls button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .loading,
  .error,
  .empty {
    padding: 2rem;
    text-align: center;
  }

  .loading {
    color: #888;
  }

  .error {
    color: #ff6b6b;
  }

  .empty {
    color: #888;
  }

  @media (max-width: 768px) {
    .users-container {
      gap: 1rem;
    }
    
    .stat-card {
      padding: 1rem;
    }
    
    .stat-value {
      font-size: 1.5rem;
    }
    
    .stat-label {
      font-size: 0.85rem;
    }
    
    .leaderboard-card {
      padding: 1rem;
    }
    
    .leaderboard-card h3 {
      font-size: 0.9rem;
    }
    
    .search-box {
      flex-direction: column;
    }
    
    .search-box input {
      min-width: 0;
      width: 100%;
    }
    
    .search-box button {
      width: 100%;
      min-height: 44px;
    }

    .table-container {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    
    table {
      font-size: 0.8rem;
      min-width: 700px;
    }

    th,
    td {
      padding: 0.5rem 0.5rem;
      font-size: 0.75rem;
    }

    th:nth-child(2),
    th:nth-child(3),
    th:nth-child(4),
    th:nth-child(5),
    th:nth-child(6) {
      text-align: right;
    }

    th:last-child {
      text-align: center;
    }
    
    .view-btn {
      min-width: 44px;
      min-height: 44px;
      padding: 0.5rem 1rem;
    }
    
    .pagination {
      flex-direction: column;
      gap: 0.75rem;
      align-items: stretch;
    }
    
    .pagination-controls {
      width: 100%;
    }
    
    .pagination-controls button {
      flex: 1;
      min-height: 44px;
    }
  }
</style>

