<script>
  import { onMount } from 'svelte';
  import KPICard from '../components/KPICard.svelte';

  // Stats state
  let stats = null;
  let statsLoading = true;

  // Tab state
  let activeTab = 'recent'; // 'recent' | 'users'

  // Recent uploads state
  let recentUploads = [];
  let recentTotal = 0;
  let recentLoading = false;
  let recentError = null;
  let recentLimit = 25;
  let recentOffset = 0;
  let recentFileType = '';
  let recentViewMode = 'table'; // 'table' | 'grid'
  let recentSelectedFiles = new Set();

  // Users state
  let users = [];
  let usersTotal = 0;
  let usersLoading = false;
  let usersLimit = 50;
  let usersOffset = 0;
  let usersSearch = '';
  let usersSortBy = 'upload_count';

  // Selected user state (for viewing files)
  let selectedUserId = null;
  let selectedUser = null;
  let userMedia = [];
  let userMediaTotal = 0;
  let userMediaLoading = false;
  let userMediaLimit = 25;
  let userMediaOffset = 0;
  let userMediaFileType = '';
  let userSelectedFiles = new Set();

  // Global state
  let deleting = false;

  async function fetchStats() {
    statsLoading = true;
    try {
      const response = await fetch('/api/moderation/stats');
      if (!response.ok) throw new Error('failed to fetch stats');
      stats = await response.json();
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    } finally {
      statsLoading = false;
    }
  }

  async function fetchRecentUploads() {
    recentLoading = true;
    recentError = null;
    try {
      const params = new URLSearchParams({
        limit: recentLimit.toString(),
        offset: recentOffset.toString(),
      });
      if (recentFileType) params.append('fileType', recentFileType);

      const response = await fetch(`/api/moderation/recent-uploads?${params}`);
      if (!response.ok) throw new Error('failed to fetch recent uploads');

      const data = await response.json();
      recentUploads = data.uploads || [];
      recentTotal = data.total || 0;
    } catch (err) {
      recentError = err.message;
    } finally {
      recentLoading = false;
    }
  }

  async function fetchUsersWithUploads() {
    usersLoading = true;
    try {
      const params = new URLSearchParams({
        limit: usersLimit.toString(),
        offset: usersOffset.toString(),
        sortBy: usersSortBy,
        sortDesc: 'true',
      });
      if (usersSearch) params.append('search', usersSearch);

      const response = await fetch(`/api/moderation/users-with-uploads?${params}`);
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

  async function fetchUserMedia() {
    if (!selectedUserId) {
      userMedia = [];
      userMediaTotal = 0;
      return;
    }

    userMediaLoading = true;
    try {
      const params = new URLSearchParams({
        limit: userMediaLimit.toString(),
        offset: userMediaOffset.toString(),
      });
      if (userMediaFileType) params.append('fileType', userMediaFileType);

      const response = await fetch(`/api/moderation/users/${selectedUserId}/r2-media?${params}`);
      if (!response.ok) throw new Error('failed to fetch user media');

      const data = await response.json();
      userMedia = data.media || [];
      userMediaTotal = data.total || 0;
    } catch (err) {
      console.error('Failed to fetch user media:', err);
    } finally {
      userMediaLoading = false;
    }
  }

  function handleTabChange(tab) {
    activeTab = tab;
    if (tab === 'recent') {
      recentOffset = 0;
      recentSelectedFiles.clear();
      fetchRecentUploads();
    } else if (tab === 'users') {
      usersOffset = 0;
      selectedUserId = null;
      selectedUser = null;
      fetchUsersWithUploads();
    }
  }

  function handleRecentFileTypeChange() {
    recentOffset = 0;
    recentSelectedFiles.clear();
    fetchRecentUploads();
  }

  function handleRecentPrevPage() {
    if (recentOffset > 0) {
      recentOffset = Math.max(0, recentOffset - recentLimit);
      recentSelectedFiles.clear();
      fetchRecentUploads();
    }
  }

  function handleRecentNextPage() {
    if (recentOffset + recentLimit < recentTotal) {
      recentOffset += recentLimit;
      recentSelectedFiles.clear();
      fetchRecentUploads();
    }
  }

  function handleUsersSearch() {
    usersOffset = 0;
    fetchUsersWithUploads();
  }

  function handleUsersSortChange() {
    usersOffset = 0;
    fetchUsersWithUploads();
  }

  function handleUsersPrevPage() {
    if (usersOffset > 0) {
      usersOffset = Math.max(0, usersOffset - usersLimit);
      fetchUsersWithUploads();
    }
  }

  function handleUsersNextPage() {
    if (usersOffset + usersLimit < usersTotal) {
      usersOffset += usersLimit;
      fetchUsersWithUploads();
    }
  }

  function handleUserSelect(user) {
    if (selectedUserId === user.user_id) {
      selectedUserId = null;
      selectedUser = null;
      userMedia = [];
      userMediaTotal = 0;
      userSelectedFiles.clear();
    } else {
      selectedUserId = user.user_id;
      selectedUser = user;
      userMediaOffset = 0;
      userSelectedFiles.clear();
      fetchUserMedia();
    }
  }

  function handleUserMediaFileTypeChange() {
    userMediaOffset = 0;
    userSelectedFiles.clear();
    fetchUserMedia();
  }

  function handleUserMediaPrevPage() {
    if (userMediaOffset > 0) {
      userMediaOffset = Math.max(0, userMediaOffset - userMediaLimit);
      userSelectedFiles.clear();
      fetchUserMedia();
    }
  }

  function handleUserMediaNextPage() {
    if (userMediaOffset + userMediaLimit < userMediaTotal) {
      userMediaOffset += userMediaLimit;
      userSelectedFiles.clear();
      fetchUserMedia();
    }
  }

  function toggleRecentFileSelection(urlHash) {
    if (recentSelectedFiles.has(urlHash)) {
      recentSelectedFiles.delete(urlHash);
    } else {
      recentSelectedFiles.add(urlHash);
    }
    recentSelectedFiles = new Set(recentSelectedFiles);
  }

  function toggleRecentSelectAll() {
    if (recentSelectedFiles.size === recentUploads.length) {
      recentSelectedFiles.clear();
    } else {
      recentSelectedFiles = new Set(recentUploads.map(m => m.url_hash));
    }
    recentSelectedFiles = new Set(recentSelectedFiles);
  }

  function toggleUserFileSelection(urlHash) {
    if (userSelectedFiles.has(urlHash)) {
      userSelectedFiles.delete(urlHash);
    } else {
      userSelectedFiles.add(urlHash);
    }
    userSelectedFiles = new Set(userSelectedFiles);
  }

  function toggleUserSelectAll() {
    if (userSelectedFiles.size === userMedia.length) {
      userSelectedFiles.clear();
    } else {
      userSelectedFiles = new Set(userMedia.map(m => m.url_hash));
    }
    userSelectedFiles = new Set(userSelectedFiles);
  }

  async function deleteFile(urlHash, source = 'recent') {
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

      // Refresh appropriate data
      await fetchStats();
      if (source === 'recent') {
        await fetchRecentUploads();
      } else {
        await fetchUserMedia();
        await fetchUsersWithUploads();
      }
    } catch (err) {
      alert(`Failed to delete file: ${err.message}`);
    } finally {
      deleting = false;
    }
  }

  async function bulkDelete(selectedFiles, source = 'recent') {
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

      const response = await fetch('/api/moderation/files/bulk', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          urlHashes: urlHashesArray,
        }),
      });

      if (!response.ok) {
        let errorMessage = 'failed to delete files';
        try {
          const data = await response.json();
          errorMessage = data.message || data.error || errorMessage;
        } catch (parseError) {
          errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();
      const { results } = data;

      if (results && results.failed && results.failed.length > 0) {
        alert(`Deleted ${results.success.length} file(s), but ${results.failed.length} failed.`);
      } else if (results && results.success) {
        alert(`Successfully deleted ${results.success.length} file(s).`);
      }

      // Refresh appropriate data
      await fetchStats();
      if (source === 'recent') {
        recentSelectedFiles.clear();
        await fetchRecentUploads();
      } else {
        userSelectedFiles.clear();
        await fetchUserMedia();
        await fetchUsersWithUploads();
      }
    } catch (err) {
      alert(`Failed to delete files: ${err.message}`);
    } finally {
      deleting = false;
    }
  }

  async function deleteAllForUser() {
    if (!selectedUserId) return;

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

      // Refresh data
      await fetchStats();
      userSelectedFiles.clear();
      await fetchUserMedia();
      await fetchUsersWithUploads();
    } catch (err) {
      alert(`Failed to delete user files: ${err.message}`);
    } finally {
      deleting = false;
    }
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  function formatTimestamp(timestamp) {
    if (!timestamp) return 'N/A';
    return new Date(timestamp).toLocaleString();
  }

  function formatRelativeTime(timestamp) {
    if (!timestamp) return 'N/A';
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 30) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  function getFileTypeIcon(fileType) {
    switch (fileType) {
      case 'gif': return 'GIF';
      case 'video': return 'VID';
      case 'image': return 'IMG';
      default: return 'FILE';
    }
  }

  function canShowThumbnail(item) {
    return item.file_type === 'image' || item.file_type === 'gif';
  }

  onMount(() => {
    fetchStats();
    fetchRecentUploads();
  });
