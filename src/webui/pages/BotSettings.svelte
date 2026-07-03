<script>
  import { onMount } from 'svelte';

  let settings = {};
  let loading = true;
  let error = null;
  let saving = {};

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

  onMount(loadSettings);
</script>

<div class="settings-page">
  {#if loading}
    <p class="status">loading settings...</p>
  {:else}
    {#if error}
      <p class="status error">{error}</p>
    {/if}
    {#each Object.entries(settings) as [key, setting] (key)}
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-name">{key.replace(/_/g, ' ')}</span>
          <span class="setting-description">{setting.description}</span>
        </div>
        {#if setting.type === 'boolean'}
          <button
            class="toggle"
            class:on={setting.value === 'true'}
            disabled={saving[key]}
            on:click={() => toggleSetting(key)}
            aria-label={`Toggle ${key.replace(/_/g, ' ')}`}
          >
            <span class="toggle-knob"></span>
          </button>
        {:else if setting.type === 'string'}
          <form
            class="text-setting"
            on:submit|preventDefault={(e) => handleTextSubmit(key, e.target.elements.value.value)}
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
    transition: background-color 0.2s, border-color 0.2s;
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
