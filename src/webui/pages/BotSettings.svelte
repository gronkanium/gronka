<script>
  import { onMount } from 'svelte';
  import {
    Share2,
    HardDrive,
    ShieldCheck,
    Bell,
    Activity,
    SlidersHorizontal,
    Plus,
    Trash2,
    Check,
    Globe,
  } from 'lucide-svelte';

  let settings = {};
  let loading = true;
  let error = null;
  let saving = {};
  let justSaved = {};

  // Structured drafts for the tier editor, keyed by setting name. Kept separate from `settings`
  // so the user can add/edit/remove rows freely and only commit on Save.
  let tierDrafts = {};

  // Which settings live under which tab. Order here is the tab order. Any known setting not
  // listed falls into an auto "other" tab (below) so a new server-side key never disappears.
  const TAB_GROUPS = [
    {
      id: 'delivery',
      label: 'delivery',
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
      label: 'storage',
      icon: HardDrive,
      keys: ['upload_ttl_tiers', 'r2_soft_limit_gb', 'admin_uploads_expire'],
    },
    {
      id: 'sources',
      label: 'sources',
      icon: Globe,
      keys: ['disabled_services'],
    },
    {
      id: 'access',
      label: 'access',
      icon: ShieldCheck,
      keys: ['maintenance_mode', 'moderation_enabled', 'rate_limit_cooldown', 'admin_user_ids'],
    },
    {
      id: 'notifications',
      label: 'notifications',
      icon: Bell,
      keys: ['ntfy_topic', 'ntfy_server'],
    },
    // Presence has no bot_settings keys — it drives its own /api/bot/status endpoint.
    { id: 'presence', label: 'presence', icon: Activity, keys: [], presence: true },
  ];

  const TAB_STORAGE_KEY = 'gronka:settings-tab';
  let activeTab = 'delivery';

  function loadActiveTab() {
    try {
      const stored = localStorage.getItem(TAB_STORAGE_KEY);
      if (stored && TAB_GROUPS.some(g => g.id === stored)) {
        activeTab = stored;
      }
    } catch {
      // storage unavailable — default tab stays
    }
  }

  function selectTab(id) {
    activeTab = id;
    try {
      localStorage.setItem(TAB_STORAGE_KEY, id);
    } catch {
      // ignore
    }
  }

  // Everything known to the grouped tabs; leftovers get an auto "other" tab.
  $: groupedKeys = new Set(TAB_GROUPS.flatMap(g => g.keys));
  $: otherKeys = Object.keys(settings).filter(k => !groupedKeys.has(k));
  $: tabs = [
    ...TAB_GROUPS,
    ...(otherKeys.length
      ? [{ id: 'other', label: 'other', icon: SlidersHorizontal, keys: otherKeys }]
      : []),
  ];
  $: activeGroup = tabs.find(t => t.id === activeTab) || tabs[0];
  $: activeKeys = (activeGroup?.keys || []).filter(k => settings[k]);

  const STATUS_OPTIONS = ['online', 'idle', 'dnd', 'invisible'];
  let presenceStatus = 'online';
  let presenceActivity = '';
  let presenceSaving = false;
  let presenceError = null;
  let presenceMessage = null;
  let currentPresence = null;
  let currentPresenceLoading = true;

  async function loadPresence() {
    currentPresenceLoading = true;
    try {
      const response = await fetch('/api/bot/status');
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || data.message || `HTTP error! status: ${response.status}`);
      }
      currentPresence = data;
      presenceStatus = data.status || presenceStatus;
      presenceActivity = data.activity || '';
    } catch (err) {
      console.error('Failed to fetch bot presence:', err);
    } finally {
      currentPresenceLoading = false;
    }
  }

  async function updatePresence() {
    presenceSaving = true;
    presenceError = null;
    presenceMessage = null;
    try {
      const response = await fetch('/api/bot/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: presenceStatus,
          activity: presenceActivity.trim() || undefined,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || data.message || `HTTP error! status: ${response.status}`);
      }
      presenceMessage = data.activity
        ? `status set to "${data.status}" with activity "${data.activity}"`
        : `status set to "${data.status}"`;
      await loadPresence();
    } catch (err) {
      console.error('Failed to update bot presence:', err);
      presenceError = err.message || 'failed to update bot presence';
    } finally {
      presenceSaving = false;
    }
  }

  async function loadSettings() {
    loading = true;
    error = null;
    try {
      const response = await fetch('/api/settings');
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      settings = data.settings || {};
      syncTierDrafts();
    } catch (err) {
      console.error('Failed to fetch settings:', err);
      error = 'failed to load settings';
    } finally {
      loading = false;
    }
  }

  // ---- tier editor helpers ----------------------------------------------------------------

  // Parse the stored "MB:hours,MB:hours" string into editable rows.
  function parseTierRows(value) {
    return String(value || '')
      .split(',')
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => {
        const [mb, hours] = p.split(':');
        return { mb: Number(mb), hours: Number(hours) };
      })
      .filter(r => Number.isFinite(r.mb) && Number.isFinite(r.hours));
  }

  // Rows -> canonical "MB:hours" string (ascending by MB, dropping incomplete rows).
  function serializeTiers(rows) {
    return rows
      .map(r => ({ mb: Math.floor(Number(r.mb)), hours: Math.floor(Number(r.hours)) }))
      .filter(r => r.mb > 0 && r.hours > 0)
      .sort((a, b) => a.mb - b.mb)
      .map(r => `${r.mb}:${r.hours}`)
      .join(',');
  }

  function syncTierDrafts() {
    const drafts = {};
    for (const [key, setting] of Object.entries(settings)) {
      if (setting.type === 'tiers') {
        drafts[key] = parseTierRows(setting.value);
      }
    }
    tierDrafts = drafts;
  }

  function updateTierRow(key, idx, field, val) {
    const rows = tierDrafts[key].map((r, i) => (i === idx ? { ...r, [field]: val } : r));
    tierDrafts = { ...tierDrafts, [key]: rows };
  }

  function addTierRow(key) {
    tierDrafts = { ...tierDrafts, [key]: [...(tierDrafts[key] || []), { mb: '', hours: '' }] };
  }

  function removeTierRow(key, idx) {
    tierDrafts = { ...tierDrafts, [key]: tierDrafts[key].filter((_, i) => i !== idx) };
  }

  function tierDirty(key) {
    return serializeTiers(tierDrafts[key] || []) !== settings[key].value;
  }

  // Human-readable summary of the draft, matching how the bot applies the curve.
  function tierPreview(rows) {
    const sorted = rows
      .map(r => ({ mb: Math.floor(Number(r.mb)), hours: Math.floor(Number(r.hours)) }))
      .filter(r => r.mb > 0 && r.hours > 0)
      .sort((a, b) => a.mb - b.mb);
    if (sorted.length === 0) {
      return '';
    }
    const parts = sorted.map(r => `≤${r.mb} MB → ${r.hours}h`);
    const last = sorted[sorted.length - 1];
    parts.push(`larger → ${last.hours}h`);
    return parts.join('  ·  ');
  }

  async function saveTiers(key) {
    const str = serializeTiers(tierDrafts[key] || []);
    if (!str) {
      error = 'add at least one tier with a size and a duration';
      return;
    }
    await saveSetting(key, str);
    // Re-sync from the normalized value the server stored (canonical order).
    tierDrafts = { ...tierDrafts, [key]: parseTierRows(settings[key].value) };
  }

  // ---- generic setting save ---------------------------------------------------------------

  function flashSaved(key) {
    justSaved = { ...justSaved, [key]: true };
    setTimeout(() => {
      justSaved = { ...justSaved, [key]: false };
    }, 1600);
  }

  async function toggleSetting(key) {
    const current = settings[key];
    const newValue = current.value !== 'true';
    await saveSetting(key, newValue);
  }

  // ---- services (download-source) toggles ----
  // Section order + display labels for the grouped service list.
  const SERVICE_CATEGORIES = [
    { id: 'social', label: 'social' },
    { id: 'video', label: 'video' },
    { id: 'adult', label: 'adult' },
    { id: 'booru', label: 'booru' },
  ];

  function disabledServiceSet(setting) {
    try {
      return new Set(JSON.parse(setting.value || '[]'));
    } catch {
      return new Set();
    }
  }

  function servicesInCategory(setting, categoryId) {
    return (setting.catalog || []).filter(svc => svc.category === categoryId);
  }

  async function toggleService(key, id) {
    const disabled = disabledServiceSet(settings[key]);
    if (disabled.has(id)) {
      disabled.delete(id);
    } else {
      disabled.add(id);
    }
    // The `services` setting stores the DISABLED ids; a service is "on" when absent.
    await saveSetting(key, [...disabled]);
  }

  async function saveSetting(key, value) {
    const current = settings[key];
    saving = { ...saving, [key]: true };
    error = null;
    try {
      const response = await fetch(`/api/settings/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || `HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      settings = {
        ...settings,
        [key]: { ...current, value: data.value },
      };
      flashSaved(key);
    } catch (err) {
      console.error(`Failed to update setting ${key}:`, err);
      error = err.message || `failed to update ${key.replace(/_/g, ' ')}`;
    } finally {
      saving = { ...saving, [key]: false };
    }
  }

  function handleTextSubmit(key, inputValue) {
    saveSetting(key, inputValue);
  }

  function listValues(setting) {
    try {
      const parsed = JSON.parse(setting.value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async function addListItem(key, form) {
    const item = form.elements.value.value.trim();
    if (!item) {
      return;
    }
    const items = listValues(settings[key]);
    if (items.includes(item) || (settings[key].envValues || []).includes(item)) {
      form.reset();
      return;
    }
    await saveSetting(key, [...items, item]);
    form.reset();
  }

  async function removeListItem(key, item) {
    await saveSetting(
      key,
      listValues(settings[key]).filter(i => i !== item)
    );
  }

  function labelFor(key) {
    return key.replace(/_/g, ' ');
  }

  onMount(() => {
    loadActiveTab();
    loadSettings();
    loadPresence();
  });
</script>

<div class="settings-page">
  <nav class="tab-bar" aria-label="settings sections">
    {#each tabs as tab (tab.id)}
      {@const Icon = tab.icon}
      <button
        class="tab"
        class:active={activeTab === tab.id}
        on:click={() => selectTab(tab.id)}
        aria-current={activeTab === tab.id ? 'true' : undefined}
      >
        <Icon size={16} />
        <span>{tab.label}</span>
      </button>
    {/each}
  </nav>

  {#if error}
    <p class="status error">{error}</p>
  {/if}

  {#if loading}
    <p class="status">loading settings...</p>
  {:else if activeGroup?.presence}
    <!-- Presence tab: drives /api/bot/status, not bot_settings -->
    <div class="card">
      <div class="setting-info">
        <span class="setting-name">bot presence</span>
        <span class="setting-description"
          >change the bot's Discord status and activity text on the fly</span
        >
        {#if currentPresenceLoading}
          <span class="current-presence">checking current status...</span>
        {:else if currentPresence}
          <span class="current-presence">
            currently: <span
              class="presence-dot"
              class:online={currentPresence.status === 'online'}
              class:idle={currentPresence.status === 'idle'}
              class:dnd={currentPresence.status === 'dnd'}
              class:invisible={currentPresence.status === 'invisible'}
            ></span>
            {currentPresence.status}{currentPresence.activity
              ? ` — ${currentPresence.activity}`
              : ''}
          </span>
        {:else}
          <span class="current-presence">unable to load current status</span>
        {/if}
      </div>
      <form class="presence-form" on:submit|preventDefault={updatePresence}>
        <select bind:value={presenceStatus} disabled={presenceSaving} aria-label="Bot status">
          {#each STATUS_OPTIONS as option (option)}
            <option value={option}>{option}</option>
          {/each}
        </select>
        <input
          type="text"
          placeholder="activity text (optional)"
          bind:value={presenceActivity}
          disabled={presenceSaving}
          aria-label="Bot activity text"
        />
        <button type="submit" class="btn primary" disabled={presenceSaving}>
          {presenceSaving ? 'updating...' : 'update'}
        </button>
      </form>
      {#if presenceError}
        <p class="status error">{presenceError}</p>
      {:else if presenceMessage}
        <p class="status success">{presenceMessage}</p>
      {/if}
    </div>
  {:else if activeKeys.length === 0}
    <p class="status">no settings in this section</p>
  {:else}
    {#each activeKeys as key (key)}
      {@const setting = settings[key]}
      {@const stacked =
        setting.type === 'list' || setting.type === 'tiers' || setting.type === 'services'}
      <div class="card setting-row" class:stacked>
        <div class="setting-info">
          <span class="setting-name">
            {labelFor(key)}
            {#if justSaved[key]}<span class="saved-flag"><Check size={13} /> saved</span>{/if}
          </span>
          <span class="setting-description">{setting.description}</span>
        </div>

        {#if setting.type === 'tiers'}
          <div class="tier-editor">
            <table class="tier-table">
              <thead>
                <tr>
                  <th>up to (MB)</th>
                  <th>keep for (hours)</th>
                  <th aria-label="actions"></th>
                </tr>
              </thead>
              <tbody>
                {#each tierDrafts[key] || [] as row, idx}
                  <tr>
                    <td>
                      <input
                        type="number"
                        min="1"
                        max="999999"
                        step="1"
                        value={row.mb}
                        disabled={saving[key]}
                        on:input={e => updateTierRow(key, idx, 'mb', e.target.value)}
                        aria-label="size ceiling in megabytes"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="1"
                        max="99999"
                        step="1"
                        value={row.hours}
                        disabled={saving[key]}
                        on:input={e => updateTierRow(key, idx, 'hours', e.target.value)}
                        aria-label="retention in hours"
                      />
                    </td>
                    <td class="tier-remove">
                      <button
                        class="icon-btn"
                        title="remove tier"
                        aria-label="remove tier"
                        disabled={saving[key]}
                        on:click={() => removeTierRow(key, idx)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>

            {#if tierPreview(tierDrafts[key] || [])}
              <p class="tier-preview">{tierPreview(tierDrafts[key] || [])}</p>
            {:else}
              <p class="tier-preview muted">no tiers — files use the built-in default curve</p>
            {/if}

            <div class="tier-actions">
              <button class="btn ghost" disabled={saving[key]} on:click={() => addTierRow(key)}>
                <Plus size={15} /> add tier
              </button>
              <button
                class="btn primary"
                disabled={saving[key] || !tierDirty(key)}
                on:click={() => saveTiers(key)}
              >
                {saving[key] ? 'saving...' : 'save tiers'}
              </button>
            </div>
          </div>
        {:else if setting.type === 'list'}
          <div class="list-editor">
            {#if (setting.envValues || []).length === 0 && listValues(setting).length === 0}
              <p class="list-empty">no entries</p>
            {:else}
              <table class="list-table">
                <tbody>
                  {#each setting.envValues || [] as item (item)}
                    <tr>
                      <td class="list-value">{item}</td>
                      <td class="list-action"><span class="badge">from env</span></td>
                    </tr>
                  {/each}
                  {#each listValues(setting) as item (item)}
                    <tr>
                      <td class="list-value">{item}</td>
                      <td class="list-action">
                        <button
                          class="icon-btn"
                          title="remove"
                          aria-label="remove {item}"
                          disabled={saving[key]}
                          on:click={() => removeListItem(key, item)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
            <form class="inline-form" on:submit|preventDefault={e => addListItem(key, e.target)}>
              <input
                type="text"
                name="value"
                placeholder="discord user id"
                disabled={saving[key]}
                aria-label={`Add to ${labelFor(key)}`}
              />
              <button type="submit" class="btn ghost" disabled={saving[key]}>
                <Plus size={15} /> add
              </button>
            </form>
          </div>
        {:else if setting.type === 'services'}
          {@const off = disabledServiceSet(setting)}
          <div class="services-editor">
            {#each SERVICE_CATEGORIES as category (category.id)}
              {@const rows = servicesInCategory(setting, category.id)}
              {#if rows.length > 0}
                <div class="service-group">
                  <h4 class="service-group-title">{category.label}</h4>
                  {#each rows as svc (svc.id)}
                    <div class="service-row">
                      <span class="service-label">{svc.label}</span>
                      <button
                        class="toggle"
                        class:on={!off.has(svc.id)}
                        disabled={saving[key]}
                        on:click={() => toggleService(key, svc.id)}
                        aria-label={`Toggle ${svc.label}`}
                        aria-pressed={!off.has(svc.id)}
                      >
                        <span class="toggle-knob"></span>
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
            {/each}
          </div>
        {:else if setting.type === 'boolean'}
          <button
            class="toggle"
            class:on={setting.value === 'true'}
            disabled={saving[key]}
            on:click={() => toggleSetting(key)}
            aria-label={`Toggle ${labelFor(key)}`}
            aria-pressed={setting.value === 'true'}
          >
            <span class="toggle-knob"></span>
          </button>
        {:else if setting.type === 'select'}
          <select
            class="select-setting"
            value={setting.value}
            disabled={saving[key]}
            on:change={e => saveSetting(key, e.target.value)}
            aria-label={labelFor(key)}
          >
            {#each setting.options || [] as option (option)}
              <option value={option}>{option.replace(/_/g, ' ')}</option>
            {/each}
          </select>
        {:else if setting.type === 'number'}
          <form
            class="inline-form"
            on:submit|preventDefault={e =>
              handleTextSubmit(key, Number(e.target.elements.value.value))}
          >
            <input
              type="number"
              name="value"
              value={setting.value}
              min={setting.min}
              max={setting.max}
              step="1"
              disabled={saving[key]}
              aria-label={labelFor(key)}
            />
            <button type="submit" class="btn ghost" disabled={saving[key]}>save</button>
          </form>
        {:else if setting.type === 'string'}
          <form
            class="inline-form"
            on:submit|preventDefault={e => handleTextSubmit(key, e.target.elements.value.value)}
          >
            <input
              type="text"
              name="value"
              value={setting.value}
              disabled={saving[key]}
              aria-label={labelFor(key)}
            />
            <button type="submit" class="btn ghost" disabled={saving[key]}>save</button>
          </form>
        {/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  .settings-page {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 760px;
  }

  .status {
    color: var(--text-muted);
    margin: 0;
  }

  .status.error {
    color: var(--danger);
  }

  .status.success {
    color: var(--success);
  }

  /* ---- tab bar ---- */
  .tab-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 0.25rem;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    padding: 0.55rem 0.85rem;
    margin-bottom: -1px;
    font-size: 0.9rem;
    cursor: pointer;
    transition:
      color 0.15s,
      border-color 0.15s;
  }

  .tab:hover {
    color: var(--text-bright);
  }

  .tab.active {
    color: var(--text-bright);
    border-bottom-color: var(--success);
  }

  /* ---- cards ---- */
  .card {
    background-color: var(--bg-deep);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1rem 1.25rem;
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .setting-row.stacked {
    flex-direction: column;
    align-items: stretch;
  }

  .setting-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .setting-name {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--text-bright);
    font-size: 1rem;
  }

  .setting-description {
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .saved-flag {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    color: var(--success);
    font-size: 0.75rem;
  }

  /* ---- presence ---- */
  .current-presence {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--text-muted);
    font-size: 0.85rem;
    margin-top: 0.25rem;
  }

  .presence-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background-color: var(--text-muted);
    flex-shrink: 0;
  }

  .presence-dot.online {
    background-color: var(--success);
  }

  .presence-dot.idle {
    background-color: #f0b232;
  }

  .presence-dot.dnd {
    background-color: var(--danger);
  }

  .presence-dot.invisible {
    background-color: var(--text-muted);
  }

  .presence-form {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 0.75rem;
  }

  .presence-form select,
  .presence-form input {
    background-color: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-bright);
    padding: 0.4rem 0.6rem;
    font-size: 0.9rem;
  }

  .presence-form input {
    flex: 1;
    min-width: 200px;
  }

  .presence-form select:disabled,
  .presence-form input:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  /* ---- toggle ---- */
  .toggle {
    position: relative;
    width: 48px;
    height: 26px;
    flex-shrink: 0;
    border-radius: 13px;
    border: 1px solid var(--border);
    background-color: var(--surface-2);
    cursor: pointer;
    padding: 0;
    transition:
      background-color 0.2s,
      border-color 0.2s;
  }

  .toggle.on {
    background-color: var(--success);
    border-color: var(--success);
  }

  .toggle:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background-color: var(--text);
    transition: transform 0.2s;
  }

  .toggle.on .toggle-knob {
    transform: translateX(22px);
    background-color: var(--bg-deep);
  }

  /* ---- select ---- */
  .select-setting {
    background-color: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-bright);
    padding: 0.4rem 0.6rem;
    font-size: 0.9rem;
    flex-shrink: 0;
  }

  .select-setting:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  /* ---- inline (number/string/add) forms ---- */
  .inline-form {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .inline-form input {
    background-color: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-bright);
    padding: 0.4rem 0.6rem;
    font-size: 0.9rem;
    width: 200px;
  }

  .inline-form input:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  /* ---- buttons ---- */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.4rem 0.8rem;
    font-size: 0.85rem;
    background-color: var(--surface-3);
    color: var(--text-bright);
    border: 1px solid var(--border-2);
    border-radius: var(--radius);
    cursor: pointer;
    white-space: nowrap;
  }

  .btn:hover:not(:disabled) {
    background-color: var(--border-2);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn.ghost {
    background-color: var(--surface-2);
  }

  .btn.primary {
    background-color: var(--surface-3);
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.3rem;
    background-color: var(--surface-2);
    color: var(--text-muted);
    border: 1px solid var(--border-2);
    border-radius: var(--radius);
    cursor: pointer;
    transition:
      color 0.15s,
      background-color 0.15s;
  }

  .icon-btn:hover:not(:disabled) {
    color: var(--danger);
    background-color: var(--surface-3);
  }

  .icon-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ---- services editor ---- */
  .services-editor {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-top: 0.75rem;
  }

  .service-group-title {
    margin: 0 0 0.35rem;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  .service-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.4rem 0;
    border-top: 1px solid var(--border);
  }

  .service-label {
    font-size: 0.9rem;
    color: var(--text-bright);
  }

  /* ---- list editor ---- */
  .list-editor {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }

  .list-empty {
    color: var(--text-muted);
    font-size: 0.85rem;
    margin: 0;
  }

  .list-table {
    width: 100%;
    border-collapse: collapse;
  }

  .list-table td {
    border-top: 1px solid var(--border);
    padding: 0.4rem 0.25rem;
    font-size: 0.9rem;
  }

  .list-value {
    color: var(--text-bright);
    font-family: monospace;
  }

  .list-action {
    text-align: right;
    width: 1%;
    white-space: nowrap;
  }

  .badge {
    display: inline-block;
    padding: 0.1rem 0.45rem;
    font-size: 0.72rem;
    color: var(--text-muted);
    background-color: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  /* ---- tier editor ---- */
  .tier-editor {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }

  .tier-table {
    width: 100%;
    border-collapse: collapse;
  }

  .tier-table th {
    text-align: left;
    font-weight: 400;
    font-size: 0.78rem;
    color: var(--text-dim);
    padding: 0 0.25rem 0.35rem;
  }

  .tier-table th:last-child {
    width: 1%;
  }

  .tier-table td {
    padding: 0.25rem 0.25rem;
  }

  .tier-table input {
    width: 100%;
    min-width: 0;
    background-color: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-bright);
    padding: 0.4rem 0.6rem;
    font-size: 0.9rem;
  }

  .tier-table input:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  .tier-remove {
    text-align: right;
    white-space: nowrap;
  }

  .tier-preview {
    margin: 0;
    font-size: 0.82rem;
    font-family: monospace;
    color: var(--text-muted);
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.5rem 0.65rem;
    overflow-x: auto;
    white-space: nowrap;
  }

  .tier-preview.muted {
    font-family: inherit;
  }

  .tier-actions {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }

  /* Match the shell's mobile breakpoint (sidebar collapses at 768px) so the page
     switches to its stacked layout at the same width the chrome does. */
  @media (max-width: 767px) {
    .settings-page {
      max-width: 100%;
    }

    /* Controls drop below their label/description instead of squeezing to the right. */
    .setting-row {
      flex-direction: column;
      align-items: stretch;
    }

    .card {
      padding: 0.85rem 0.95rem;
    }

    /* Tabs keep their labels and wrap to as many rows as needed — clearer than
       cryptic icon-only tabs on a phone. */
    .tab {
      padding: 0.5rem 0.7rem;
      font-size: 0.85rem;
      gap: 0.35rem;
    }

    .inline-form {
      width: 100%;
    }

    .inline-form input {
      flex: 1;
      width: auto;
      min-width: 0;
    }

    .select-setting {
      width: 100%;
    }

    .presence-form input {
      min-width: 140px;
    }

    /* Comfortable touch targets (repo baseline is 44px). */
    .icon-btn {
      min-width: 40px;
      min-height: 40px;
      padding: 0.5rem;
    }

    .btn {
      padding: 0.55rem 0.9rem;
    }

    /* Give the two numeric fields room next to the remove button. */
    .tier-table td {
      padding: 0.25rem 0.15rem;
    }

    .tier-table input {
      padding: 0.45rem 0.4rem;
    }
  }
</style>
