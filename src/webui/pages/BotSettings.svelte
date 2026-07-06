<script>
  import { onMount } from 'svelte';

  let settings = {};
  let loading = true;
  let error = null;
  let saving = {};

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
    } catch (err) {
      console.error('Failed to fetch settings:', err);
      error = 'failed to load settings';
    } finally {
      loading = false;
    }
  }

  async function toggleSetting(key) {
    const current = settings[key];
    const newValue = current.value !== 'true';
    await saveSetting(key, newValue);
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

  onMount(() => {
    loadSettings();
    loadPresence();
  });
</script>

<div class="settings-page">
  <div class="presence-card">
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
          {currentPresence.status}{currentPresence.activity ? ` — ${currentPresence.activity}` : ''}
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
      <button type="submit" class="save-btn" disabled={presenceSaving}>
        {presenceSaving ? 'updating...' : 'update'}
      </button>
    </form>
    {#if presenceError}
      <p class="status error">{presenceError}</p>
    {:else if presenceMessage}
      <p class="status success">{presenceMessage}</p>
    {/if}
  </div>

  {#if loading}
    <p class="status">loading settings...</p>
  {:else}
    {#if error}
      <p class="status error">{error}</p>
    {/if}
    {#each Object.entries(settings) as [key, setting] (key)}
      <div class="setting-row" class:list-setting={setting.type === 'list'}>
        <div class="setting-info">
          <span class="setting-name">{key.replace(/_/g, ' ')}</span>
          <span class="setting-description">{setting.description}</span>
        </div>
        {#if setting.type === 'list'}
          <div class="list-editor">
            {#if (setting.envValues || []).length === 0 && listValues(setting).length === 0}
              <p class="list-empty">no entries</p>
            {:else}
              <table class="list-table">
                <tbody>
                  {#each setting.envValues || [] as item (item)}
                    <tr>
                      <td class="list-value">{item}</td>
                      <td class="list-action"><span class="list-source">from env</span></td>
                    </tr>
                  {/each}
                  {#each listValues(setting) as item (item)}
                    <tr>
                      <td class="list-value">{item}</td>
                      <td class="list-action">
                        <button
                          class="remove-btn"
                          disabled={saving[key]}
                          on:click={() => removeListItem(key, item)}
                        >
                          remove
                        </button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
            <form class="text-setting" on:submit|preventDefault={e => addListItem(key, e.target)}>
              <input
                type="text"
                name="value"
                placeholder="discord user id"
                disabled={saving[key]}
                aria-label={`Add to ${key.replace(/_/g, ' ')}`}
              />
              <button type="submit" class="save-btn" disabled={saving[key]}>add</button>
            </form>
          </div>
        {:else if setting.type === 'boolean'}
          <button
            class="toggle"
            class:on={setting.value === 'true'}
            disabled={saving[key]}
            on:click={() => toggleSetting(key)}
            aria-label={`Toggle ${key.replace(/_/g, ' ')}`}
          >
            <span class="toggle-knob"></span>
          </button>
        {:else if setting.type === 'number'}
          <form
            class="text-setting"
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
              aria-label={key.replace(/_/g, ' ')}
            />
            <button type="submit" class="save-btn" disabled={saving[key]}>save</button>
          </form>
        {:else if setting.type === 'string'}
          <form
            class="text-setting"
            on:submit|preventDefault={e => handleTextSubmit(key, e.target.elements.value.value)}
          >
            <input
              type="text"
              name="value"
              value={setting.value}
              disabled={saving[key]}
              aria-label={key.replace(/_/g, ' ')}
            />
            <button type="submit" class="save-btn" disabled={saving[key]}>save</button>
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
    max-width: 700px;
  }

  .status {
    color: var(--text-muted);
  }

  .status.error {
    color: var(--danger);
  }

  .status.success {
    color: var(--success);
  }

  .presence-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background-color: var(--bg-deep);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1rem 1.25rem;
  }

  .current-presence {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--text-muted);
    font-size: 0.85rem;
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

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    background-color: var(--bg-deep);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1rem 1.25rem;
  }

  .setting-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .setting-name {
    color: var(--text-bright);
    font-size: 1rem;
  }

  .setting-description {
    color: var(--text-muted);
    font-size: 0.85rem;
  }

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

  .setting-row.list-setting {
    flex-direction: column;
    align-items: stretch;
  }

  .list-editor {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
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

  .list-source {
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .remove-btn {
    padding: 0.2rem 0.6rem;
    font-size: 0.8rem;
    background-color: var(--surface-3);
    color: var(--text-bright);
    border: 1px solid var(--border-2);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .remove-btn:hover:not(:disabled) {
    background-color: var(--border-2);
  }

  .remove-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .text-setting {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .text-setting input {
    background-color: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-bright);
    padding: 0.4rem 0.6rem;
    font-size: 0.9rem;
    width: 200px;
  }

  .text-setting input:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  .save-btn {
    padding: 0.4rem 0.8rem;
    font-size: 0.85rem;
    background-color: var(--surface-3);
    color: var(--text-bright);
    border: 1px solid var(--border-2);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .save-btn:hover:not(:disabled) {
    background-color: var(--border-2);
  }

  .save-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
