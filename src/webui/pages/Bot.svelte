<script>
  import { sendJson } from '../utils/api.js';
  import { Check, ImagePlus, Trash2 } from 'lucide-svelte';
  import PageHeader from '../components/PageHeader.svelte';

  const STATUSES = [
    { id: 'online', label: 'Online' },
    { id: 'idle', label: 'Idle' },
    { id: 'dnd', label: 'Do Not Disturb' },
    { id: 'invisible', label: 'Invisible', hint: 'shows as offline' },
  ];
  const IMAGES = 'image/png,image/jpeg,image/gif,image/webp';

  let saved = $state(null);
  // avatar and banner: undefined keeps the current one, a data URI replaces it, null removes it.
  let draft = $state(null);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let toast = $state('');
  let toastTimer;

  const fresh = s => ({
    username: s.username,
    bio: s.bio,
    status: s.status,
    activity: s.activity,
    avatar: undefined,
    banner: undefined,
  });

  async function getOrThrow(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function load(keepDraft = false) {
    try {
      const [profile, presence] = await Promise.all([
        getOrThrow('/api/bot/profile'),
        getOrThrow('/api/bot/status'),
      ]);
      saved = { ...profile, status: presence.status, activity: presence.activity ?? '' };
      if (!keepDraft) draft = fresh(saved);
    } catch (err) {
      error = err.message || 'could not load the bot profile';
    } finally {
      loading = false;
    }
  }
  load();

  const changes = $derived.by(() => {
    if (!saved || !draft) return { profile: {}, presence: false };
    const profile = {};
    if (draft.username.trim() !== saved.username) profile.username = draft.username.trim();
    if (draft.bio !== saved.bio) profile.bio = draft.bio;
    if (draft.avatar !== undefined) profile.avatar = draft.avatar;
    if (draft.banner !== undefined) profile.banner = draft.banner;
    const presence = draft.status !== saved.status || draft.activity.trim() !== saved.activity;
    return { profile, presence };
  });
  const dirty = $derived(Object.keys(changes.profile).length > 0 || changes.presence);

  const avatarSrc = $derived(
    draft?.avatar === undefined ? saved?.avatar : (draft.avatar ?? saved.defaultAvatar)
  );
  const bannerSrc = $derived(draft?.banner === undefined ? saved?.banner : draft.banner);
  const hasAvatar = $derived(draft?.avatar === undefined ? saved?.hasAvatar : !!draft.avatar);

  function pick(key) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = IMAGES;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => (draft[key] = reader.result);
      reader.readAsDataURL(file);
    };
    input.click();
  }
  const removeAvatar = () => (draft.avatar = saved.hasAvatar ? null : undefined);
  const removeBanner = () => (draft.banner = saved.banner ? null : undefined);

  function say(text) {
    toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), 2000);
  }

  async function send(url, method, body) {
    const res = await sendJson(url, method, body);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  }

  async function save() {
    saving = true;
    error = '';
    try {
      if (Object.keys(changes.profile).length) {
        await send('/api/bot/profile', 'PATCH', changes.profile);
      }
      if (changes.presence) {
        await send('/api/bot/status', 'POST', {
          status: draft.status,
          activity: draft.activity.trim() || undefined,
        });
      }
      await load();
      say('Profile saved');
    } catch (err) {
      // Discord can take the name and refuse the rest; reload what it holds, keep the unsaved edits.
      await load(true);
      error = err.message;
    } finally {
      saving = false;
    }
  }
</script>

