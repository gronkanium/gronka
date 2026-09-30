<script>
  import { onDestroy } from 'svelte';
  import { Search, Trash2, ExternalLink, Film } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { useHeaderActions } from '../stores/header.js';
  import { formatBytes, formatRelativeTime } from '../utils/format.js';

  const PAGE = 24;

  const tab = $derived($currentRoute.params.$tab === 'bans' ? 'bans' : 'files');
  let status = $state(null);
  let statusTimer;
  function flash(kind, text) {
    status = { kind, text };
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => (status = null), 5000);
  }
  const readError = async (res, fallback) =>
    (await res.json().catch(() => ({}))).message || fallback;

  // Moderation switch + bans
  let enabled = $state(false);
  let bans = $state([]);
  let banForm = $state({ userId: '', reason: '', appealAllowed: true });
  let banSearch = $state('');
  let banResults = $state([]);
  let busy = $state(false);

  async function loadBans() {
    const [s, b] = await Promise.all([
      fetch('/api/settings')
        .then(r => r.json())
        .catch(() => null),
      fetch('/api/bans')
        .then(r => r.json())
        .catch(() => null),
    ]);
    enabled = s?.settings?.moderation_enabled?.value === 'true';
    bans = b?.bans ?? [];
  }
  async function toggleEnabled() {
    busy = true;
    const res = await fetch('/api/settings/moderation_enabled', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: !enabled }),
    }).catch(() => null);
    busy = false;
    if (res?.ok) enabled = !enabled;
    else flash('error', 'could not change the moderation switch');
  }
  let searchTimer;
  function onBanSearch() {
    clearTimeout(searchTimer);
    if (!banSearch.trim()) return (banResults = []);
    searchTimer = setTimeout(async () => {
      const d = await fetch(`/api/users?search=${encodeURIComponent(banSearch.trim())}&limit=8`)
        .then(r => r.json())
        .catch(() => null);
      banResults = d?.users ?? [];
    }, 250);
  }
  async function submitBan() {
    busy = true;
    const res = await fetch('/api/bans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: banForm.userId.trim(),
        reason: banForm.reason.trim(),
        appealAllowed: banForm.appealAllowed,
      }),
    }).catch(() => null);
    busy = false;
    if (res?.ok) {
      flash('ok', `banned ${banForm.userId.trim()}`);
      banForm = { userId: '', reason: '', appealAllowed: true };
      loadBans();
    } else flash('error', res ? await readError(res, 'could not ban') : 'could not ban');
  }
  async function unban(userId) {
    if (!confirm(`Unban ${userId}?`)) return;
    const res = await fetch(`/api/bans/${userId}`, { method: 'DELETE' }).catch(() => null);
    if (res?.ok) {
      flash('ok', `unbanned ${userId}`);
      loadBans();
    } else flash('error', 'could not unban');
  }

  // Stored files by user
  let r2Users = $state([]);
  let userFilter = $state('');
  let selectedUser = $state(null);
  let media = $state([]);
  let total = $state(0);
  let offset = $state(0);
  let fileType = $state('');
  let picked = $state(new Set());
  let deleting = $state(false);

  async function loadUsers() {
    const d = await fetch('/api/moderation/r2-users')
      .then(r => r.json())
      .catch(() => null);
    r2Users = d?.users ?? [];
    if (selectedUser) selectedUser = r2Users.find(u => u.user_id === selectedUser.user_id) ?? null;
  }
  async function loadMedia() {
    if (!selectedUser) return;
    const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (fileType) q.set('fileType', fileType);
    const d = await fetch(`/api/moderation/users/${selectedUser.user_id}/r2-media?${q}`)
      .then(r => r.json())
      .catch(() => null);
    media = d?.media ?? [];
    total = d?.total ?? 0;
  }
  $effect(() => {
    selectedUser;
    offset;
    fileType;
    picked = new Set();
    loadMedia();
  });
  const shownUsers = $derived(
    r2Users.filter(u => !userFilter.trim() || u.user_id.includes(userFilter.trim()))
  );
  const storedTotal = $derived(r2Users.reduce((s, u) => s + Number(u.total_size || 0), 0));

  async function afterDelete() {
    picked = new Set();
    await Promise.all([loadUsers(), loadMedia()]);
  }
  async function deleteOne(item) {
    if (!confirm('Delete this file from storage? Its link stops working.')) return;
    deleting = true;
    const res = await fetch(`/api/moderation/files/${item.url_hash}`, { method: 'DELETE' }).catch(
      () => null
    );
    deleting = false;
    res?.ok
      ? flash('ok', 'file deleted')
      : flash('error', res ? await readError(res, 'delete failed') : 'delete failed');
    afterDelete();
  }
  async function deletePicked() {
    if (!confirm(`Delete ${picked.size} file(s) from storage? Their links stop working.`)) return;
    deleting = true;
    const res = await fetch('/api/moderation/files/bulk', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urlHashes: [...picked] }),
    }).catch(() => null);
    deleting = false;
    const results = res?.ok ? (await res.json()).results : null;
    if (!results) flash('error', res ? await readError(res, 'delete failed') : 'delete failed');
    else if (results.failed?.length)
      flash('error', `deleted ${results.success.length}, ${results.failed.length} failed`);
    else flash('ok', `deleted ${results.success.length} file(s)`);
    afterDelete();
  }
  async function deleteAll() {
    const id = selectedUser.user_id;
    if (
      !confirm(
        `Delete ALL ${selectedUser.file_count} stored file(s) for ${id}? This cannot be undone.`
      )
    )
      return;
    deleting = true;
    const res = await fetch(`/api/moderation/users/${id}/r2-media`, { method: 'DELETE' }).catch(
      () => null
    );
    deleting = false;
    res?.ok
      ? flash('ok', `deleted ${(await res.json()).deleted} file(s)`)
      : flash('error', 'delete failed');
    afterDelete();
  }
  function pick(hash) {
    const next = new Set(picked);
    next.has(hash) ? next.delete(hash) : next.add(hash);
    picked = next;
  }
  const isVisual = m => m.file_type === 'gif' || m.file_type === 'image';

  loadUsers();
  loadBans();

  useHeaderActions(actions);
  onDestroy(() => clearTimeout(statusTimer));
