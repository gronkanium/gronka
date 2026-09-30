<script>
  /**
   * Gear menu with the log list's display options. `prefs` is bindable and the page persists it.
   *
   *   prefs  { wrap: boolean, timestamps: boolean, density: 'compact' | 'comfortable' }
   */
  import { Settings } from 'lucide-svelte';

  let { prefs = $bindable() } = $props();
  let open = $state(false);

  function onkey(e) {
    if (e.key === 'Escape') open = false;
  }
</script>

<div class="wrap">
  <button
    class="icon-btn sm"
    class:on={open}
    onclick={() => (open = !open)}
    title="View settings"
    aria-label="view settings"
    aria-expanded={open}><Settings size={14} /></button
  >
  {#if open}
    <div class="scrim" onclick={() => (open = false)} role="presentation"></div>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="pop menu" role="dialog" tabindex="-1" aria-label="view settings" onkeydown={onkey}>
      <div class="mh">View</div>
      <button
        class="opt"
        role="switch"
        aria-checked={prefs.wrap}
        onclick={() => (prefs.wrap = !prefs.wrap)}
      >
        <span>Wrap lines</span>
        <span class="toggle sm" class:on={prefs.wrap}></span>
      </button>
      <button
        class="opt"
        role="switch"
        aria-checked={prefs.timestamps}
        onclick={() => (prefs.timestamps = !prefs.timestamps)}
      >
        <span>Show timestamps</span>
        <span class="toggle sm" class:on={prefs.timestamps}></span>
      </button>
      <div class="opt">
        <span>Density</span>
        <div class="seg">
          <button class:on={prefs.density === 'compact'} onclick={() => (prefs.density = 'compact')}
            >Compact</button
          >
          <button
            class:on={prefs.density === 'comfortable'}
            onclick={() => (prefs.density = 'comfortable')}>Comfortable</button
          >
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
  }
  .icon-btn.on {
    background: var(--card-3);
    color: var(--text-bright);
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 70;
  }
  .menu {
    position: absolute;
    right: 0;
    top: 32px;
    z-index: 71;
    width: 260px;
    padding: 6px;
    display: flex;
    flex-direction: column;
  }
  .mh {
    padding: 6px 8px 4px;
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-muted);
  }
  .opt {
    min-height: 34px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    font-size: var(--fs);
    color: var(--text);
    cursor: pointer;
  }
  .seg button {
    height: 22px;
    padding: 0 8px;
    font-size: var(--fs-sm);
  }
  button.opt {
    width: 100%;
    border: 0;
    background: none;
    font: inherit;
    font-size: var(--fs);
    text-align: left;
  }
  button.opt:hover {
    background: var(--card-2);
  }
  .toggle.sm {
    width: 28px;
    height: 16px;
    display: inline-block;
  }
  .toggle.sm::after {
    width: 12px;
    height: 12px;
  }
  .toggle.sm.on::after {
    transform: translateX(12px);
  }
</style>
