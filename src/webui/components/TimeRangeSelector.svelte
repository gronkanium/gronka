<script>
  export let value = '7d';
  export let interval = 'daily';
  export let showInterval = true;

  const presets = [
    { label: '24h', value: '24h', defaultInterval: 'hourly' },
    { label: '7d', value: '7d', defaultInterval: 'daily' },
    { label: '30d', value: '30d', defaultInterval: 'daily' },
  ];

  const intervals = [
    { label: 'Hourly', value: 'hourly' },
    { label: 'Daily', value: 'daily' },
    { label: 'Weekly', value: 'weekly' },
  ];

  function handlePresetChange(preset) {
    value = preset.value;
    interval = preset.defaultInterval;
  }
</script>

<div class="time-range-selector">
  <div class="preset-buttons">
    {#each presets as preset}
      <button
        class="preset-btn"
        class:active={value === preset.value}
        on:click={() => handlePresetChange(preset)}
      >
        {preset.label}
      </button>
    {/each}
  </div>

  {#if showInterval}
    <div class="interval-selector">
      <select bind:value={interval}>
        {#each intervals as int}
          <option value={int.value}>{int.label}</option>
        {/each}
      </select>
    </div>
  {/if}
</div>

<style>
  .time-range-selector {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .preset-buttons {
    display: flex;
    gap: 0.25rem;
    background-color: #222;
    border-radius: 4px;
    padding: 0.25rem;
  }

  .preset-btn {
    padding: 0.5rem 1rem;
    background-color: transparent;
    border: none;
    color: #888;
    cursor: pointer;
    font-size: 0.85rem;
    border-radius: 3px;
    transition: all 0.2s ease;
  }

  .preset-btn:hover {
    color: #fff;
    background-color: #333;
  }

  .preset-btn.active {
    color: #fff;
    background-color: #51cf66;
  }

  .interval-selector select {
    padding: 0.5rem 0.75rem;
    background-color: #222;
    border: 1px solid #333;
    color: #e0e0e0;
    border-radius: 4px;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .interval-selector select:focus {
    outline: none;
    border-color: #51cf66;
  }

  @media (max-width: 480px) {
    .time-range-selector {
      flex-direction: column;
      align-items: stretch;
    }

    .preset-buttons {
      width: 100%;
      justify-content: center;
    }

    .interval-selector {
      width: 100%;
    }

    .interval-selector select {
      width: 100%;
    }
  }
</style>