<PageHeader title="Bot" description="Name, pictures, about me and status, as Discord shows them">
  {#snippet actions()}
    {#if error}<span class="pill bad">{error}</span>{/if}
  {/snippet}
</PageHeader>

{#if loading}
  <div class="panel pb skel-rows">
    {#each Array(4) as _, i (i)}<span class="skeleton" style="width:{60 - i * 8}%"></span>{/each}
  </div>
{:else if draft}
  <div class="bot" class:dirty>
    <div class="forms">
      <section class="panel" aria-label="profile">
        <div class="ph"><span>Profile</span></div>
        <div class="item">
          <div class="lbl">
            <b>Username</b>
            <p>Discord only allows a few name changes an hour</p>
          </div>
          <div class="ctl">
            <input class="field wide" bind:value={draft.username} aria-label="username" />
          </div>
        </div>
        <div class="item">
          <div class="lbl">
            <b>Avatar</b>
            <p>PNG, JPEG, GIF or WebP</p>
          </div>
          <div class="ctl">
            <button class="btn" onclick={() => pick('avatar')}
              ><ImagePlus size={14} />Change avatar</button
            >
            <button class="btn" disabled={!hasAvatar} onclick={removeAvatar}
              ><Trash2 size={14} />Remove</button
            >
          </div>
        </div>
        <div class="item">
          <div class="lbl">
            <b>Banner</b>
            <p>Shown across the top of the profile</p>
          </div>
          <div class="ctl">
            <button class="btn" onclick={() => pick('banner')}
              ><ImagePlus size={14} />Change banner</button
            >
            <button class="btn" disabled={!bannerSrc} onclick={removeBanner}
              ><Trash2 size={14} />Remove</button
            >
          </div>
        </div>
        <div class="item stacked">
          <div class="lbl">
            <b>About me</b>
            <p>The bio on the bot's profile</p>
          </div>
          <textarea class="field bio" rows="5" bind:value={draft.bio} aria-label="about me"
          ></textarea>
        </div>
      </section>

      <section class="panel" aria-label="presence">
        <div class="ph"><span>Presence</span></div>
        <div class="item stacked">
          <div class="lbl">
            <b>Status</b>
            <p>The dot next to the bot's name</p>
          </div>
          <div class="statuses" role="radiogroup" aria-label="status">
            {#each STATUSES as s (s.id)}
              <button
                class="status"
                class:on={draft.status === s.id}
                role="radio"
                aria-checked={draft.status === s.id}
                onclick={() => (draft.status = s.id)}
              >
                <span class="dot {s.id}"></span>
                <span>{s.label}</span>
                {#if s.hint}<span class="dim small">{s.hint}</span>{/if}
              </button>
            {/each}
          </div>
        </div>
        <div class="item">
          <div class="lbl">
            <b>Custom status</b>
            <p>The line under the name. Leave empty for none.</p>
          </div>
          <div class="ctl">
            <input
              class="field wide"
              bind:value={draft.activity}
              maxlength="128"
              placeholder="e.g. /download · gronka.dev"
              aria-label="custom status"
            />
          </div>
        </div>
      </section>
    </div>

    <aside class="preview" aria-label="profile preview">
      <span class="section-label">Preview</span>
      <div class="card">
        <div
          class="banner"
          style:background-image={bannerSrc ? `url("${bannerSrc}")` : null}
          style:background-color={saved.accentColor}
        ></div>
        <div class="avatar">
          <img src={avatarSrc} alt="" />
          <span class="dot ring {draft.status}"></span>
        </div>
        <div class="body">
          <div class="name">
            <b>{draft.username.trim() || saved.username}</b><span class="app">APP</span>
          </div>
          {#if draft.activity.trim()}<div class="custom">{draft.activity.trim()}</div>{/if}
          <div class="about">
            <span>About me</span>
            <p class:dim={!draft.bio.trim()}>{draft.bio.trim() || 'No about me yet'}</p>
          </div>
        </div>
      </div>
    </aside>
  </div>

  {#if dirty}
    <div class="unsaved" role="status">
      <span>Careful, you have unsaved changes!</span>
      <button class="btn reset" disabled={saving} onclick={() => (draft = fresh(saved))}
        >Reset</button
      >
      <button class="btn save" disabled={saving} onclick={save}
        >{saving ? 'Saving...' : 'Save Changes'}</button
      >
    </div>
  {/if}
{/if}

{#if toast}<div class="toast" role="status"><Check size={14} />{toast}</div>{/if}

<style>
  .bot {
    display: grid;
    grid-template-columns: minmax(0, 640px) 340px;
    gap: var(--gap-lg);
    align-items: start;
  }
  .bot.dirty {
    padding-bottom: 80px;
  }
  .forms {
    display: flex;
    flex-direction: column;
    gap: var(--gap);
  }
  .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(220px, 320px);
    gap: 24px;
    padding: 16px;
    border-top: 1px solid var(--line);
    align-items: center;
  }
  .ph + .item {
    border-top: 0;
  }
  .item.stacked {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .lbl b {
    font-weight: 600;
    font-size: var(--fs);
    color: var(--text-bright);
  }
  .lbl p {
    margin: 3px 0 0;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text-muted);
  }
  .ctl {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }
  .field.wide {
    width: 100%;
  }
  .bio {
    width: 100%;
    resize: vertical;
    font: inherit;
    padding: 8px 10px;
    line-height: 1.5;
  }
  .statuses {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .status {
    height: 40px;
    padding: 0 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card);
    color: var(--text);
    font: inherit;
    font-size: var(--fs);
    text-align: left;
    cursor: pointer;
  }
  .status:hover {
    background: var(--card-2);
  }
  .status.on {
    border-color: var(--accent-border);
    background: var(--accent-bg);
    color: var(--text-bright);
    font-weight: 600;
  }
  /* Discord's own status colours, so the dot reads the way it does in the app. */
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex: none;
  }
  .dot.online {
    background: #23a55a;
  }
  .dot.idle {
    background: #f0b232;
  }
  .dot.dnd {
    background: #f23f43;
  }
  .dot.invisible {
    background: #80848e;
  }
  .preview {
    position: sticky;
    top: 80px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    box-shadow: var(--shadow-card);
  }
  .banner {
    aspect-ratio: 5 / 2;
    background: var(--card-3) center / cover no-repeat;
  }
  .avatar {
    position: relative;
    width: 88px;
    height: 88px;
    margin: -44px 0 0 16px;
  }
  .avatar img {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    border: 6px solid var(--card);
    background: var(--card);
    object-fit: cover;
  }
  .dot.ring {
    position: absolute;
    right: 2px;
    bottom: 2px;
    width: 22px;
    height: 22px;
    border: 5px solid var(--card);
  }
  .body {
    padding: 8px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .name {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .name b {
    font-size: var(--fs-xl);
    color: var(--text-bright);
    overflow-wrap: anywhere;
  }
  .app {
    padding: 1px 5px;
    border-radius: 4px;
    background: #5865f2;
    color: #fff;
    font-size: 10px;
    font-weight: 700;
  }
  .custom {
    font-size: var(--fs);
    color: var(--text-soft);
    overflow-wrap: anywhere;
  }
  .about {
    padding: 12px;
    border-radius: var(--radius);
    background: var(--card-2);
  }
  .about span {
    font-size: var(--fs-xs);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .about p {
    margin: 6px 0 0;
    font-size: var(--fs);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .unsaved {
    position: fixed;
    left: 50%;
    bottom: 20px;
    transform: translateX(-50%);
    width: min(720px, calc(100vw - 32px));
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 10px 10px 16px;
    border-radius: var(--radius-lg);
    background: #111214;
    color: #f2f3f5;
    font-weight: 500;
    box-shadow: var(--shadow-pop);
    z-index: 20;
  }
  .unsaved span {
    flex: 1;
  }
  .btn.reset {
    border: 0;
    background: none;
    color: #f2f3f5;
  }
  .btn.reset:hover:not(:disabled) {
    background: none;
    text-decoration: underline;
  }
  .btn.save {
    border: 0;
    background: #248046;
    color: #fff;
  }
  .btn.save:hover:not(:disabled) {
    background: #1a6334;
  }
  @media (max-width: 1100px) {
    .bot {
      grid-template-columns: minmax(0, 1fr);
    }
    .preview {
      position: static;
      order: -1;
      max-width: 340px;
    }
  }
  @media (max-width: 640px) {
    .item {
      grid-template-columns: 1fr;
      gap: 10px;
    }
    .ctl {
      justify-content: flex-start;
    }
    .statuses {
      grid-template-columns: 1fr;
    }
    .unsaved span {
      font-size: var(--fs-sm);
    }
  }
</style>
