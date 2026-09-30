<script>
  import { onDestroy } from 'svelte';
  import {
    Search,
    Trash2,
    ExternalLink,
    X,
    Ban,
    ShieldOff,
    AlertTriangle,
    FolderOpen,
  } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { formatBytes, formatRelativeTime } from '../utils/format.js';
  import PageHeader from '../components/PageHeader.svelte';
  import DataTable from '../components/DataTable.svelte';
  import MediaThumb from '../components/MediaThumb.svelte';
  import Avatar from '../components/Avatar.svelte';

  const PAGE = 25;

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

  // ---- moderation switch + bans
  let enabled = $state(false);
  let bans = $state([]);
  let bansLoading = $state(true);
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
    bansLoading = false;
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

  // ---- stored files by user
  let r2Users = $state([]);
  let usersLoading = $state(true);
  let userFilter = $state('');
  let selectedUser = $state(null);
  let media = $state([]);
  let mediaLoading = $state(false);
  let total = $state(0);
  let offset = $state(0);
  let fileType = $state('');
  let picked = $state(new Set());
  let deleting = $state(false);
  let preview = $state(null);
  let linkState = $state({}); // url_hash -> 'ok' | 'dead'
  let now = $state(Date.now());

  async function loadUsers() {
    const d = await fetch('/api/moderation/r2-users')
      .then(r => r.json())
      .catch(() => null);
    r2Users = d?.users ?? [];
    usersLoading = false;
    if (selectedUser) selectedUser = r2Users.find(u => u.user_id === selectedUser.user_id) ?? null;
  }
  let seq = 0;
  async function loadMedia() {
    if (!selectedUser) return;
    const mine = ++seq;
    mediaLoading = true;
    const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (fileType) q.set('fileType', fileType);
    const d = await fetch(`/api/moderation/users/${selectedUser.user_id}/r2-media?${q}`)
      .then(r => r.json())
      .catch(() => null);
    if (mine !== seq) return;
    media = d?.media ?? [];
    total = d?.total ?? 0;
    now = Date.now();
    mediaLoading = false;
    if (preview && !media.some(m => m.url_hash === preview.url_hash)) preview = null;
  }
  $effect(() => {
    selectedUser;
    offset;
    fileType;
    picked = new Set();
    linkState = {};
    loadMedia();
  });
  const shownUsers = $derived(
    r2Users.filter(u => !userFilter.trim() || u.user_id.includes(userFilter.trim()))
  );
  const storedTotal = $derived(r2Users.reduce((s, u) => s + Number(u.total_size || 0), 0));
  const storedFiles = $derived(r2Users.reduce((s, u) => s + Number(u.file_count || 0), 0));
  const userMax = $derived(Math.max(1, ...r2Users.map(u => Number(u.total_size || 0))));

  // What we know about each file's life in the bucket, from the tracking row and the browser.
  function lifecycle(m) {
    const link = linkState[m.url_hash];
    if (link === 'dead')
      return {
        kind: 'bad',
        label: 'Link dead',
        note: 'The object is gone from R2 but this record still points at it.',
      };
    if (m.deleted_at)
      return {
        kind: 'bad',
        label: 'Deleted',
        note: `Removed ${formatRelativeTime(m.deleted_at)}, record not yet marked.`,
      };
    if (m.expires_at == null)
      return {
        kind: 'info',
        label: 'Permanent',
        note: 'No expiry tracked: an admin upload, or made while tracking was off.',
      };
    if (m.expires_at < now)
      return {
        kind: 'warn',
        label: 'Expired',
        note: `Due ${formatRelativeTime(m.expires_at)}, waiting for the cleanup job.`,
      };
    if (m.deletion_failed)
      return {
        kind: 'warn',
        label: 'Delete failed',
        note: 'The cleanup job could not remove it and will retry.',
      };
    return { kind: 'ok', label: `Expires ${left(m.expires_at - now)}`, note: '' };
  }
  const left = ms =>
    ms < 3_600_000
      ? `in ${Math.max(1, Math.ceil(ms / 60_000))}m`
      : ms < 86_400_000
        ? `in ${Math.floor(ms / 3_600_000)}h`
        : `in ${Math.floor(ms / 86_400_000)}d ${Math.floor((ms % 86_400_000) / 3_600_000)}h`;
  const deadRows = $derived(media.filter(m => linkState[m.url_hash] === 'dead' || m.deleted_at));
  const name = m => m.file_url.split('/').pop().split('?')[0];

  async function afterDelete() {
    picked = new Set();
    preview = null;
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
  async function deleteMany(hashes, what) {
    if (!confirm(`Delete ${hashes.length} ${what}? Links stop working.`)) return;
    deleting = true;
    const res = await fetch('/api/moderation/files/bulk', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urlHashes: hashes }),
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
  function pick(hash, e) {
    e?.stopPropagation();
    const next = new Set(picked);
    next.has(hash) ? next.delete(hash) : next.add(hash);
    picked = next;
  }
  function pickAll() {
    picked = picked.size === media.length ? new Set() : new Set(media.map(m => m.url_hash));
  }
  const setLink = (hash, s) => (linkState = { ...linkState, [hash]: s });

  const columns = [
    { key: 'pick', label: '', width: '18px' },
    { key: 'thumb', label: '', width: '40px' },
    { key: 'file', label: 'file', width: 'minmax(120px, 1fr)' },
    { key: 'size', label: 'size', width: '76px', align: 'right', sm: false },
    { key: 'made', label: 'created', width: '76px', align: 'right', sm: false },
    { key: 'life', label: 'lifecycle', width: '128px', sm: false },
    { key: 'act', label: '', width: '56px' },
  ];

  loadUsers();
  loadBans();

  onDestroy(() => {
    clearTimeout(statusTimer);
    clearTimeout(searchTimer);
  });
</script>

<PageHeader
  title="Moderation"
  description="Files the bot is holding in R2 for each user, and who is banned from using it."
>
  {#snippet actions()}
    <span class="pill" class:ok={enabled} class:warn={!enabled}
      >{enabled ? 'Bans enforced' : 'Bans not enforced'}</span
    >
  {/snippet}
  {#snippet below()}
    <div class="tabs" role="tablist">
      <button
        role="tab"
        aria-selected={tab === 'files'}
        class:on={tab === 'files'}
        onclick={() => navigate('moderation')}
        >Stored files<span class="n">{storedFiles.toLocaleString()}</span></button
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
</PageHeader>

<div class="mod stack">
  {#if status}<div class="flash {status.kind}" role="status">{status.text}</div>{/if}

  {#if tab === 'files'}
    <div class="files" class:with-preview={!!preview}>
      <section class="panel users-col" aria-label="users with stored files">
        <div class="ph">
          <span>Users</span>
          <span class="meta tnum"
            >{storedFiles.toLocaleString()} files · {formatBytes(storedTotal)}</span
          >
        </div>
        <label class="searchbox in-panel">
          <Search size={14} />
          <input bind:value={userFilter} placeholder="Filter by id" aria-label="filter users" />
        </label>
        <div class="ulist">
          {#if usersLoading}
            <div class="skel-rows">
              {#each Array(8) as _, i (i)}<span
                  class="skeleton"
                  style="width:{55 + ((i * 23) % 40)}%"
                ></span>{/each}
            </div>
          {/if}
          {#each shownUsers as u (u.user_id)}
            <button
              class="urow"
              class:sel={selectedUser?.user_id === u.user_id}
              onclick={() => {
                selectedUser = u;
                offset = 0;
                preview = null;
              }}
            >
              <Avatar id={u.user_id} size={28} />
              <span class="grow">
                <span class="row top">
                  <span class="mono ellipsis uid">{u.user_id}</span>
                  <span class="dim small right tnum nowrap"
                    >{formatBytes(Number(u.total_size))}</span
                  >
                </span>
                <span class="row">
                  <span class="ubar"
                    ><i style="width:{(Number(u.total_size) / userMax) * 100}%"></i></span
                  >
                  <span class="dim xs tnum">{u.file_count}</span>
                </span>
              </span>
            </button>
          {:else}
            {#if !usersLoading}<div class="empty">no stored files</div>{/if}
          {/each}
        </div>
      </section>

      {#if !selectedUser}
        <section class="panel">
          <div class="empty big">
            <span class="ic"><FolderOpen size={20} /></span>
            <b>Pick a user</b>
            Their stored files, with thumbnails and expiry, show up here.
          </div>
        </section>
      {:else}
        <DataTable
          {columns}
          rows={media}
          rowKey="url_hash"
          loading={mediaLoading}
          empty="no files"
          selected={preview?.url_hash}
          onrow={m => (preview = preview?.url_hash === m.url_hash ? null : m)}
          pager={{ offset, limit: PAGE, total, onpage: o => (offset = o) }}
          label="stored files"
        >
          {#snippet header()}
            <span class="user-cell"
              ><Avatar id={selectedUser.user_id} size={20} /><button
                class="linkish mono"
                onclick={() => navigate('user-profile', { userId: selectedUser.user_id })}
                >{selectedUser.user_id}</button
              ></span
            >
            <select class="field sm" bind:value={fileType} aria-label="file type">
              <option value="">All types</option>
              <option value="video">Video</option>
              <option value="gif">GIF</option>
              <option value="image">Image</option>
            </select>
            {#if picked.size}
              <button
                class="btn danger sm"
                disabled={deleting}
                onclick={() => deleteMany([...picked], 'selected file(s)')}
                ><Trash2 size={12} />Delete {picked.size}</button
              >
            {:else if deadRows.length}
              <button
                class="btn sm"
                disabled={deleting}
                title="drop the cache records whose object is already gone"
                onclick={() =>
                  deleteMany(
                    deadRows.map(m => m.url_hash),
                    'dead record(s)'
                  )}><AlertTriangle size={12} />Clear {deadRows.length} dead</button
              >
            {/if}
            <button class="btn danger sm" disabled={deleting} onclick={deleteAll}
              ><Trash2 size={12} />Delete all</button
            >
          {/snippet}
          {#snippet row(m)}
            {@const life = lifecycle(m)}
            <span>
              <input
                type="checkbox"
                class="pickbox"
                checked={picked.has(m.url_hash)}
                onclick={e => pick(m.url_hash, e)}
                aria-label="select file"
              />
            </span>
            <MediaThumb
              url={m.file_url}
              type={m.file_type}
              size={36}
              onstate={s => setLink(m.url_hash, s)}
            />
            <span class="filecell">
              <span class="mono ellipsis" title={m.file_url}>{name(m)}</span>
              <span class="row xs dim"
                ><span class="chip">{m.file_type}</span>{m.file_extension}</span
              >
            </span>
            <span class="num muted hide-sm">{formatBytes(m.file_size)}</span>
            <span class="num dim hide-sm" title={new Date(m.processed_at).toLocaleString()}
              >{formatRelativeTime(m.processed_at)}</span
            >
            <span class="hide-sm">
              <span class="pill sm {life.kind}" title={life.note}>{life.label}</span>
            </span>
            <span class="row acts">
              <a
                class="icon-btn sm"
                href={m.file_url}
                target="_blank"
                rel="noreferrer"
                title="open"
                onclick={e => e.stopPropagation()}><ExternalLink size={13} /></a
              >
              <button
                class="icon-btn sm danger"
                disabled={deleting}
                onclick={e => {
                  e.stopPropagation();
                  deleteOne(m);
                }}
                title="delete"
                aria-label="delete file"><Trash2 size={13} /></button
              >
            </span>
          {/snippet}
          {#snippet footer()}
            {#if media.length}
              <div class="pf">
                <label class="row small"
                  ><input
                    type="checkbox"
                    class="pickbox"
                    checked={picked.size === media.length}
                    onclick={pickAll}
                  /> Select page</label
                >
                {#if deadRows.length}
                  <span class="warn-text small"
                    >{deadRows.length} record{deadRows.length === 1 ? '' : 's'} on this page point at
                    objects that are gone</span
                  >
                {/if}
              </div>
            {/if}
          {/snippet}
        </DataTable>

        {#if preview}
          {@const life = lifecycle(preview)}
          <section class="panel preview" aria-label="file preview">
            <div class="ph">
              <span class="ellipsis mono small">{name(preview)}</span>
              <button class="icon-btn sm right" onclick={() => (preview = null)} aria-label="close"
                ><X size={15} /></button
              >
            </div>
            <div class="pb">
              <MediaThumb
                url={preview.file_url}
                type={preview.file_type}
                preview
                onstate={s => setLink(preview.url_hash, s)}
              />
            </div>
            <dl class="dl">
              <dt>Type</dt>
              <dd>{preview.file_type} · {preview.file_extension}</dd>
              <dt>Size</dt>
              <dd>{formatBytes(preview.file_size)}</dd>
              <dt>Created</dt>
              <dd>{new Date(preview.processed_at).toLocaleString()}</dd>
              <dt>Lifecycle</dt>
              <dd><span class="pill sm {life.kind}">{life.label}</span></dd>
              {#if life.note}<dt></dt>
                <dd class="dim small">{life.note}</dd>{/if}
              {#if preview.expires_at}
                <dt>Expires</dt>
                <dd>{new Date(preview.expires_at).toLocaleString()}</dd>
              {/if}
              <dt>Hash</dt>
              <dd class="mono small break">{preview.url_hash}</dd>
            </dl>
            <div class="pf">
              <a class="btn sm" href={preview.file_url} target="_blank" rel="noreferrer"
                ><ExternalLink size={12} />Open</a
              >
              <button
                class="btn danger sm right"
                disabled={deleting}
                onclick={() => deleteOne(preview)}
                ><Trash2 size={12} />{life.kind === 'bad' ? 'Remove record' : 'Delete'}</button
              >
            </div>
          </section>
        {/if}
      {/if}
    </div>
  {:else}
    <div class="bans stack">
      <section class="panel" class:accent-ok={enabled} class:accent-warn={!enabled}>
        <div class="pb row switch">
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
            <div class="muted small">
              {enabled
                ? 'Banned users are refused every command.'
                : 'Off: bans are recorded but not enforced.'}
            </div>
          </div>
        </div>
      </section>

      <div class="two wide-left">
        <DataTable
          title="Banned users"
          columns={[
            { key: 'user', label: 'user', width: 'minmax(0, 1fr)' },
            { key: 'reason', label: 'reason', width: 'minmax(0, 1.4fr)', sm: false },
            { key: 'appeal', label: 'appeal', width: '90px', sm: false },
            { key: 'since', label: 'since', width: '90px', align: 'right' },
            { key: 'act', label: '', width: '84px' },
          ]}
          rows={bans}
          rowKey="user_id"
          loading={bansLoading}
        >
          {#snippet header()}<span class="tnum">{bans.length}</span>{/snippet}
          {#snippet emptyState()}
            <div class="empty">
              <span class="ic"><ShieldOff size={20} /></span>
              <b>Nobody is banned</b>
              Ban a user from the form, or from their profile.
            </div>
          {/snippet}
          {#snippet row(b)}
            <span class="user-cell"
              ><Avatar id={b.user_id} size={24} /><button
                class="linkish mono id"
                onclick={() => navigate('user-profile', { userId: b.user_id })}>{b.user_id}</button
              ></span
            >
            <span class="ellipsis hide-sm" title={b.reason}>{b.reason}</span>
            <span class="hide-sm"
              ><span class="pill sm" class:ok={b.appeal_allowed} class:idle={!b.appeal_allowed}
                >{b.appeal_allowed ? 'Allowed' : 'No appeal'}</span
              ></span
            >
            <span class="num dim">{formatRelativeTime(b.banned_at)}</span>
            <button class="btn sm" onclick={() => unban(b.user_id)}
              ><ShieldOff size={12} />Unban</button
            >
          {/snippet}
        </DataTable>

        <section class="panel" aria-label="ban a user">
          <div class="ph"><span>Ban a user</span></div>
          <div class="pb form">
            <label
              >Find user
              <label class="searchbox">
                <Search size={14} />
                <input
                  bind:value={banSearch}
                  oninput={onBanSearch}
                  placeholder="Search by id"
                  aria-label="search users"
                />
              </label>
            </label>
            {#if banResults.length}
              <div class="results">
                {#each banResults as u (u.user_id)}
                  <button
                    class="lrow"
                    onclick={() => {
                      banForm.userId = u.user_id;
                      banSearch = '';
                      banResults = [];
                    }}
                  >
                    <Avatar id={u.user_id} size={22} />
                    <span class="mono ellipsis grow">{u.user_id}</span><span class="dim small"
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
                placeholder="Shown to them when they appeal"></textarea></label
            >
            <label class="check-row"
              ><input type="checkbox" bind:checked={banForm.appealAllowed} /> Allow appeal</label
            >
            <button
              class="btn danger"
              disabled={busy || !banForm.userId.trim() || !banForm.reason.trim()}
              onclick={submitBan}><Ban size={14} />Ban user</button
            >
          </div>
        </section>
      </div>
    </div>
  {/if}
</div>

<style>
  .files {
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr);
    gap: var(--gap);
    align-items: start;
  }
  .files.with-preview {
    grid-template-columns: 260px minmax(0, 1fr) 300px;
  }
  .searchbox.in-panel {
    margin: 12px 12px 8px;
  }
  .ulist {
    max-height: calc(100vh - 330px);
    overflow-y: auto;
    padding: 0 8px 8px;
  }
  .urow {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--text);
    font: inherit;
    font-size: var(--fs);
    text-align: left;
    cursor: pointer;
  }
  .urow .grow {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .urow .row {
    width: 100%;
  }
  .uid {
    font-size: var(--fs-sm);
    color: var(--text-bright);
  }
  .urow:hover {
    background: var(--row-hover);
  }
  .urow.sel {
    background: var(--accent-bg);
  }
  .ubar {
    flex: 1;
    height: 4px;
    border-radius: 2px;
    background: var(--card-3);
    overflow: hidden;
  }
  .ubar i {
    display: block;
    height: 100%;
    background: var(--chart-muted);
  }
  .urow.sel .ubar i {
    background: var(--accent-strong);
  }
  .pickbox {
    width: 15px;
    height: 15px;
    margin: 0;
    accent-color: var(--accent-strong);
    cursor: pointer;
  }
  .filecell {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: 7px 0;
  }
  .acts {
    justify-content: flex-end;
    gap: 2px;
  }
  .preview {
    position: sticky;
    top: 24px;
  }
  .dl {
    margin: 0;
    padding: 4px 20px 14px;
    display: grid;
    grid-template-columns: 80px 1fr;
    gap: 8px 10px;
    font-size: var(--fs);
  }
  .dl dt {
    color: var(--text-dim);
  }
  .dl dd {
    margin: 0;
    min-width: 0;
  }
  .break {
    overflow-wrap: anywhere;
  }
  .switch {
    gap: 14px;
  }
  .switch b {
    font-weight: 600;
    color: var(--text-bright);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .form > label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-muted);
  }
  .form .check-row {
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }
  .results {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  @media (max-width: 1100px) {
    .files,
    .files.with-preview {
      grid-template-columns: 1fr;
    }
    .ulist {
      max-height: 280px;
    }
    .preview {
      position: static;
    }
  }
</style>
