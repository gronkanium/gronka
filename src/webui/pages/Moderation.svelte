<script>
  import { onMount } from 'svelte';
  import { formatTimestamp, formatRelativeTime, formatBytes } from '../utils/format.js';
  import Pagination from '../components/Pagination.svelte';

  let r2Users = [];
  let usersLoading = false;
  let usersError = null;
  let userSearch = '';

  let selectedUserId = null;
  let selectedUser = null;

  let media = [];
  let total = 0;
  let loading = false;
  let error = null;
  let deleting = false;

  let fileTypeFilter = '';
  let limit = 25;
  let offset = 0;
  let selectedFiles = new Set();

  // Transient status line ({ kind: 'success' | 'error', text })
  let status = null;
  let statusTimeout = null;

  function showStatus(kind, text) {
    status = { kind, text };
    clearTimeout(statusTimeout);
    statusTimeout = setTimeout(() => {
      status = null;
    }, 6000);
  }

  async function fetchR2Users() {
    usersLoading = true;
    usersError = null;
    try {
      const response = await fetch('/api/moderation/r2-users');
      if (!response.ok) throw new Error('failed to fetch r2 users');
      const data = await response.json();
      r2Users = data.users || [];
    } catch (err) {
      usersError = err.message;
    } finally {
      usersLoading = false;
    }
  }

  $: filteredUsers = userSearch
    ? r2Users.filter(
        u =>
          u.username.toLowerCase().includes(userSearch.toLowerCase()) ||
          u.user_id.includes(userSearch)
      )
    : r2Users;

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

  function resetSelectionState() {
    selectedFiles = new Set();
  }

  function handleUserSelect(userId) {
    if (selectedUserId === userId) {
      selectedUserId = null;
      selectedUser = null;
      media = [];
      total = 0;
      resetSelectionState();
    } else {
      selectedUserId = userId;
      selectedUser = r2Users.find(u => u.user_id === userId) || null;
      offset = 0;
      resetSelectionState();
      fetchR2Media();
    }
  }

  function handleFileTypeFilter() {
    offset = 0;
    resetSelectionState();
    fetchR2Media();
  }

  function handlePage(event) {
    offset = event.detail.offset;
    limit = event.detail.limit;
    selectedFiles = new Set();
    fetchR2Media();
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
      selectedFiles = new Set();
    } else {
      selectedFiles = new Set(media.map(m => m.url_hash));
    }
  }

  // Refresh both the media list and the per-user stats after any deletion
  async function refreshAfterDelete() {
    await Promise.all([fetchR2Media(), fetchR2Users()]);
    selectedUser = r2Users.find(u => u.user_id === selectedUserId) || selectedUser;
  }

  async function deleteFile(urlHash) {
    deleting = true;
    try {
      const response = await fetch(`/api/moderation/files/${urlHash}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'failed to delete file');
      }

      showStatus('success', 'file deleted');
      selectedFiles.delete(urlHash);
      selectedFiles = new Set(selectedFiles);
      await refreshAfterDelete();
    } catch (err) {
      showStatus('error', `failed to delete file: ${err.message}`);
    } finally {
      deleting = false;
    }
  }

  async function bulkDelete() {
    if (selectedFiles.size === 0) return;

    deleting = true;
    try {
      const response = await fetch('/api/moderation/files/bulk', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          urlHashes: Array.from(selectedFiles),
        }),
      });

      if (!response.ok) {
        let errorMessage = 'failed to delete files';
        try {
          const data = await response.json();
          errorMessage = data.message || data.error || errorMessage;
        } catch {
          errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();
      const { results } = data;

      if (results && results.failed && results.failed.length > 0) {
        showStatus(
          'error',
          `deleted ${results.success.length} file(s), but ${results.failed.length} failed`
        );
      } else if (results && results.success) {
        showStatus('success', `deleted ${results.success.length} file(s)`);
      }

      selectedFiles = new Set();
      await refreshAfterDelete();
    } catch (err) {
      showStatus('error', `failed to delete files: ${err.message}`);
    } finally {
      deleting = false;
    }
  }

  async function deleteAllForUser() {
    if (!selectedUserId) return;

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
      showStatus('success', `deleted ${data.deleted} file(s) for user`);

      selectedFiles = new Set();
      await refreshAfterDelete();
    } catch (err) {
      showStatus('error', `failed to delete user files: ${err.message}`);
    } finally {
      deleting = false;
    }
  }

  onMount(() => {
    fetchR2Users();
    return () => clearTimeout(statusTimeout);
  });
</script>

<div class="moderation-container">
  <div class="header-section">
    <p class="subtitle">manage and delete r2 uploads by user</p>
  </div>

  {#if status}
    <div class="status-line {status.kind}">{status.text}</div>
  {/if}

  <div class="user-selector-section">
    <div class="selector-header">
      <h3>select user</h3>
      <div class="search-box">
        <input type="text" bind:value={userSearch} placeholder="filter users..." />
      </div>
    </div>

    {#if usersLoading}
      <div class="loading">loading users...</div>
    {:else if usersError}
      <div class="state-error">error: {usersError}</div>
      <button class="retry-btn" on:click={fetchR2Users}>retry</button>
    {:else if filteredUsers.length > 0}
      <div class="users-list">
        {#each filteredUsers as user (user.user_id)}
          <button
            class="user-item"
            class:selected={selectedUserId === user.user_id}
            on:click={() => handleUserSelect(user.user_id)}
            title={user.user_id}
          >
            <span class="username">{user.username}</span>
            <span class="user-stats">
              {user.file_count} file{user.file_count === 1 ? '' : 's'} · {formatBytes(
                user.total_size
              )}
            </span>
          </button>
        {/each}
      </div>
    {:else if r2Users.length > 0}
      <div class="empty">no users match "{userSearch}"</div>
    {:else}
      <div class="empty">no users with r2 uploads</div>
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
        <div class="state-error">error: {error}</div>
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
            <span>select page ({selectedFiles.size} selected)</span>
          </label>
          {#if selectedFiles.size > 0}
            <button class="bulk-delete-btn" on:click={bulkDelete} disabled={deleting}>
              delete selected ({selectedFiles.size})
            </button>
          {/if}
        </div>

        <div class="media-grid">
          {#each media as item (item.url_hash)}
            <div class="media-card" class:checked={selectedFiles.has(item.url_hash)}>
              <div class="media-preview">
                {#if item.file_type === 'video'}
                  <!-- svelte-ignore a11y-media-has-caption -->
                  <video src={item.file_url} preload="metadata" controls muted playsinline></video>
                {:else}
                  <a href={item.file_url} target="_blank" rel="noopener noreferrer">
                    <img src={item.file_url} alt={item.file_type || 'media'} loading="lazy" />
                  </a>
                {/if}
                <label class="card-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedFiles.has(item.url_hash)}
                    on:change={() => toggleFileSelection(item.url_hash)}
                  />
                </label>
              </div>
              <div class="media-info">
                <span class="media-type">{item.file_type || 'unknown'}</span>
                <span class="media-size">{item.file_size ? formatBytes(item.file_size) : '—'}</span>
                <span class="media-date" title={formatTimestamp(item.processed_at)}>
                  {formatRelativeTime(item.processed_at)}
                </span>
              </div>
              <div class="media-actions">
                <a class="open-link" href={item.file_url} target="_blank" rel="noopener noreferrer">
                  open
                </a>
                <button
                  class="delete-btn"
                  on:click={() => deleteFile(item.url_hash)}
                  disabled={deleting}
                >
                  delete
                </button>
              </div>
            </div>
          {/each}
        </div>

        <Pagination
          {offset}
          {limit}
          {total}
          disabled={deleting}
          pageSizes={[10, 25, 50, 100]}
          on:page={handlePage}
        />
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
    gap: 1.5rem;
  }

  .header-section {
    margin: 0;
  }

  .subtitle {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  .status-line {
    padding: 0.6rem 1rem;
    border-radius: var(--radius);
    font-size: 0.9rem;
    border: 1px solid var(--border);
  }

  .status-line.success {
    background-color: rgba(81, 207, 102, 0.1);
    border-color: var(--success);
    color: var(--success);
  }

  .status-line.error {
    background-color: rgba(255, 107, 107, 0.1);
    border-color: var(--danger);
    color: var(--danger);
  }

  .user-selector-section {
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
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
    color: var(--text-bright);
  }

  .search-box input {
    padding: 0.5rem 0.75rem;
    background-color: var(--surface-2);
    border: 1px solid var(--surface-3);
    color: var(--text-bright);
    font-size: 0.9rem;
    border-radius: var(--radius);
    min-width: 250px;
  }

  .users-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    max-height: 260px;
    overflow-y: auto;
  }

  .user-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    padding: 0.5rem 1rem;
    background-color: var(--surface-2);
    border: 1px solid var(--surface-3);
    color: var(--text);
    cursor: pointer;
    border-radius: var(--radius);
    font-size: 0.9rem;
    transition: all 0.2s;
  }

  .user-item:hover {
    background-color: var(--border);
    border-color: var(--border-2);
  }

  .user-item.selected {
    background-color: var(--success);
    border-color: var(--success);
    color: #000;
  }

  .user-item .username {
    font-weight: 500;
  }

  .user-item .user-stats {
    font-size: 0.75rem;
    opacity: 0.7;
  }

  .media-section {
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
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
    color: var(--text-bright);
  }

  .count {
    color: var(--text-muted);
    font-weight: normal;
  }

  .header-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .header-actions select {
    padding: 0.5rem 0.75rem;
    background-color: var(--surface-2);
    border: 1px solid var(--surface-3);
    color: var(--text-bright);
    font-size: 0.9rem;
    border-radius: var(--radius);
    cursor: pointer;
  }

  .delete-all-btn {
    padding: 0.5rem 1rem;
    background-color: var(--danger);
    color: var(--text-bright);
    border: 1px solid var(--danger);
    cursor: pointer;
    font-size: 0.9rem;
    border-radius: var(--radius);
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
    background-color: var(--surface-2);
    border-radius: var(--radius);
  }

  .select-all-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--text);
    cursor: pointer;
    font-size: 0.9rem;
  }

  .select-all-label input[type='checkbox'] {
    cursor: pointer;
  }

  .bulk-delete-btn {
    padding: 0.4rem 0.8rem;
    background-color: var(--danger);
    color: var(--text-bright);
    border: 1px solid var(--danger);
    cursor: pointer;
    font-size: 0.85rem;
    border-radius: var(--radius);
  }

  .bulk-delete-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .media-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .media-card {
    display: flex;
    flex-direction: column;
    background-color: var(--surface-2);
    border: 1px solid var(--surface-3);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .media-card.checked {
    border-color: var(--success);
  }

  .media-preview {
    position: relative;
    aspect-ratio: 1 / 1;
    background-color: var(--bg-deep);
  }

  .media-preview img,
  .media-preview video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }

  .card-checkbox {
    position: absolute;
    top: 0.4rem;
    left: 0.4rem;
    background-color: rgba(0, 0, 0, 0.6);
    border-radius: var(--radius);
    padding: 0.25rem;
    display: flex;
    cursor: pointer;
  }

  .card-checkbox input[type='checkbox'] {
    cursor: pointer;
    margin: 0;
  }

  .media-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.6rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .media-type {
    text-transform: capitalize;
  }

  .media-size {
    font-family: monospace;
  }

  .media-date {
    color: var(--text-dim);
  }

  .media-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.4rem 0.6rem;
    border-top: 1px solid var(--surface-3);
  }

  .open-link {
    font-size: 0.8rem;
    color: var(--success);
    text-decoration: none;
  }

  .open-link:hover {
    text-decoration: underline;
  }

  .delete-btn {
    padding: 0.3rem 0.7rem;
    background-color: var(--danger);
    color: var(--text-bright);
    border: 1px solid var(--danger);
    cursor: pointer;
    font-size: 0.8rem;
    border-radius: var(--radius);
  }

  .delete-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .loading,
  .state-error,
  .empty,
  .empty-state {
    padding: 2rem;
    text-align: center;
  }

  .loading {
    color: var(--text-dim);
  }

  .state-error {
    color: var(--danger);
  }

  .empty,
  .empty-state {
    color: var(--text-dim);
  }

  .empty-state p {
    margin: 0;
  }

  .retry-btn {
    margin-top: 1rem;
    padding: 0.5rem 1rem;
    background-color: var(--surface-3);
    color: var(--text-bright);
    border: 1px solid var(--border-2);
    cursor: pointer;
    border-radius: var(--radius);
  }

  .retry-btn:hover {
    background-color: var(--border-2);
  }

  @media (max-width: 768px) {
    button {
      min-height: 44px;
    }

    .selector-header {
      flex-direction: column;
      align-items: stretch;
      gap: 0.75rem;
    }

    .search-box input {
      width: 100%;
      min-width: 0;
    }

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

    .media-grid {
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    }
  }
</style>
