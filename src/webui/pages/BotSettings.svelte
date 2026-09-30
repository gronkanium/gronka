<script>
  import {
    Share2,
    HardDrive,
    ShieldCheck,
    Bell,
    Activity,
    SlidersHorizontal,
    Globe,
    Plus,
    X,
    Check,
  } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import { useHeaderActions } from '../stores/header.js';

  // Which settings live in which section; unknown server keys fall into "other" so none vanish.
  const SECTIONS = [
    {
      id: 'delivery',
      label: 'Delivery',
      icon: Share2,
      keys: [
        'url_only_mode',
        'twitter_delivery',
        'twitter_direct_url_fallback',
        'max_video_size_mb',
        'max_video_duration',
      ],
    },
    {
      id: 'storage',
      label: 'Limits and storage',
      icon: HardDrive,
      keys: ['upload_ttl_tiers', 'r2_soft_limit_gb', 'admin_uploads_expire'],
    },
    {
      id: 'access',
      label: 'Access and moderation',
      icon: ShieldCheck,
      keys: [
        'maintenance_mode',
        'queue_paused',
        'moderation_enabled',
        'rate_limit_cooldown',
        'admin_user_ids',
      ],
    },
    {
      id: 'notifications',
      label: 'Notifications',
      icon: Bell,
      keys: ['ntfy_topic', 'ntfy_server'],
    },
    { id: 'presence', label: 'Bot presence', icon: Activity, keys: [], presence: true },
  ];
  // Edited on their own pages, not here.
  const ELSEWHERE = new Set(['services', 'views', 'issuestates']);
  const LABELS = {
    url_only_mode: 'Reply with links only',
    twitter_delivery: 'X / Twitter delivery',
    twitter_direct_url_fallback: 'X / Twitter link fallback',
    max_video_size_mb: 'Max download size (MB)',
    max_video_duration: 'Max video duration',
    upload_ttl_tiers: 'Upload lifetime tiers',
    r2_soft_limit_gb: 'R2 soft limit (GB)',
    admin_uploads_expire: 'Admin uploads expire',
    maintenance_mode: 'Maintenance mode',
    queue_paused: 'Pause media queue',
    moderation_enabled: 'Enforce bans',
    rate_limit_cooldown: 'Rate limit cooldown (s)',
    admin_user_ids: 'Admins',
    ntfy_topic: 'ntfy topic',
    ntfy_server: 'ntfy server',
  };
  const label = key => LABELS[key] ?? key.replace(/_/g, ' ');

  let settings = $state({});
  let loading = $state(true);
  let error = $state('');
  let saving = $state({});
  let saved = $state({});
  let drafts = $state({});
  let tierDrafts = $state({});

  const sections = $derived.by(() => {
    const grouped = new Set(SECTIONS.flatMap(s => s.keys));
    const other = Object.keys(settings).filter(
      k => !grouped.has(k) && !ELSEWHERE.has(settings[k].type)
    );
    return [
      ...SECTIONS,
      ...(other.length
        ? [{ id: 'other', label: 'Other', icon: SlidersHorizontal, keys: other }]
        : []),
    ];
  });
  const active = $derived(
    sections.find(s => s.id === $currentRoute.params.$section) ?? sections[0]
  );
  const activeKeys = $derived(active.keys.filter(k => settings[k]));

  const parseTiers = v =>
    String(v || '')
      .split(',')
      .map(p => p.trim().split(':').map(Number))
      .filter(([mb, h]) => Number.isFinite(mb) && Number.isFinite(h))
      .map(([mb, hours]) => ({ mb, hours }));
  const cleanTiers = rows =>
    rows
      .map(r => ({ mb: Math.floor(Number(r.mb)), hours: Math.floor(Number(r.hours)) }))
      .filter(r => r.mb > 0 && r.hours > 0)
      .sort((a, b) => a.mb - b.mb);
  const serializeTiers = rows =>
    cleanTiers(rows)
      .map(r => `${r.mb}:${r.hours}`)
      .join(',');
  const tierPreview = rows => {
    const t = cleanTiers(rows);
    return t.length
      ? [...t.map(r => `≤${r.mb} MB → ${r.hours}h`), `larger → ${t.at(-1).hours}h`].join('  ·  ')
      : '';
  };
  const listValues = s => {
    try {
      const v = JSON.parse(s.value);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };

  async function load() {
    loading = true;
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      settings = (await res.json()).settings;
      drafts = Object.fromEntries(Object.entries(settings).map(([k, s]) => [k, s.value]));
      tierDrafts = Object.fromEntries(
        Object.entries(settings)
          .filter(([, s]) => s.type === 'tiers')
          .map(([k, s]) => [k, parseTiers(s.value)])
      );
    } catch (err) {
      error = err.message || 'failed to load settings';
    } finally {
      loading = false;
    }
  }
  load();

  async function save(key, value) {
    saving[key] = true;
    error = '';
    try {
      const res = await fetch(`/api/settings/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      settings[key].value = data.value;
      drafts[key] = data.value;
      if (settings[key].type === 'tiers') tierDrafts[key] = parseTiers(data.value);
      saved[key] = true;
      setTimeout(() => (saved[key] = false), 1600);
    } catch (err) {
      error = `${label(key)}: ${err.message}`;
    } finally {
      saving[key] = false;
    }
  }

  function addListItem(key, e) {
    e.preventDefault();
    const input = e.currentTarget.elements.value;
    const item = input.value.trim();
    const items = listValues(settings[key]);
    if (item && !items.includes(item) && !(settings[key].envValues || []).includes(item))
      save(key, [...items, item]);
    input.value = '';
  }

  // Presence lives on /api/bot/status, not in bot_settings.
  const STATUS_OPTIONS = ['online', 'idle', 'dnd', 'invisible'];
  let presence = $state(null);
  let presenceStatus = $state('online');
  let presenceActivity = $state('');
  let presenceMsg = $state('');
  let presenceSaving = $state(false);
  async function loadPresence() {
    presence = await fetch('/api/bot/status')
      .then(r => r.json())
      .catch(() => null);
    if (presence?.status) presenceStatus = presence.status;
    presenceActivity = presence?.activity ?? '';
  }
  async function savePresence() {
    presenceSaving = true;
    presenceMsg = '';
    const res = await fetch('/api/bot/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: presenceStatus,
        activity: presenceActivity.trim() || undefined,
      }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    presenceSaving = false;
    presenceMsg = res?.ok ? 'updated' : data.error || data.message || 'could not update presence';
    if (res?.ok) loadPresence();
  }
  loadPresence();

  useHeaderActions(actions);
</script>

{#snippet actions()}
  {#if error}<span class="error-text small">{error}</span>{/if}
{/snippet}

<div class="settings">
  <nav class="side" aria-label="settings sections">
    {#each sections as s (s.id)}
      {@const Icon = s.icon}
      <button
        class="sec"
        class:on={active.id === s.id}
        onclick={() => navigate('settings', { section: s.id })}
      >
        <Icon size={15} strokeWidth={1.8} /><span>{s.label}</span>
      </button>
    {/each}
    <button class="sec" onclick={() => navigate('sources')}
      ><Globe size={15} strokeWidth={1.8} /><span>Download sources</span><span class="arrow">↗</span
      ></button
    >
  </nav>

  <section class="panel content" aria-label={active.label}>
    <div class="ph"><span>{active.label}</span></div>
    {#if loading}
      <div class="empty">loading…</div>
    {:else if active.presence}
      <div class="item">
        <div class="lbl">
          <b>Current presence</b>
          <p>
            {presence
              ? `${presence.botTag ?? 'bot'} · ${presence.status}${presence.activity ? ` · ${presence.activity}` : ''}`
              : 'unavailable'}
          </p>
        </div>
      </div>
      <div class="item">
        <div class="lbl">
          <b>Status</b>
          <p>What Discord shows next to the bot.</p>
        </div>
        <div class="seg">
          {#each STATUS_OPTIONS as o (o)}<button
              class:on={presenceStatus === o}
              onclick={() => (presenceStatus = o)}>{o}</button
            >{/each}
        </div>
      </div>
      <div class="item">
        <div class="lbl">
          <b>Custom status</b>
          <p>Leave empty for none. Survives restarts.</p>
        </div>
        <div class="row ctl">
          <input
            class="field wide"
            bind:value={presenceActivity}
            maxlength="128"
            placeholder="e.g. web.gronka.dev"
          />
          <button class="btn primary" disabled={presenceSaving} onclick={savePresence}>Apply</button
          >
          {#if presenceMsg}<span class="dim small">{presenceMsg}</span>{/if}
        </div>
      </div>
    {:else}
      {#each activeKeys as key (key)}
        {@const s = settings[key]}
        <div class="item">
          <div class="lbl">
            <b>{label(key)}</b>
            <p>{s.description}</p>
          </div>
          <div class="ctl">
            {#if s.type === 'boolean'}
              <button
                class="toggle"
                class:on={s.value === 'true'}
                role="switch"
                aria-checked={s.value === 'true'}
                aria-label={label(key)}
                disabled={saving[key]}
                onclick={() => save(key, s.value !== 'true')}
              ></button>
            {:else if s.type === 'select'}
              <select
                class="field"
                value={s.value}
                disabled={saving[key]}
                onchange={e => save(key, e.currentTarget.value)}
              >
                {#each s.options as o (o)}<option value={o}>{o.replace(/_/g, ' ')}</option>{/each}
              </select>
            {:else if s.type === 'number' || s.type === 'string'}
              <form
                class="row"
                onsubmit={e => {
                  e.preventDefault();
                  save(key, drafts[key]);
                }}
              >
                <input
                  class="field"
                  class:wide={s.type === 'string'}
                  type={s.type === 'number' ? 'number' : 'text'}
                  min={s.min}
                  max={s.max}
                  bind:value={drafts[key]}
                />
                {#if String(drafts[key]) !== String(s.value)}<button
                    class="btn primary"
                    disabled={saving[key]}>Save</button
                  >{/if}
              </form>
              {#if s.min !== undefined}<span class="dim small">{s.min}–{s.max}</span>{/if}
            {:else if s.type === 'tiers'}
              <div class="tiers">
                {#each tierDrafts[key] ?? [] as row, i (i)}
                  <div class="row">
                    <span class="dim small">up to</span>
                    <input class="field num-in" type="number" min="1" bind:value={row.mb} /><span
                      class="dim small">MB for</span
                    >
                    <input class="field num-in" type="number" min="1" bind:value={row.hours} /><span
                      class="dim small">hours</span
                    >
                    <button
                      class="iconbtn"
                      aria-label="remove tier"
                      onclick={() => (tierDrafts[key] = tierDrafts[key].filter((_, j) => j !== i))}
                      ><X size={13} /></button
                    >
                  </div>
                {/each}
                <div class="row">
                  <button
                    class="btn sm"
                    onclick={() =>
                      (tierDrafts[key] = [...(tierDrafts[key] ?? []), { mb: '', hours: '' }])}
                    ><Plus size={12} />Add tier</button
                  >
                  {#if serializeTiers(tierDrafts[key] ?? []) !== s.value}
                    <button
                      class="btn primary sm"
                      disabled={saving[key] || !serializeTiers(tierDrafts[key] ?? [])}
                      onclick={() => save(key, serializeTiers(tierDrafts[key]))}>Save</button
                    >
                  {/if}
                </div>
                <div class="dim small mono">{tierPreview(tierDrafts[key] ?? [])}</div>
              </div>
            {:else if s.type === 'list'}
              <div class="list">
                <div class="chips">
                  {#each s.envValues ?? [] as v (v)}<span
                      class="chip mono"
                      title="set in .env, read-only">{v} · env</span
                    >{/each}
                  {#each listValues(s) as v (v)}
                    <span class="chip mono"
                      >{v}<button
                        class="x"
                        aria-label={`remove ${v}`}
                        disabled={saving[key]}
                        onclick={() =>
                          save(
                            key,
                            listValues(s).filter(i => i !== v)
                          )}><X size={11} /></button
                      ></span
                    >
                  {/each}
                </div>
                <form class="row" onsubmit={e => addListItem(key, e)}>
                  <input class="field mono" name="value" placeholder="add an id" />
                  <button class="btn sm" disabled={saving[key]}><Plus size={12} />Add</button>
                </form>
              </div>
            {:else}
              <span class="mono dim small">{s.value}</span>
            {/if}
            {#if saved[key]}<span class="saved"><Check size={13} />saved</span>{/if}
          </div>
        </div>
      {/each}
    {/if}
  </section>
</div>

<style>
  .settings {
    max-width: 1200px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }
  .small {
    font-size: 12px;
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 2px;
    position: sticky;
    top: 76px;
  }
  .sec {
    height: 34px;
    padding: 0 10px;
    display: flex;
    align-items: center;
    gap: 10px;
    border: 0;
    border-radius: 7px;
    background: none;
    color: #a9abb1;
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .sec:hover {
    background: var(--surface);
    color: var(--text-bright);
  }
  .sec.on {
    background: var(--surface-2);
    color: var(--text-bright);
  }
  .arrow {
    margin-left: auto;
    color: var(--text-dim);
  }
  .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 1.1fr);
    gap: 24px;
    padding: 18px 20px;
    border-top: 1px solid var(--line);
  }
  .item:first-of-type {
    border-top: 0;
  }
  .lbl b {
    font-weight: 500;
    font-size: 13px;
    color: var(--text-bright);
  }
  .lbl p {
    margin: 4px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-muted);
  }
  .ctl {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    align-self: center;
  }
  .field.wide {
    width: 260px;
  }
  .field[type='number'] {
    width: 110px;
  }
  .num-in {
    width: 80px !important;
  }
  .tiers,
  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip .x {
    display: flex;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
  }
  .chip .x:hover {
    color: var(--danger);
  }
  .iconbtn {
    display: flex;
    padding: 4px;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
  }
  .iconbtn:hover {
    color: var(--danger);
    background: var(--surface-2);
  }
  .saved {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--success);
  }
  @media (max-width: 860px) {
    .settings {
      grid-template-columns: 1fr;
    }
    .side {
      position: static;
      flex-direction: row;
      overflow-x: auto;
    }
    .sec span {
      white-space: nowrap;
    }
    .item {
      grid-template-columns: 1fr;
      gap: 10px;
    }
  }
</style>
