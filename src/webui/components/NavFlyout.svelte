<script>
  import {
    List,
    TriangleAlert,
    Clock,
    Slash,
    Bug,
    User,
    Circle,
    Radio,
    Star,
    ArrowUpRight,
    Ban,
    X,
  } from 'lucide-svelte';

  let { title, menu, top, left, onpick, onremove, onenter, onleave, onclose } = $props();

  const ICONS = {
    list: List,
    alert: TriangleAlert,
    clock: Clock,
    slash: Slash,
    bug: Bug,
    user: User,
    dot: Circle,
    live: Radio,
    star: Star,
    arrow: ArrowUpRight,
    ban: Ban,
  };

  let el = $state();
  let height = $state(0);
  const y = $derived(Math.max(8, Math.min(top - 6, window.innerHeight - height - 8)));

  export function focusFirst() {
    el?.querySelector('[role="menuitem"]')?.focus();
  }

  function onkeydown(e) {
    const items = [...el.querySelectorAll('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Escape' || e.key === 'ArrowLeft') {
      e.preventDefault();
      onclose(true);
    }
  }
</script>

<div
  class="flyout"
  role="menu"
  aria-label={title}
  tabindex="-1"
  bind:this={el}
  bind:clientHeight={height}
  style="top:{y}px; left:{left}px"
  onmouseenter={onenter}
  onmouseleave={onleave}
  {onkeydown}
>
  <div class="head">
    <b>{title}</b>
    <button class="open" onclick={() => onpick({ params: {} })}>{menu.open} <kbd>↵</kbd></button>
  </div>
  {#each menu.groups as group (group.name)}
    {#if group.items.length}
      <div class="group">{group.name}</div>
      {#each group.items as item (item.label)}
        {@const Icon = ICONS[item.icon] ?? Circle}
        <div class="item-row">
          <button class="item" role="menuitem" onclick={() => onpick(item)}>
            <span class="ic"><Icon size={14} strokeWidth={1.8} /></span>
            <span class="label">{item.label}</span>
            {#if item.count != null}<span class="count">{item.count.toLocaleString()}</span>{/if}
          </button>
          {#if item.removable}
            <button
              class="remove"
              title="remove saved view"
              aria-label={`remove saved view ${item.label}`}
              onclick={() => onremove(item.removable)}
            >
              <X size={12} />
            </button>
          {/if}
        </div>
      {/each}
    {/if}
  {/each}
  {#if menu.footer}<div class="foot">{menu.footer}</div>{/if}
</div>

<style>
  .flyout {
    position: fixed;
    z-index: 1500;
    width: 300px;
    background: var(--surface-pop);
    border: 1px solid var(--border-2);
    border-radius: 10px;
    box-shadow:
      0 24px 60px rgba(0, 0, 0, 0.55),
      0 0 0 1px rgba(0, 0, 0, 0.3);
    padding-bottom: 6px;
    font-size: 13px;
    animation: pop 0.12s ease-out;
    outline: 0;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translateX(-4px);
    }
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }
  .head b {
    font-weight: 600;
    color: var(--text-bright);
  }
  .open {
    margin-left: auto;
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .open kbd {
    font-size: 10px;
    color: var(--accent);
    opacity: 0.8;
  }
  .group {
    padding: 10px 14px 4px;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .item-row {
    position: relative;
    margin: 0 6px;
  }
  .item {
    width: 100%;
    height: 32px;
    padding: 0 8px;
    display: flex;
    align-items: center;
    gap: 9px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
    outline: 0;
  }
  .item:hover,
  .item:focus-visible {
    background: var(--surface-3);
    color: var(--text-bright);
  }
  .ic {
    width: 16px;
    display: flex;
    justify-content: center;
    color: var(--text-muted);
  }
  .label {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .count {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-dim);
  }
  .remove {
    position: absolute;
    right: 6px;
    top: 7px;
    width: 18px;
    height: 18px;
    display: none;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 4px;
    background: var(--surface-2);
    color: var(--text-muted);
    cursor: pointer;
  }
  .item-row:hover .remove {
    display: flex;
  }
  .remove:hover {
    color: var(--danger);
  }
  .foot {
    margin-top: 6px;
    padding: 9px 14px 3px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    line-height: 1.4;
    color: var(--text-dim);
  }
</style>
