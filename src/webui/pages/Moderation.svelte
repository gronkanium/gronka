<script>
  import { onMount } from 'svelte';
  import { formatTimestamp, formatRelativeTime, formatBytes } from '../utils/format.js';
  import Pagination from '../components/Pagination.svelte';

  let activeTab = 'files';

  // --- Bans tab state ---
  let moderationEnabled = false;
  let moderationEnabledLoading = false;
  let bans = [];
  let bansLoading = false;
  let bansError = null;

  let banModalOpen = false;
  let banSubmitting = false;
  let banForm = { userId: '', username: '', reason: '', appealAllowed: true };
  let banUserSearch = '';
  let banUserResults = [];
  let banUserSearchTimeout = null;

  async function fetchModerationEnabled() {
    try {
      const response = await fetch('/api/settings');
      if (!response.ok) throw new Error('failed to fetch settings');
      const data = await response.json();
      moderationEnabled = data.settings?.moderation_enabled?.value === 'true';
    } catch (err) {
      showStatus('error', `failed to load moderation toggle: ${err.message}`);
    }
  }

  async function toggleModerationEnabled() {
    const next = !moderationEnabled;
    moderationEnabledLoading = true;
    try {
      const response = await fetch('/api/settings/moderation_enabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: next }),
      });
      if (!response.ok) throw new Error('failed to update setting');
      moderationEnabled = next;
      showStatus('success', `ban enforcement ${next ? 'enabled' : 'disabled'}`);
    } catch (err) {
      showStatus('error', `failed to toggle moderation: ${err.message}`);
    } finally {
      moderationEnabledLoading = false;
    }
  }

  async function fetchBans() {
    bansLoading = true;
    bansError = null;
    try {
      const response = await fetch('/api/bans');
      if (!response.ok) throw new Error('failed to fetch bans');
      const data = await response.json();
      bans = data.bans || [];
    } catch (err) {
      bansError = err.message;
    } finally {
      bansLoading = false;
    }
  }

  function openBanModal() {
    banForm = { userId: '', username: '', reason: '', appealAllowed: true };
    banUserSearch = '';
    banUserResults = [];
    banModalOpen = true;
  }

  function closeBanModal() {
    banModalOpen = false;
  }

  function handleBanUserSearchInput() {
    clearTimeout(banUserSearchTimeout);
    if (!banUserSearch.trim()) {
      banUserResults = [];
      return;
    }
    banUserSearchTimeout = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/users?search=${encodeURIComponent(banUserSearch.trim())}&limit=8`
        );
        if (!response.ok) return;
        const data = await response.json();
        banUserResults = data.users || [];
      } catch {
        banUserResults = [];
      }
    }, 250);
  }

  function pickBanUser(user) {
    banForm.userId = user.user_id;
    banForm.username = user.username || '';
    banUserSearch = '';
    banUserResults = [];
  }

  async function submitBan() {
    if (!banForm.userId.trim() || !banForm.reason.trim()) {
      showStatus('error', 'user id and reason are required');
      return;
    }

    banSubmitting = true;
    try {
      const response = await fetch('/api/bans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: banForm.userId.trim(),
          reason: banForm.reason.trim(),
          appealAllowed: banForm.appealAllowed,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'failed to ban user');
      }

      showStatus('success', `banned ${banForm.username || banForm.userId}`);
      banModalOpen = false;
      await fetchBans();
    } catch (err) {
      showStatus('error', `failed to ban user: ${err.message}`);
    } finally {
      banSubmitting = false;
    }
  }

  async function unbanUserRow(userId) {
    try {
      const response = await fetch(`/api/bans/${userId}`, { method: 'DELETE' });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'failed to unban user');
      }
      showStatus('success', 'user unbanned');
      await fetchBans();
    } catch (err) {
      showStatus('error', `failed to unban user: ${err.message}`);
    }
  }

  function switchTab(tab) {
    activeTab = tab;
    if (tab === 'bans' && bans.length === 0 && !bansLoading) {
      fetchModerationEnabled();
      fetchBans();
    }
  }

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
    <p class="subtitle">manage r2 uploads and user bans</p>
  </div>

  <div class="tabs">
    <button class:active={activeTab === 'files'} on:click={() => switchTab('files')}>
      files
    </button>
    <button class:active={activeTab === 'bans'} on:click={() => switchTab('bans')}> bans </button>
  </div>

  {#if status}
    <div class="status-line {status.kind}">{status.text}</div>
  {/if}

  {#if activeTab === 'bans'}
    <div class="bans-section">
      <div class="bans-toggle-row">
        <label class="toggle-label">
          <input
            type="checkbox"
            checked={moderationEnabled}
            disabled={moderationEnabledLoading}
            on:change={toggleModerationEnabled}
          />
          <span>ban enforcement {moderationEnabled ? 'enabled' : 'disabled'}</span>
        </label>
        <button class="ban-user-btn" on:click={openBanModal}>ban user</button>
      </div>

      {#if bansLoading}
        <div class="loading">loading bans...</div>
      {:else if bansError}
        <div class="state-error">error: {bansError}</div>
        <button class="retry-btn" on:click={fetchBans}>retry</button>
      {:else if bans.length === 0}
        <div class="empty">no banned users</div>
      {:else}
        <div class="bans-list">
          {#each bans as ban (ban.user_id)}
            <div class="ban-row">
              <div class="ban-info">
                <span class="ban-user" title={ban.user_id}>{ban.user_id}</span>
                <span class="ban-reason">{ban.reason}</span>
                <span class="ban-meta">
                  banned {formatRelativeTime(ban.banned_at)} · appeal {ban.appeal_allowed
                    ? 'allowed'
                    : 'not allowed'}
                </span>
              </div>
              <button class="unban-btn" on:click={() => unbanUserRow(ban.user_id)}>unban</button>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    {#if banModalOpen}
      <div
        class="modal-overlay"
        role="button"
        tabindex="0"
        on:click={closeBanModal}
        on:keydown={e => e.key === 'Escape' && closeBanModal()}
      >
        <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
        <div class="modal" role="dialog" aria-modal="true" on:click|stopPropagation>
          <h3>ban user</h3>

          <label class="field">
            <span>user</span>
            {#if banForm.userId}
              <div class="picked-user">
                <span>{banForm.username || banForm.userId} ({banForm.userId})</span>
                <button
                  type="button"
                  on:click={() => (banForm = { ...banForm, userId: '', username: '' })}
                >
                  change
                </button>
              </div>
            {:else}
              <input
                type="text"
                bind:value={banUserSearch}
                on:input={handleBanUserSearchInput}
                placeholder="search by username or user id..."
              />
              {#if banUserResults.length > 0}
                <div class="search-results">
                  {#each banUserResults as user (user.user_id)}
                    <button type="button" class="search-result" on:click={() => pickBanUser(user)}>
                      {user.username} <span class="dim">({user.user_id})</span>
                    </button>
                  {/each}
                </div>
              {/if}
            {/if}
          </label>

          <label class="field">
            <span>reason</span>
            <textarea bind:value={banForm.reason} rows="3" placeholder="ban reason..."></textarea>
          </label>

          <label class="field checkbox-field">
            <input type="checkbox" bind:checked={banForm.appealAllowed} />
            <span>allow appeal (shows appeal invite in the ban message)</span>
          </label>

          <div class="modal-actions">
            <button class="cancel-btn" on:click={closeBanModal}>cancel</button>
            <button class="confirm-ban-btn" on:click={submitBan} disabled={banSubmitting}>
              {banSubmitting ? 'banning...' : 'ban user'}
            </button>
          </div>
        </div>
      </div>
    {/if}
  {:else}
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
                    <video src={item.file_url} preload="metadata" controls muted playsinline
                    ></video>
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
                  <span class="media-size"
                    >{item.file_size ? formatBytes(item.file_size) : '—'}</span
                  >
                  <span class="media-date" title={formatTimestamp(item.processed_at)}>
                    {formatRelativeTime(item.processed_at)}
                  </span>
                </div>
                <div class="media-actions">
                  <a
                    class="open-link"
                    href={item.file_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
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

  .tabs {
    display: flex;
    gap: 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  .tabs button {
    padding: 0.6rem 1rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.9rem;
  }

  .tabs button:hover {
    color: var(--text-bright);
  }

  .tabs button.active {
    color: var(--text-bright);
    border-bottom-color: var(--success);
  }

  .bans-section {
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1.5rem;
  }

  .bans-toggle-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--text);
    cursor: pointer;
    font-size: 0.9rem;
  }

  .ban-user-btn {
    padding: 0.5rem 1rem;
    background-color: var(--danger);
    color: var(--text-bright);
    border: 1px solid var(--danger);
    cursor: pointer;
    font-size: 0.9rem;
    border-radius: var(--radius);
  }

  .bans-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .ban-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1rem;
    background-color: var(--surface-2);
    border: 1px solid var(--surface-3);
    border-radius: var(--radius);
  }

  .ban-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }

  .ban-user {
    font-family: monospace;
    font-size: 0.8rem;
    color: var(--text-dim);
  }

  .ban-reason {
    color: var(--text-bright);
    font-size: 0.9rem;
  }

  .ban-meta {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .unban-btn {
    flex-shrink: 0;
    padding: 0.4rem 0.8rem;
    background-color: var(--surface-3);
    color: var(--text-bright);
    border: 1px solid var(--border-2);
    cursor: pointer;
    font-size: 0.85rem;
    border-radius: var(--radius);
  }

  .unban-btn:hover {
    background-color: var(--border-2);
  }

  .modal-overlay {
    position: fixed;
    inset: 0;
    background-color: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1500;
    padding: 1rem;
  }

  .modal {
    background-color: var(--surface);
    border: 1px solid var(--border-2);
    border-radius: var(--radius-lg);
    padding: 1.5rem;
    width: 100%;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .modal h3 {
    margin: 0;
    color: var(--text-bright);
    font-size: 1.1rem;
    font-weight: 500;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: var(--text-muted);
    position: relative;
  }

  .field input[type='text'],
  .field textarea {
    padding: 0.5rem 0.75rem;
    background-color: var(--surface-2);
    border: 1px solid var(--surface-3);
    color: var(--text-bright);
    font-size: 0.9rem;
    border-radius: var(--radius);
    font-family: inherit;
    resize: vertical;
  }

  .field.checkbox-field {
    flex-direction: row;
    align-items: center;
  }

  .picked-user {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background-color: var(--surface-2);
    border: 1px solid var(--surface-3);
    border-radius: var(--radius);
    color: var(--text-bright);
    font-size: 0.85rem;
  }

  .picked-user button {
    background: none;
    border: 1px solid var(--border-2);
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.2rem 0.5rem;
    border-radius: var(--radius);
    font-size: 0.75rem;
  }

  .search-results {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background-color: var(--surface-2);
    border: 1px solid var(--surface-3);
    border-radius: var(--radius);
    max-height: 200px;
    overflow-y: auto;
    z-index: 10;
  }

  .search-result {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.5rem 0.75rem;
    background: none;
    border: none;
    color: var(--text-bright);
    cursor: pointer;
    font-size: 0.85rem;
  }

  .search-result:hover {
    background-color: var(--surface-3);
  }

  .search-result .dim {
    color: var(--text-dim);
    font-size: 0.75rem;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .cancel-btn {
    padding: 0.5rem 1rem;
    background-color: var(--surface-3);
    color: var(--text-bright);
    border: 1px solid var(--border-2);
    cursor: pointer;
    border-radius: var(--radius);
  }

  .confirm-ban-btn {
    padding: 0.5rem 1rem;
    background-color: var(--danger);
    color: var(--text-bright);
    border: 1px solid var(--danger);
    cursor: pointer;
    border-radius: var(--radius);
  }

  .confirm-ban-btn:disabled,
  .ban-user-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (max-width: 768px) {
    .bans-toggle-row {
      flex-direction: column;
      align-items: stretch;
    }

    .ban-row {
      flex-direction: column;
      align-items: flex-start;
    }

    .unban-btn {
      width: 100%;
    }
  }
</style>
