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
    saving = { ...saving, [key]: true };
    error = null;
    try {
      const response = await fetch(`/api/settings/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: newValue }),
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      settings = {
        ...settings,
        [key]: { ...current, value: String(newValue) },
      };
    } catch (err) {
      console.error(`Failed to update setting ${key}:`, err);
      error = `failed to update ${key.replace(/_/g, ' ')}`;
    } finally {
      saving = { ...saving, [key]: false };
    }
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
</style>