</script>

{#snippet actions()}
  <div class="seg" role="tablist">
    <button
      role="tab"
      aria-selected={tab === 'files'}
      class:on={tab === 'files'}
      onclick={() => navigate('moderation')}
      >Stored files<span class="n">{r2Users.length}</span></button
    >
    <button
      role="tab"
      aria-selected={tab === 'bans'}
      class:on={tab === 'bans'}
      onclick={() => navigate('moderation', { tab: 'bans' })}
      >Bans<span class="n">{bans.length}</span></button
    >
  </div>
{/snippet}

<div class="mod">
  {#if status}<div class="flash {status.kind}" role="status">{status.text}</div>{/if}

  {#if tab === 'files'}
    <div class="files">
      <section class="panel users-col" aria-label="users with stored files">
        <div class="ph">
          <span>Users with stored files</span><span class="meta mono"
            >{formatBytes(storedTotal)}</span
          >
        </div>
        <label class="filter"
          ><Search size={13} /><input
            bind:value={userFilter}
            placeholder="filter by id"
            aria-label="filter users"
          /></label
        >
        <div class="ulist">
          {#each shownUsers as u (u.user_id)}
            <button
              class="urow"
              class:sel={selectedUser?.user_id === u.user_id}
              onclick={() => {
                selectedUser = u;
                offset = 0;
              }}
            >
              <span class="mono ellipsis">{u.user_id}</span>
              <span class="mono dim small"
                >{u.file_count} · {formatBytes(Number(u.total_size))}</span
              >
            </button>
          {:else}
            <div class="empty">no stored files</div>
          {/each}
        </div>
      </section>

      <section class="panel" aria-label="files">
        {#if !selectedUser}
          <div class="empty big">Pick a user to see and remove their stored files.</div>
        {:else}
          <div class="ph">
            <button
              class="linkish mono"
              onclick={() => navigate('user-profile', { userId: selectedUser.user_id })}
              >{selectedUser.user_id}</button
            >
            <span class="meta">
              <select class="field sm" bind:value={fileType} aria-label="file type">
                <option value="">all types</option>
                <option value="video">video</option>
                <option value="gif">gif</option>
                <option value="image">image</option>
              </select>
              {#if picked.size}
                <button class="btn danger sm" disabled={deleting} onclick={deletePicked}
                  >Delete {picked.size}</button
                >
              {/if}
              <button class="btn danger sm" disabled={deleting} onclick={deleteAll}
                ><Trash2 size={12} />Delete all</button
              >
            </span>
          </div>
          <div class="gallery">
            {#each media as m (m.url_hash)}
              <div class="tile" class:on={picked.has(m.url_hash)}>
                <button
                  class="thumb"
                  onclick={() => pick(m.url_hash)}
                  aria-pressed={picked.has(m.url_hash)}
                  aria-label="select file"
                >
                  {#if isVisual(m)}
                    <img src={m.file_url} alt="" loading="lazy" />
                  {:else}
                    <span class="vid"><Film size={22} /><span>{m.file_extension}</span></span>
                  {/if}
                  <span class="check">{picked.has(m.url_hash) ? '✓' : ''}</span>
                </button>
                <div class="cap">
                  <span class="chip">{m.file_type}</span>
                  <span class="mono small muted">{formatBytes(m.file_size)}</span>
                  <span class="dim small grow">{formatRelativeTime(m.processed_at)}</span>
                  <a class="icon" href={m.file_url} target="_blank" rel="noreferrer" title="open"
                    ><ExternalLink size={13} /></a
                  >
                  <button
                    class="icon danger"
                    disabled={deleting}
                    onclick={() => deleteOne(m)}
                    title="delete"
                    aria-label="delete file"><Trash2 size={13} /></button
                  >
                </div>
              </div>
            {:else}
              <div class="empty">no files</div>
            {/each}
          </div>
          {#if total > PAGE}
            <div class="pager">
              <span class="dim">{offset + 1}–{Math.min(offset + PAGE, total)} of {total}</span>
              <span class="row">
                <button class="btn sm" disabled={offset === 0} onclick={() => (offset -= PAGE)}
                  >Previous</button
                >
                <button
                  class="btn sm"
                  disabled={offset + PAGE >= total}
                  onclick={() => (offset += PAGE)}>Next</button
                >
              </span>
            </div>
          {/if}
        {/if}
      </section>
    </div>
  {:else}
    <div class="bans">
      <section class="panel switch-panel">
        <div class="pb row">
          <button
            class="toggle"
            class:on={enabled}
            role="switch"
            aria-checked={enabled}
            aria-label="enforce bans"
            disabled={busy}
            onclick={toggleEnabled}
          ></button>
          <div class="grow">
            <b>Enforce bans</b>
            <div class="dim small">
              {enabled
                ? 'Banned users are refused every command.'
                : 'Off: bans are recorded but not enforced.'}
            </div>
          </div>
        </div>
      </section>

      <div class="two">
        <section
          class="panel tbl"
          aria-label="bans"
          style="--cols: minmax(0, 1fr) minmax(0, 1.4fr) 90px 100px 80px"
        >
          <div class="ph">
            <span>Banned users</span><span class="meta mono">{bans.length}</span>
          </div>
          <div class="tr head">
            <span>user</span><span>reason</span><span>appeal</span><span>since</span><span></span>
          </div>
          {#each bans as b (b.user_id)}
            <div class="tr">
              <button
                class="linkish mono ellipsis"
                onclick={() => navigate('user-profile', { userId: b.user_id })}>{b.user_id}</button
              >
              <span class="ellipsis" title={b.reason}>{b.reason}</span>
              <span class="small muted">{b.appeal_allowed ? 'allowed' : 'no'}</span>
              <span class="small dim">{formatRelativeTime(b.banned_at)}</span>
              <button class="btn sm" onclick={() => unban(b.user_id)}>Unban</button>
            </div>
          {:else}
            <div class="empty">nobody is banned</div>
          {/each}
        </section>

        <section class="panel" aria-label="ban a user">
          <div class="ph"><span>Ban a user</span></div>
          <div class="pb form">
            <label
              >Find user
              <input
                class="field"
                bind:value={banSearch}
                oninput={onBanSearch}
                placeholder="search by id"
              />
            </label>
            {#if banResults.length}
              <div class="results">
                {#each banResults as u (u.user_id)}
                  <button
                    class="urow"
                    onclick={() => {
                      banForm.userId = u.user_id;
                      banSearch = '';
                      banResults = [];
                    }}
                  >
                    <span class="mono ellipsis">{u.user_id}</span><span class="dim small"
                      >{u.total_commands} requests</span
                    >
                  </button>
                {/each}
              </div>
            {/if}
            <label
              >User id <input
                class="field mono"
                bind:value={banForm.userId}
                placeholder="17-20 digit Discord id"
              /></label
            >
            <label
              >Reason <textarea
                class="field"
                rows="3"
                bind:value={banForm.reason}
                maxlength="200"
                placeholder="shown to them when they appeal"></textarea></label
            >
            <label class="check-row"
              ><input type="checkbox" bind:checked={banForm.appealAllowed} /> allow appeal</label
            >
            <button
              class="btn danger"
              disabled={busy || !banForm.userId.trim() || !banForm.reason.trim()}
              onclick={submitBan}>Ban user</button
            >
          </div>
        </section>
      </div>
    </div>
  {/if}
</div>

<style>
  .mod {
    max-width: 1400px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .small {
    font-size: 12px;
  }
  .flash {
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 13px;
  }
  .flash.ok {
    background: var(--success-bg);
    color: var(--success);
  }
  .flash.error {
    background: var(--danger-bg);
    color: #f4b4b4;
  }
  .files {
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }
  .filter {
    margin: 10px 12px;
    height: 32px;
    padding: 0 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-muted);
  }
  .filter input {
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    outline: 0;
    color: var(--text-bright);
    font: inherit;
    font-size: 13px;
  }
  .ulist {
    max-height: calc(100vh - 260px);
    overflow-y: auto;
    padding: 0 6px 8px;
  }
  .urow {
    width: 100%;
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 10px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .urow:hover,
  .urow.sel {
    background: var(--surface-2);
  }
  .empty.big {
    padding: 80px 16px;
  }
  .field.sm {
    height: 26px;
    font-size: 12px;
  }
  .linkish {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }
  .gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 12px;
    padding: 14px;
  }
  .tile {
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg);
  }
  .tile.on {
    border-color: var(--danger);
  }
  .thumb {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 10;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    background: #0b0c0e;
    cursor: pointer;
    overflow: hidden;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .vid {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    color: var(--text-dim);
    font: 11px var(--mono);
  }
  .check {
    position: absolute;
    top: 8px;
    left: 8px;
    width: 18px;
    height: 18px;
    border-radius: 5px;
    border: 1.5px solid rgba(255, 255, 255, 0.5);
    background: rgba(0, 0, 0, 0.4);
    color: #fff;
    font-size: 12px;
    line-height: 15px;
  }
  .tile.on .check {
    background: var(--danger);
    border-color: var(--danger);
  }
  .cap {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px;
  }
  .icon {
    display: flex;
    padding: 3px;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
  }
  .icon:hover {
    background: var(--surface-2);
    color: var(--text-bright);
  }
  .icon.danger:hover {
    color: var(--danger);
  }
  .pager {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-top: 1px solid var(--line);
    font-size: 12px;
  }
  .bans {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .switch-panel .row {
    gap: 14px;
  }
  .switch-panel b {
    font-weight: 500;
    color: var(--text-bright);
  }
  .two {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    gap: 16px;
    align-items: start;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .form label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .form .check-row {
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }
  .results {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px;
  }
  @media (max-width: 1000px) {
    .files,
    .two {
      grid-template-columns: 1fr;
    }
  }
</style>
