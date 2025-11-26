<script>
  import { onMount } from 'svelte';

  let users = [];
  let usersTotal = 0;
  let usersLoading = false;
  let usersLimit = 50;
  let usersOffset = 0;
  let selectedUserId = null;
  let selectedUser = null;
  let media = [];
  let total = 0;
  let loading = false;
  let error = null;
  let deleting = false;

  let searchQuery = '';
  let fileTypeFilter = '';
  let limit = 25;
  let offset = 0;
  let selectedFiles = new Set();

  async function fetchUsers() {
    usersLoading = true;
    try {
      const params = new URLSearchParams({
        limit: usersLimit.toString(),
        offset: usersOffset.toString(),
      });

      if (searchQuery) params.append('search', searchQuery);

      const response = await fetch(`/api/users?${params}`);
      if (!response.ok) throw new Error('failed to fetch users');

      const data = await response.json();
      users = data.users || [];
      usersTotal = data.total || 0;
    } catch (err) {
      console.error('Failed to fetch users:', err);
    } finally {
      usersLoading = false;
    }
  }

  async function fetchR2Media() {
    if (!selectedUserId) {
      media = [];
      total = 0;
      return;
    }

    loading = true;
    error = null;
    try {
      const params = new URLSearchParams({
        limit: limit.toString(),
        offset: offset.toString(),
      });

      if (fileTypeFilter) params.append('fileType', fileTypeFilter);

      const response = await fetch(`/api/moderation/users/${selectedUserId}/r2-media?${params}`);
      if (!response.ok) throw new Error('failed to fetch r2 media');

      const data = await response.json();
      media = data.media || [];
      total = data.total || 0;
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  function handleUserSelect(userId) {
    // Toggle: if clicking the same user, deselect them
    if (selectedUserId === userId) {
      selectedUserId = null;
      selectedUser = null;
      media = [];
      total = 0;
      selectedFiles.clear();
    } else {
      selectedUserId = userId;
      selectedUser = users.find(u => u.user_id === userId) || null;
      offset = 0;
      selectedFiles.clear();
      fetchR2Media();
    }
  }

  function handleSearch() {
    usersOffset = 0;
    fetchUsers();
  }

  function handleUsersPrevPage() {
    if (usersOffset > 0) {
      usersOffset = Math.max(0, usersOffset - usersLimit);
      fetchUsers();
    }
  }

  function handleUsersNextPage() {
    if (usersOffset + usersLimit < usersTotal) {
      usersOffset += usersLimit;
      fetchUsers();
    }
  }

  function handleFileTypeFilter() {
    offset = 0;
    selectedFiles.clear();
    fetchR2Media();
  }

  function handlePrevPage() {
    if (offset > 0) {
      offset = Math.max(0, offset - limit);
      selectedFiles.clear();
      fetchR2Media();
    }
  }

  function handleNextPage() {
    if (offset + limit < total) {
      offset += limit;
      selectedFiles.clear();
      fetchR2Media();
    }
  }

  function toggleFileSelection(urlHash) {
    if (selectedFiles.has(urlHash)) {
      selectedFiles.delete(urlHash);
    } else {
      selectedFiles.add(urlHash);
    }
    selectedFiles = new Set(selectedFiles);
  }

  function toggleSelectAll() {
    if (selectedFiles.size === media.length) {
      selectedFiles.clear();
    } else {
      selectedFiles = new Set(media.map(m => m.url_hash));
    }
    selectedFiles = new Set(selectedFiles);
  }

  async function deleteFile(urlHash) {
    if (!confirm('Are you sure you want to delete this file? This action cannot be undone.')) {
      return;
    }

    deleting = true;
    try {
      const response = await fetch(`/api/moderation/files/${urlHash}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'failed to delete file');
      }

      // Refresh the media list
      await fetchR2Media();
    } catch (err) {
      alert(`Failed to delete file: ${err.message}`);
    } finally {
      deleting = false;
    }
  }

  async function bulkDelete() {
    if (selectedFiles.size === 0) {
      alert('Please select at least one file to delete.');
      return;
    }

    if (!confirm(`Are you sure you want to delete ${selectedFiles.size} file(s)? This action cannot be undone.`)) {
      return;
    }

    deleting = true;
    try {
      const urlHashesArray = Array.from(selectedFiles);
      console.log('Bulk delete: sending request', { urlHashes: urlHashesArray, count: urlHashesArray.length });

      const response = await fetch('/api/moderation/files/bulk', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          urlHashes: urlHashesArray,
        }),
      });

      console.log('Bulk delete: response status', response.status, response.statusText);

      if (!response.ok) {
        let errorMessage = 'failed to delete files';
        try {
          const data = await response.json();
          errorMessage = data.message || data.error || errorMessage;
          console.error('Bulk delete: error response', data);
        } catch (parseError) {
          const text = await response.text();
          console.error('Bulk delete: failed to parse error response', text);
          errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();
      console.log('Bulk delete: success response', data);
      const { results } = data;

      if (results && results.failed && results.failed.length > 0) {
        alert(`Deleted ${results.success.length} file(s), but ${results.failed.length} failed.`);
      } else if (results && results.success) {
        alert(`Successfully deleted ${results.success.length} file(s).`);
      }

      // Refresh the media list
      selectedFiles.clear();
      await fetchR2Media();
    } catch (err) {
      console.error('Bulk delete: error', err);
      alert(`Failed to delete files: ${err.message}`);
    } finally {
      deleting = false;
    }
  }

  async function deleteAllForUser() {
    if (!selectedUserId) {
      return;
    }

    if (!confirm(`Are you sure you want to delete ALL R2 files for user "${selectedUser?.username || selectedUserId}"? This action cannot be undone.`)) {
      return;
    }

    deleting = true;
    try {
      const response = await fetch(`/api/moderation/users/${selectedUserId}/r2-media`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'failed to delete user files');
      }

      const data = await response.json();
      alert(`Successfully deleted ${data.deleted} file(s) for user.`);

      // Refresh the media list
      selectedFiles.clear();
      await fetchR2Media();
    } catch (err) {
      alert(`Failed to delete user files: ${err.message}`);
    } finally {
      deleting = false;
    }
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  function formatTimestamp(timestamp) {
    if (!timestamp) return 'N/A';
    return new Date(timestamp).toLocaleString();
  }

  function truncateUrl(url) {
    if (!url) return 'N/A';
    if (url.length <= 60) return url;
    return url.substring(0, 30) + '...' + url.substring(url.length - 27);
  }

  onMount(() => {
    fetchUsers();
  });
</script>

<div class="moderation-container">
  <div class="header-section">
    <h2>r2 moderation</h2>
    <p class="subtitle">manage and delete r2 uploads by user</p>
  </div>

  <div class="user-selector-section">
    <div class="selector-header">
      <h3>select user</h3>
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

    {#if usersLoading}
      <div class="loading">loading users...</div>
    {:else if users.length > 0}
      <div class="users-list">
        {#each users as user}
          <button
            class="user-item"
            class:selected={selectedUserId === user.user_id}
            on:click={() => handleUserSelect(user.user_id)}
          >
            <span class="username">{user.username}</span>
            <span class="user-id">({user.user_id})</span>
          </button>
        {/each}
      </div>
      {#if usersTotal > usersLimit}
        <div class="users-pagination">
          <div class="pagination-info">
            showing {usersOffset + 1}-{Math.min(usersOffset + usersLimit, usersTotal)} of {usersTotal}
          </div>
          <div class="pagination-controls">
            <button on:click={handleUsersPrevPage} disabled={usersOffset === 0}>
              previous
            </button>
            <button on:click={handleUsersNextPage} disabled={usersOffset + usersLimit >= usersTotal}>
              next
            </button>
          </div>
        </div>
      {/if}
    {:else}
      <div class="empty">no users found</div>
    {/if}
  </div>

  {#if selectedUserId}
    <div class="media-section">
      <div class="media-header">
        <div class="header-info">
          <h3>
            r2 files for {selectedUser?.username || selectedUserId}
            {#if total > 0}
              <span class="count">({total})</span>
            {/if}
          </h3>
        </div>
        <div class="header-actions">
          <select bind:value={fileTypeFilter} on:change={handleFileTypeFilter}>
            <option value="">all types</option>
            <option value="gif">gif</option>
            <option value="video">video</option>
            <option value="image">image</option>
          </select>
          <button
            class="delete-all-btn"
            on:click={deleteAllForUser}
            disabled={deleting || total === 0}
          >
            delete all for user
          </button>
        </div>
      </div>

      {#if loading}
        <div class="loading">loading r2 files...</div>
      {:else if error}
        <div class="error">error: {error}</div>
        <button class="retry-btn" on:click={fetchR2Media}>retry</button>
      {:else if media.length === 0}
        <div class="empty">no r2 files found for this user</div>
      {:else}
        <div class="bulk-actions">
          <label class="select-all-label">
            <input
              type="checkbox"
              checked={selectedFiles.size === media.length && media.length > 0}
              on:change={toggleSelectAll}
            />
            <span>select all ({selectedFiles.size} selected)</span>
          </label>
          {#if selectedFiles.size > 0}
            <button
              class="bulk-delete-btn"
              on:click={bulkDelete}
              disabled={deleting}
            >
              delete selected ({selectedFiles.size})
            </button>
          {/if}
        </div>

        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th class="checkbox-col"></th>
                <th>file url</th>
                <th>file type</th>
                <th>date</th>
                <th>size</th>
                <th class="actions-col">actions</th>
              </tr>
            </thead>
            <tbody>
              {#each media as item}
                <tr>
                  <td class="checkbox-cell">
                    <input
                      type="checkbox"
                      checked={selectedFiles.has(item.url_hash)}
                      on:change={() => toggleFileSelection(item.url_hash)}
                    />
                  </td>
                  <td class="url-cell">
                    <a href={item.file_url} target="_blank" rel="noopener noreferrer" title={item.file_url}>
                      {truncateUrl(item.file_url)}
                    </a>
                  </td>
                  <td class="type-cell">{item.file_type || 'N/A'}</td>
                  <td class="date-cell">{formatTimestamp(item.processed_at)}</td>
                  <td class="size-cell">{item.file_size ? formatBytes(item.file_size) : 'N/A'}</td>
                  <td class="actions-cell">
                    <button
                      class="delete-btn"
                      on:click={() => deleteFile(item.url_hash)}
                      disabled={deleting}
                    >
                      delete
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
            <select
              bind:value={limit}
              on:change={() => {
                offset = 0;
                selectedFiles.clear();
                fetchR2Media();
              }}
              disabled={deleting}
              class="page-size-select"
            >
              <option value="10">10 per page</option>
              <option value="25">25 per page</option>
              <option value="50">50 per page</option>
              <option value="100">100 per page</option>
            </select>
            <button on:click={handlePrevPage} disabled={offset === 0 || deleting}>
              previous
            </button>
            <button on:click={handleNextPage} disabled={offset + limit >= total || deleting}>
              next
            </button>
          </div>
        </div>
      {/if}
    </div>
  {:else}
    <div class="empty-state">
      <p>select a user above to view their r2 uploads</p>
    </div>
  {/if}
</div>

<style>
  .moderation-container {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .header-section {
    margin-bottom: 1rem;
  }

  .header-section h2 {
    margin: 0 0 0.5rem 0;
    font-size: 1.5rem;
    font-weight: 600;
    color: #fff;
  }

  .subtitle {
    margin: 0;
    color: #aaa;
    font-size: 0.9rem;
  }

  .user-selector-section {
    background-color: #222;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 1.5rem;
  }

  .selector-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .selector-header h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 500;
    color: #fff;
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

  .users-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .user-item {
    padding: 0.5rem 1rem;
    background-color: #2a2a2a;
    border: 1px solid #444;
    color: #e0e0e0;
    cursor: pointer;
    border-radius: 3px;
    font-size: 0.9rem;
    transition: all 0.2s;
  }

  .user-item:hover {
    background-color: #333;
    border-color: #555;
  }

  .user-item.selected {
    background-color: #51cf66;
    border-color: #51cf66;
    color: #000;
  }

  .user-item .username {
    font-weight: 500;
  }

  .user-item .user-id {
    font-size: 0.85rem;
    opacity: 0.7;
    margin-left: 0.5rem;
  }

  .users-pagination {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 1rem;
    padding: 0.75rem 0;
    border-top: 1px solid #333;
  }

  .users-pagination .pagination-info {
    font-size: 0.85rem;
    color: #aaa;
  }

  .users-pagination .pagination-controls {
    display: flex;
    gap: 0.5rem;
  }

  .users-pagination .pagination-controls button {
    padding: 0.4rem 0.8rem;
    font-size: 0.85rem;
    background-color: #444;
    color: #fff;
    border: 1px solid #555;
    cursor: pointer;
    border-radius: 3px;
  }

  .users-pagination .pagination-controls button:hover:not(:disabled) {
    background-color: #555;
  }

  .users-pagination .pagination-controls button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .media-section {
    background-color: #222;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 1.5rem;
  }

  .media-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .header-info h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 500;
    color: #fff;
  }

  .count {
    color: #aaa;
    font-weight: normal;
  }

  .header-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .header-actions select {
    padding: 0.5rem 0.75rem;
    background-color: #2a2a2a;
    border: 1px solid #444;
    color: #fff;
    font-size: 0.9rem;
    border-radius: 3px;
    cursor: pointer;
  }

  .delete-all-btn {
    padding: 0.5rem 1rem;
    background-color: #ff6b6b;
    color: #fff;
    border: 1px solid #ff5252;
    cursor: pointer;
    font-size: 0.9rem;
    border-radius: 3px;
  }

  .delete-all-btn:hover:not(:disabled) {
    background-color: #ff5252;
  }

  .delete-all-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .bulk-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    padding: 0.75rem;
    background-color: #2a2a2a;
    border-radius: 3px;
  }

  .select-all-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #e0e0e0;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .select-all-label input[type="checkbox"] {
    cursor: pointer;
  }

  .bulk-delete-btn {
    padding: 0.4rem 0.8rem;
    background-color: #ff6b6b;
    color: #fff;
    border: 1px solid #ff5252;
    cursor: pointer;
    font-size: 0.85rem;
    border-radius: 3px;
  }

  .bulk-delete-btn:hover:not(:disabled) {
    background-color: #ff5252;
  }

  .bulk-delete-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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

  .checkbox-col {
    width: 40px;
    text-align: center;
  }

  .actions-col {
    width: 100px;
    text-align: center;
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

  .checkbox-cell {
    text-align: center;
  }

  .checkbox-cell input[type="checkbox"] {
    cursor: pointer;
  }

  .url-cell {
    max-width: 400px;
  }

  .url-cell a {
    color: #51cf66;
    text-decoration: none;
  }

  .url-cell a:hover {
    text-decoration: underline;
  }

  .type-cell {
    text-transform: capitalize;
  }

  .date-cell {
    font-size: 0.85rem;
    color: #aaa;
  }

  .size-cell {
    font-family: monospace;
    text-align: right;
  }

  .actions-cell {
    text-align: center;
  }

  .delete-btn {
    padding: 0.4rem 0.8rem;
    background-color: #ff6b6b;
    color: #fff;
    border: 1px solid #ff5252;
    cursor: pointer;
    font-size: 0.85rem;
    border-radius: 3px;
  }

  .delete-btn:hover:not(:disabled) {
    background-color: #ff5252;
  }

  .delete-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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

  .page-size-select {
    padding: 0.4rem 0.6rem;
    font-size: 0.85rem;
    background-color: #2a2a2a;
    border: 1px solid #444;
    color: #fff;
    border-radius: 3px;
    cursor: pointer;
    margin-right: 0.5rem;
  }

  .page-size-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .loading,
  .error,
  .empty,
  .empty-state {
    padding: 2rem;
    text-align: center;
  }

  .loading {
    color: #888;
  }

  .error {
    color: #ff6b6b;
  }

  .empty,
  .empty-state {
    color: #888;
  }

  .empty-state p {
    margin: 0;
  }

  .retry-btn {
    margin-top: 1rem;
    padding: 0.5rem 1rem;
    background-color: #444;
    color: #fff;
    border: 1px solid #555;
    cursor: pointer;
    border-radius: 3px;
  }

  .retry-btn:hover {
    background-color: #555;
  }

  @media (max-width: 768px) {
    .media-header {
      flex-direction: column;
      align-items: flex-start;
    }

    .header-actions {
      width: 100%;
      flex-direction: column;
    }

    .header-actions select,
    .delete-all-btn {
      width: 100%;
    }

    .bulk-actions {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.5rem;
    }

    .bulk-delete-btn {
      width: 100%;
    }

    table {
      font-size: 0.8rem;
    }

    th,
    td {
      padding: 0.5rem 0.5rem;
    }
  }
</style>

