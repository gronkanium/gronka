<script>
  import { tick } from 'svelte';
  import { Star } from 'lucide-svelte';
  import { currentRoute } from '../utils/router.js';
  import { saveView } from '../stores/nav.js';

  let { page } = $props();

  let open = $state(false);
  let name = $state('');
  let status = $state('');
  let input = $state();

  const params = $derived(
    Object.fromEntries(
      Object.entries($currentRoute.params)
        .filter(([k, v]) => k.startsWith('$') && v)
        .map(([k, v]) => [k.slice(1), v])
    )
  );

  async function toggle() {
    open = !open;
    status = '';
    if (open) {
      await tick();
      input?.focus();
    }
  }

  async function save() {
    if (!name.trim()) return;
    try {
      await saveView({ name: name.trim(), page, params });
      status = 'saved to the sidebar menu';
      name = '';
      setTimeout(() => (open = false), 900);
    } catch {
      status = 'could not save';
    }
  }
</script>

<div class="wrap">
  <button
    class="btn"
    onclick={toggle}
    aria-expanded={open}
    disabled={!Object.keys(params).length}
    title={Object.keys(params).length
      ? 'pin this filtered view to the sidebar menu'
      : 'filter something first'}
  >
    <Star size={13} />Save view
  </button>
  {#if open}
    <div class="pop" role="dialog" aria-label="save view">
      <input
        class="field"
        bind:this={input}
        bind:value={name}
        maxlength="60"
        placeholder="name this view"
        onkeydown={e => (e.key === 'Enter' ? save() : e.key === 'Escape' && (open = false))}
      />
      <button class="btn primary" onclick={save} disabled={!name.trim()}>Save</button>
      {#if status}<div class="status">{status}</div>{/if}
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
  }
  .pop {
    position: absolute;
    right: 0;
    top: 38px;
    z-index: 60;
    width: 280px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px;
    background: var(--pop);
    border: 1px solid var(--border-2);
    border-radius: 10px;
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
  }
  .pop .field {
    flex: 1;
  }
  .status {
    width: 100%;
    font-size: 12px;
    color: var(--text-muted);
  }
</style>
