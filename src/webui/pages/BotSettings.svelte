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
    ArrowUpRight,
  } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import PageHeader from '../components/PageHeader.svelte';

  // Which settings live in which section; unknown server keys fall into "other" so none vanish.
  const SECTIONS = [
    {
      id: 'delivery',
      label: 'Delivery',
      icon: Share2,
      blurb: 'How the bot hands files back to Discord',
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
      blurb: 'How long uploads live in R2 and how much it may hold',
      keys: ['upload_ttl_tiers', 'r2_soft_limit_gb', 'admin_uploads_expire'],
    },
    {
      id: 'access',
      label: 'Access and moderation',
      icon: ShieldCheck,
      blurb: 'Who may use the bot and when it stops taking work',
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
      blurb: 'Where failures and alerts are pushed',
      keys: ['ntfy_topic', 'ntfy_server'],
    },
    {
      id: 'presence',
      label: 'Bot presence',
      icon: Activity,
      blurb: 'What Discord shows next to the bot',
      keys: [],
      presence: true,
    },
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
  let drafts = $state({});
  let tierDrafts = $state({});
  let toast = $state('');
  let toastTimer;

  const sections = $derived.by(() => {
    const grouped = new Set(SECTIONS.flatMap(s => s.keys));
    const other = Object.keys(settings).filter(
      k => !grouped.has(k) && !ELSEWHERE.has(settings[k].type)
    );
    return [
      ...SECTIONS,
      ...(other.length
        ? [{ id: 'other', label: 'Other', icon: SlidersHorizontal, keys: other, blurb: '' }]
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

  function say(text) {
    toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), 2000);
  }

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
      say(`${label(key)} saved`);
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
    if (res?.ok) {
      say('Presence updated');
      loadPresence();
    } else error = data.error || data.message || 'could not update presence';
  }
  loadPresence();
  const presenceDirty = $derived(
    presence &&
      (presenceStatus !== presence.status || presenceActivity.trim() !== (presence.activity ?? ''))
  );
</script>

<PageHeader title="Settings" description="Changes apply within a minute">
  {#snippet actions()}
    {#if error}<span class="pill bad">{error}</span>{/if}
  {/snippet}
</PageHeader>

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
      ><Globe size={15} strokeWidth={1.8} /><span>Sources</span><span class="arrow"
        ><ArrowUpRight size={13} /></span
      ></button
    >
  </nav>

  <section class="panel content" aria-label={active.label}>
    <div class="ph">
      <span>{active.label}</span>
      {#if active.blurb}<span class="sub">{active.blurb}</span>{/if}
    </div>
    {#if loading}
      <div class="skel-rows">
        {#each Array(4) as _, i (i)}<span class="skeleton" style="width:{60 - i * 8}%"
          ></span>{/each}
      </div>
    {:else if active.presence}
      <div class="item">
        <div class="lbl">
          <b>Current presence</b>
          <p>What Discord shows right now</p>
        </div>
        <div class="ctl">
          <span
            class="pill"
            class:ok={presence?.status === 'online'}
            class:idle={presence?.status !== 'online'}
            >{presence
              ? `${presence.botTag ?? 'bot'} · ${presence.status}${presence.activity ? ` · ${presence.activity}` : ''}`
              : 'unavailable'}</span
          >
        </div>
      </div>
      <div class="item">
        <div class="lbl">
          <b>Status</b>
          <p>The dot next to the bot's name</p>
        </div>
        <div class="ctl">
          <div class="seg">
            {#each STATUS_OPTIONS as o (o)}<button
                class:on={presenceStatus === o}
                onclick={() => (presenceStatus = o)}>{o}</button
              >{/each}
          </div>
        </div>
      </div>
      <div class="item">
        <div class="lbl">
          <b>Custom status</b>
          <p>Leave empty for none. Survives restarts.</p>
        </div>
        <div class="ctl">
          <input
            class="field wide"
            bind:value={presenceActivity}
            maxlength="128"
            placeholder="e.g. web.gronka.dev"
          />
        </div>
      </div>
      <div class="pf foot">
        <span class="dim">{presenceDirty ? 'Unsaved changes' : 'Up to date'}</span>
        <button
          class="btn primary right"
          disabled={presenceSaving || !presenceDirty}
          onclick={savePresence}>Apply</button
        >
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
              <span class="small muted">{s.value === 'true' ? 'On' : 'Off'}</span>
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
                {#if s.min !== undefined}<span class="dim small nowrap">{s.min}–{s.max}</span>{/if}
                {#if String(drafts[key]) !== String(s.value)}<button
                    class="btn primary sm"
                    disabled={saving[key]}><Check size={12} />Save</button
                  >{/if}
              </form>
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
                      class="icon-btn sm"
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
                      onclick={() => save(key, serializeTiers(tierDrafts[key]))}
                      ><Check size={12} />Save</button
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
                  <input class="field mono" name="value" placeholder="Add an id" />
                  <button class="btn sm" disabled={saving[key]}><Plus size={12} />Add</button>
                </form>
              </div>
            {:else}
              <span class="mono dim small">{s.value}</span>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </section>
</div>

{#if toast}<div class="toast" role="status"><Check size={14} />{toast}</div>{/if}

<style>
  .settings {
    display: grid;
    grid-template-columns: 200px minmax(0, 720px);
    gap: var(--gap-lg);
    align-items: start;
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 2px;
    position: sticky;
    top: 80px;
  }
  .sec {
    height: 34px;
    padding: 0 10px;
    display: flex;
    align-items: center;
    gap: 10px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--text-soft);
    font: inherit;
    font-size: var(--fs);
    font-weight: 500;
    text-align: left;
    cursor: pointer;
  }
  .sec :global(svg) {
    color: var(--text-muted);
  }
  .sec:hover {
    background: var(--card-3);
    color: var(--text-bright);
  }
  .sec.on {
    background: var(--card-3);
    color: var(--text-bright);
    font-weight: 600;
  }
  .sec.on :global(svg) {
    color: var(--text-bright);
  }
  .arrow {
    margin-left: auto;
    color: var(--text-dim);
    display: flex;
  }
  .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(220px, 300px);
    gap: 24px;
    padding: 16px;
    border-top: 1px solid var(--line);
    align-items: center;
  }
  .item:hover {
    background: var(--card-2);
  }
  .ph + .item {
    border-top: 0;
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
    gap: 10px;
    justify-content: flex-end;
  }
  .ctl .row {
    justify-content: flex-end;
  }
  .field.wide {
    width: 100%;
  }
  .field[type='number'] {
    width: 100px;
  }
  .num-in {
    width: 76px !important;
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
    justify-content: flex-end;
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
    color: var(--danger-text);
  }
  .foot {
    background: var(--card-2);
    border-radius: 0 0 var(--radius-lg) var(--radius-lg);
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
    .ctl,
    .ctl .row,
    .chips {
      justify-content: flex-start;
    }
  }
</style>