</script>

<div class="moderation-container">
  <div class="header-section">
    <h2>r2 moderation</h2>
    <p class="subtitle">manage uploads across all users</p>
  </div>

  <!-- Stats Dashboard -->
  <div class="stats-section">
    {#if statsLoading}
      <div class="stats-loading">loading stats...</div>
    {:else if stats}
      <div class="kpi-grid">
        <KPICard
          title="Total Files"
          value={stats.totalFiles.toLocaleString()}
          status="neutral"
        />
        <KPICard
          title="Storage Used"
          value={formatBytes(stats.totalStorageBytes)}
          status="neutral"
        />
        <KPICard
          title="Active Uploaders"
          value={stats.activeUploaders.toLocaleString()}
          status="neutral"
        />
        <KPICard
          title="Last 24h"
          value={stats.uploadsLast24h.toLocaleString()}
          status={stats.uploadsLast24h > 0 ? 'good' : 'neutral'}
          subtitle="uploads"
        />
      </div>

      <div class="file-type-breakdown">
        <span class="type-badge gif">GIF: {stats.uploadsByType.gif.toLocaleString()}</span>
        <span class="type-badge video">Video: {stats.uploadsByType.video.toLocaleString()}</span>
        <span class="type-badge image">Image: {stats.uploadsByType.image.toLocaleString()}</span>
      </div>
    {/if}
  </div>

  <!-- Tab Navigation -->
  <div class="tab-navigation">
    <button
      class="tab-btn"
      class:active={activeTab === 'recent'}
      on:click={() => handleTabChange('recent')}
    >
      Recent Uploads
    </button>
    <button
      class="tab-btn"
      class:active={activeTab === 'users'}
      on:click={() => handleTabChange('users')}
    >
      Users
    </button>
  </div>

  <!-- Tab Content -->
  <div class="tab-content">
    {#if activeTab === 'recent'}
      <!-- Recent Uploads Tab -->
      <div class="recent-uploads-section">
        <div class="section-controls">
          <div class="left-controls">
            <select bind:value={recentFileType} on:change={handleRecentFileTypeChange}>
              <option value="">all types</option>
              <option value="gif">gif</option>
              <option value="video">video</option>
              <option value="image">image</option>
            </select>

            <div class="view-toggle">
              <button
                class="view-btn"
                class:active={recentViewMode === 'table'}
                on:click={() => recentViewMode = 'table'}
                title="Table view"
              >
                table
              </button>
              <button
                class="view-btn"
                class:active={recentViewMode === 'grid'}
                on:click={() => recentViewMode = 'grid'}
                title="Grid view"
              >
                grid
              </button>
            </div>
          </div>

          {#if recentSelectedFiles.size > 0}
            <button
              class="bulk-delete-btn"
              on:click={() => bulkDelete(recentSelectedFiles, 'recent')}
              disabled={deleting}
            >
              delete selected ({recentSelectedFiles.size})
            </button>
          {/if}
        </div>

        {#if recentLoading}
          <div class="loading">loading recent uploads...</div>
        {:else if recentError}
          <div class="error">error: {recentError}</div>
          <button class="retry-btn" on:click={fetchRecentUploads}>retry</button>
        {:else if recentUploads.length === 0}
          <div class="empty">no uploads found</div>
        {:else}
          {#if recentViewMode === 'table'}
            <!-- Table View -->
            <div class="bulk-actions">
              <label class="select-all-label">
                <input
                  type="checkbox"
                  checked={recentSelectedFiles.size === recentUploads.length && recentUploads.length > 0}
                  on:change={toggleRecentSelectAll}
                />
                <span>select all ({recentSelectedFiles.size} selected)</span>
              </label>
            </div>

            <div class="table-container">
              <table>
                <thead>
                  <tr>
                    <th class="checkbox-col"></th>
                    <th class="thumbnail-col">preview</th>
                    <th>type</th>
                    <th>user</th>
                    <th>date</th>
                    <th>size</th>
                    <th class="actions-col">actions</th>
                  </tr>
                </thead>
                <tbody>
                  {#each recentUploads as item}
                    <tr>
                      <td class="checkbox-cell">
                        <input
                          type="checkbox"
                          checked={recentSelectedFiles.has(item.url_hash)}
                          on:change={() => toggleRecentFileSelection(item.url_hash)}
                        />
                      </td>
                      <td class="thumbnail-cell">
                        {#if canShowThumbnail(item)}
                          <a href={item.file_url} target="_blank" rel="noopener noreferrer">
                            <img
                              src={item.file_url}
                              alt="thumbnail"
                              class="thumbnail"
                              loading="lazy"
                            />
                          </a>
                        {:else}
                          <div class="thumbnail-placeholder">
                            {getFileTypeIcon(item.file_type)}
                          </div>
                        {/if}
                      </td>
                      <td class="type-cell">
                        <span class="type-badge-small {item.file_type}">{item.file_type || 'N/A'}</span>
                      </td>
                      <td class="user-cell">{item.username}</td>
                      <td class="date-cell" title={formatTimestamp(item.processed_at)}>
                        {formatRelativeTime(item.processed_at)}
                      </td>
                      <td class="size-cell">{item.file_size ? formatBytes(item.file_size) : 'N/A'}</td>
                      <td class="actions-cell">
                        <button
                          class="delete-btn"
                          on:click={() => deleteFile(item.url_hash, 'recent')}
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
          {:else}
            <!-- Grid View -->
            <div class="bulk-actions">
              <label class="select-all-label">
                <input
                  type="checkbox"
                  checked={recentSelectedFiles.size === recentUploads.length && recentUploads.length > 0}
                  on:change={toggleRecentSelectAll}
                />
                <span>select all ({recentSelectedFiles.size} selected)</span>
              </label>
            </div>

            <div class="grid-container">
              {#each recentUploads as item}
                <div class="grid-item" class:selected={recentSelectedFiles.has(item.url_hash)}>
                  <div class="grid-checkbox">
                    <input
                      type="checkbox"
                      checked={recentSelectedFiles.has(item.url_hash)}
                      on:change={() => toggleRecentFileSelection(item.url_hash)}
                    />
                  </div>
                  <a href={item.file_url} target="_blank" rel="noopener noreferrer" class="grid-preview">
                    {#if canShowThumbnail(item)}
                      <img
                        src={item.file_url}
                        alt="thumbnail"
                        class="grid-thumbnail"
                        loading="lazy"
                      />
                    {:else}
                      <div class="grid-placeholder">
                        {getFileTypeIcon(item.file_type)}
                      </div>
                    {/if}
                  </a>
                  <div class="grid-info">
                    <span class="type-badge-small {item.file_type}">{item.file_type}</span>
                    <span class="grid-user">{item.username}</span>
                    <span class="grid-size">{formatBytes(item.file_size)}</span>
                  </div>
                  <button
                    class="grid-delete-btn"
                    on:click={() => deleteFile(item.url_hash, 'recent')}
                    disabled={deleting}
                  >
                    delete
                  </button>
                </div>
              {/each}
            </div>
          {/if}

          <!-- Pagination -->
          <div class="pagination">
            <div class="pagination-info">
              showing {recentOffset + 1}-{Math.min(recentOffset + recentLimit, recentTotal)} of {recentTotal}
            </div>
            <div class="pagination-controls">
              <select
                bind:value={recentLimit}
                on:change={() => {
                  recentOffset = 0;
                  recentSelectedFiles.clear();
                  fetchRecentUploads();
                }}
                disabled={deleting}
                class="page-size-select"
              >
                <option value={10}>10 per page</option>
                <option value={25}>25 per page</option>
                <option value={50}>50 per page</option>
                <option value={100}>100 per page</option>
              </select>
              <button on:click={handleRecentPrevPage} disabled={recentOffset === 0 || deleting}>
                previous
              </button>
              <button on:click={handleRecentNextPage} disabled={recentOffset + recentLimit >= recentTotal || deleting}>
                next
              </button>
            </div>
          </div>
        {/if}
      </div>
    {:else if activeTab === 'users'}
      <!-- Users Tab -->
      <div class="users-section">
        <div class="section-controls">
          <div class="left-controls">
            <div class="search-box">
              <input
                type="text"
                bind:value={usersSearch}
                on:keydown={e => e.key === 'Enter' && handleUsersSearch()}
                placeholder="search users..."
              />
              <button on:click={handleUsersSearch}>search</button>
            </div>

            <select bind:value={usersSortBy} on:change={handleUsersSortChange}>
              <option value="upload_count">most uploads</option>
              <option value="storage_used">most storage</option>
              <option value="last_upload">most recent</option>
            </select>
          </div>
        </div>

        {#if usersLoading}
          <div class="loading">loading users...</div>
        {:else if users.length === 0}
          <div class="empty">no users with uploads found</div>
        {:else}
          <div class="users-grid">
            {#each users as user}
              <button
                class="user-card"
                class:selected={selectedUserId === user.user_id}
                on:click={() => handleUserSelect(user)}
              >
                <div class="user-card-header">
                  <span class="user-name">{user.username}</span>
                </div>
                <div class="user-card-stats">
                  <div class="user-stat">
                    <span class="stat-value">{user.upload_count.toLocaleString()}</span>
                    <span class="stat-label">uploads</span>
                  </div>
                  <div class="user-stat">
                    <span class="stat-value">{formatBytes(user.storage_used)}</span>
                    <span class="stat-label">storage</span>
                  </div>
                  <div class="user-stat">
                    <span class="stat-value">{formatRelativeTime(user.last_upload)}</span>
                    <span class="stat-label">last upload</span>
                  </div>
                </div>
              </button>
            {/each}
          </div>

          {#if usersTotal > usersLimit}
            <div class="pagination">
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
        {/if}

        <!-- Selected User Files -->
        {#if selectedUserId}
          <div class="user-files-section">
            <div class="user-files-header">
              <div class="header-info">
                <h3>
                  files for {selectedUser?.username || selectedUserId}
                  {#if userMediaTotal > 0}
                    <span class="count">({userMediaTotal})</span>
                  {/if}
                </h3>
              </div>
              <div class="header-actions">
                <select bind:value={userMediaFileType} on:change={handleUserMediaFileTypeChange}>
                  <option value="">all types</option>
                  <option value="gif">gif</option>
                  <option value="video">video</option>
                  <option value="image">image</option>
                </select>
                {#if userSelectedFiles.size > 0}
                  <button
                    class="bulk-delete-btn"
                    on:click={() => bulkDelete(userSelectedFiles, 'user')}
                    disabled={deleting}
                  >
                    delete selected ({userSelectedFiles.size})
                  </button>
                {/if}
                <button
                  class="delete-all-btn"
                  on:click={deleteAllForUser}
                  disabled={deleting || userMediaTotal === 0}
                >
                  delete all
                </button>
              </div>
            </div>

            {#if userMediaLoading}
              <div class="loading">loading files...</div>
            {:else if userMedia.length === 0}
              <div class="empty">no files found for this user</div>
            {:else}
              <div class="bulk-actions">
                <label class="select-all-label">
                  <input
                    type="checkbox"
                    checked={userSelectedFiles.size === userMedia.length && userMedia.length > 0}
                    on:change={toggleUserSelectAll}
                  />
                  <span>select all ({userSelectedFiles.size} selected)</span>
                </label>
              </div>

              <div class="table-container">
                <table>
                  <thead>
                    <tr>
                      <th class="checkbox-col"></th>
                      <th class="thumbnail-col">preview</th>
                      <th>type</th>
                      <th>date</th>
                      <th>size</th>
                      <th class="actions-col">actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each userMedia as item}
                      <tr>
                        <td class="checkbox-cell">
                          <input
                            type="checkbox"
                            checked={userSelectedFiles.has(item.url_hash)}
                            on:change={() => toggleUserFileSelection(item.url_hash)}
                          />
                        </td>
                        <td class="thumbnail-cell">
                          {#if canShowThumbnail(item)}
                            <a href={item.file_url} target="_blank" rel="noopener noreferrer">
                              <img
                                src={item.file_url}
                                alt="thumbnail"
                                class="thumbnail"
                                loading="lazy"
                              />
                            </a>
                          {:else}
                            <div class="thumbnail-placeholder">
                              {getFileTypeIcon(item.file_type)}
                            </div>
                          {/if}
                        </td>
                        <td class="type-cell">
                          <span class="type-badge-small {item.file_type}">{item.file_type || 'N/A'}</span>
                        </td>
                        <td class="date-cell" title={formatTimestamp(item.processed_at)}>
                          {formatRelativeTime(item.processed_at)}
                        </td>
                        <td class="size-cell">{item.file_size ? formatBytes(item.file_size) : 'N/A'}</td>
                        <td class="actions-cell">
                          <button
                            class="delete-btn"
                            on:click={() => deleteFile(item.url_hash, 'user')}
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
                  showing {userMediaOffset + 1}-{Math.min(userMediaOffset + userMediaLimit, userMediaTotal)} of {userMediaTotal}
                </div>
                <div class="pagination-controls">
                  <select
                    bind:value={userMediaLimit}
                    on:change={() => {
                      userMediaOffset = 0;
                      userSelectedFiles.clear();
                      fetchUserMedia();
                    }}
                    disabled={deleting}
                    class="page-size-select"
                  >
                    <option value={10}>10 per page</option>
                    <option value={25}>25 per page</option>
                    <option value={50}>50 per page</option>
                    <option value={100}>100 per page</option>
                  </select>
                  <button on:click={handleUserMediaPrevPage} disabled={userMediaOffset === 0 || deleting}>
                    previous
                  </button>
                  <button on:click={handleUserMediaNextPage} disabled={userMediaOffset + userMediaLimit >= userMediaTotal || deleting}>
                    next
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .moderation-container {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .header-section {
    margin-bottom: 0.5rem;
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

  /* Stats Section */
  .stats-section {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .stats-loading {
    padding: 2rem;
    text-align: center;
    color: #888;
  }

  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 1rem;
  }

  .file-type-breakdown {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .type-badge {
    padding: 0.4rem 0.75rem;
    border-radius: 4px;
    font-size: 0.85rem;
    font-weight: 500;
  }

  .type-badge.gif {
    background-color: rgba(147, 51, 234, 0.2);
    color: #a78bfa;
    border: 1px solid rgba(147, 51, 234, 0.3);
  }

  .type-badge.video {
    background-color: rgba(59, 130, 246, 0.2);
    color: #60a5fa;
    border: 1px solid rgba(59, 130, 246, 0.3);
  }

  .type-badge.image {
    background-color: rgba(34, 197, 94, 0.2);
    color: #4ade80;
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  /* Tab Navigation */
  .tab-navigation {
    display: flex;
    gap: 0;
    border-bottom: 1px solid #333;
  }

  .tab-btn {
    padding: 0.75rem 1.5rem;
    background: transparent;
    border: none;
    color: #888;
    font-size: 0.95rem;
    cursor: pointer;
    position: relative;
    transition: color 0.2s;
  }

  .tab-btn:hover {
    color: #ccc;
  }

  .tab-btn.active {
    color: #51cf66;
  }

  .tab-btn.active::after {
    content: '';
    position: absolute;
    bottom: -1px;
    left: 0;
    right: 0;
    height: 2px;
    background-color: #51cf66;
  }

  /* Tab Content */
  .tab-content {
    background-color: #222;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 1.5rem;
  }

  /* Section Controls */
  .section-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .left-controls {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .section-controls select {
    padding: 0.5rem 0.75rem;
    background-color: #2a2a2a;
    border: 1px solid #444;
    color: #fff;
    font-size: 0.9rem;
    border-radius: 3px;
    cursor: pointer;
  }

  .view-toggle {
    display: flex;
    border: 1px solid #444;
    border-radius: 3px;
    overflow: hidden;
  }

  .view-btn {
    padding: 0.5rem 0.75rem;
    background-color: #2a2a2a;
    border: none;
    color: #888;
    font-size: 0.85rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .view-btn:not(:last-child) {
    border-right: 1px solid #444;
  }

  .view-btn:hover {
    background-color: #333;
  }

  .view-btn.active {
    background-color: #51cf66;
    color: #000;
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
    min-width: 200px;
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

  /* Bulk Actions */
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

  /* Table Styles */
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

  .thumbnail-col {
    width: 80px;
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

  .thumbnail-cell {
    text-align: center;
  }

  .thumbnail {
    width: 60px;
    height: 60px;
    object-fit: cover;
    border-radius: 4px;
    background-color: #1a1a1a;
  }

  .thumbnail-placeholder {
    width: 60px;
    height: 60px;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: #2a2a2a;
    border-radius: 4px;
    color: #666;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .type-cell {
    text-transform: capitalize;
  }

  .type-badge-small {
    padding: 0.2rem 0.5rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
  }

  .type-badge-small.gif {
    background-color: rgba(147, 51, 234, 0.2);
    color: #a78bfa;
  }

  .type-badge-small.video {
    background-color: rgba(59, 130, 246, 0.2);
    color: #60a5fa;
  }

  .type-badge-small.image {
    background-color: rgba(34, 197, 94, 0.2);
    color: #4ade80;
  }

  .user-cell {
    color: #aaa;
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

  /* Grid View */
  .grid-container {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .grid-item {
    position: relative;
    background-color: #2a2a2a;
    border: 1px solid #333;
    border-radius: 4px;
    overflow: hidden;
    transition: border-color 0.2s;
  }

  .grid-item.selected {
    border-color: #51cf66;
  }

  .grid-item:hover {
    border-color: #555;
  }

  .grid-checkbox {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 1;
  }

  .grid-checkbox input {
    cursor: pointer;
  }

  .grid-preview {
    display: block;
    aspect-ratio: 1;
    background-color: #1a1a1a;
  }

  .grid-thumbnail {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .grid-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #666;
    font-size: 1.5rem;
    font-weight: 600;
  }

  .grid-info {
    padding: 0.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    align-items: center;
    font-size: 0.75rem;
  }

  .grid-user {
    color: #888;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .grid-size {
    color: #666;
    font-family: monospace;
  }

  .grid-delete-btn {
    width: 100%;
    padding: 0.5rem;
    background-color: transparent;
    color: #ff6b6b;
    border: none;
    border-top: 1px solid #333;
    cursor: pointer;
    font-size: 0.8rem;
    transition: background-color 0.2s;
  }

  .grid-delete-btn:hover:not(:disabled) {
    background-color: rgba(255, 107, 107, 0.1);
  }

  .grid-delete-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Users Grid */
  .users-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .user-card {
    background-color: #2a2a2a;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 1rem;
    cursor: pointer;
    transition: all 0.2s;
    text-align: left;
    width: 100%;
  }

  .user-card:hover {
    border-color: #555;
    background-color: #333;
  }

  .user-card.selected {
    border-color: #51cf66;
    background-color: rgba(81, 207, 102, 0.1);
  }

  .user-card-header {
    margin-bottom: 0.75rem;
  }

  .user-name {
    font-size: 1rem;
    font-weight: 500;
    color: #fff;
  }

  .user-card-stats {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .user-stat {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .stat-value {
    font-size: 0.95rem;
    font-weight: 500;
    color: #e0e0e0;
  }

  .stat-label {
    font-size: 0.7rem;
    color: #888;
    text-transform: uppercase;
  }

  /* User Files Section */
  .user-files-section {
    margin-top: 1.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid #333;
  }

  .user-files-header {
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
    flex-wrap: wrap;
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

  /* Pagination */
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

  /* Status Messages */
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

  /* Mobile Responsiveness */
  @media (max-width: 768px) {
    .kpi-grid {
      grid-template-columns: repeat(2, 1fr);
    }

    .file-type-breakdown {
      justify-content: center;
    }

    .section-controls {
      flex-direction: column;
      align-items: stretch;
    }

    .left-controls {
      flex-direction: column;
      align-items: stretch;
    }

    .search-box {
      width: 100%;
    }

    .search-box input {
      flex: 1;
      min-width: 0;
    }

    .view-toggle {
      width: 100%;
    }

    .view-btn {
      flex: 1;
    }

    .table-container {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }

    table {
      min-width: 600px;
    }

    .grid-container {
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    }

    .users-grid {
      grid-template-columns: 1fr;
    }

    .user-files-header {
      flex-direction: column;
      align-items: flex-start;
    }

    .header-actions {
      width: 100%;
      flex-direction: column;
    }

    .header-actions select,
    .delete-all-btn,
    .bulk-delete-btn {
      width: 100%;
    }

    .bulk-actions {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.5rem;
    }

    .pagination {
      flex-direction: column;
      gap: 0.75rem;
      align-items: stretch;
    }

    .pagination-info {
      text-align: center;
    }

    .pagination-controls {
      justify-content: center;
      flex-wrap: wrap;
    }

    button {
      min-height: 44px;
    }
  }
</style>
