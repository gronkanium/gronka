<script>
  import { tick } from 'svelte';

  // commands: [{ id, label, hint?, keys?, group, run }]; search(query) -> [{ label, hint?, group, run }]
  let { open = $bindable(false), query = $bindable(''), commands = [], search } = $props();

  let active = $state(0);
  let input = $state();

  const commandMode = $derived(query.startsWith('>'));
  const needle = $derived((commandMode ? query.slice(1) : query).trim().toLowerCase());

  function fuzzy(text, q) {
    if (!q) return true;
    let i = 0;
    for (const ch of text.toLowerCase()) if (ch === q[i]) i++;
    return i === q.length;
  }

  const items = $derived(
    commandMode
      ? commands.filter(c => fuzzy(c.label, needle))
      : [
          ...(search ? search(needle, query.trim()) : []),
          ...commands.filter(c => c.group === 'Go to' && fuzzy(c.label, needle)),
        ]
  );
  const groups = $derived(
    items.reduce((out, item, index) => {
      const g = out.at(-1);
      if (g?.name === item.group) g.items.push({ ...item, index });
      else out.push({ name: item.group, items: [{ ...item, index }] });
      return out;
    }, [])
  );

  $effect(() => {
    if (open) tick().then(() => input?.focus());
  });
  $effect(() => {
    needle;
    active = 0;
  });

  function choose(item) {
    if (!item) return;
    open = false;
    query = '';
    item.run();
  }

  function onkeydown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = (active + 1) % Math.max(items.length, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active - 1 + items.length) % Math.max(items.length, 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === 'Escape') {
      open = false;
    } else if (e.key === 'Backspace' && query === '>') {
      e.preventDefault();
      query = '';
    }
  }
</script>

{#if open}
  <div class="scrim" onclick={() => (open = false)} role="presentation"></div>
  <div class="palette" role="dialog" aria-modal="true" aria-label="command palette">
    <div class="field">
      {#if commandMode}<span class="caret">&gt;</span>{/if}
      <input
        bind:this={input}
        value={commandMode ? query.slice(1) : query}
        oninput={e => (query = (commandMode ? '>' : '') + e.currentTarget.value)}
        {onkeydown}
        placeholder={commandMode
          ? 'run a command'
          : 'search users, request ids, links, pages… (type > for commands)'}
        aria-label="palette input"
        spellcheck="false"
        autocomplete="off"
      />
      <kbd>esc</kbd>
    </div>
    <div class="list" role="listbox">
      {#each groups as group (group.name)}
        <div class="group">{group.name}</div>
        {#each group.items as item (item.index)}
          <button
            class="item"
            class:on={item.index === active}
            role="option"
            aria-selected={item.index === active}
            onmousemove={() => (active = item.index)}
            onclick={() => choose(item)}
          >
            <span class="label">{item.label}</span>
            {#if item.hint}<span class="hint">{item.hint}</span>{/if}
            {#if item.keys}<kbd class="keys">{item.keys}</kbd>{/if}
          </button>
        {/each}
      {:else}
        <div class="empty">no matches</div>
      {/each}
    </div>
    <div class="foot">
      <span><kbd>↑↓</kbd> move</span>
      <span><kbd>↵</kbd> run</span>
      {#if commandMode}<span><kbd>⌫</kbd> back to search</span>{:else}<span
          ><kbd>&gt;</kbd> commands</span
        >{/if}
      <span class="spacer">Ctrl Shift P commands · Ctrl P search</span>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 3000;
  }
  .palette {
    position: fixed;
    top: 12vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(640px, calc(100vw - 32px));
    background: #17181c;
    border: 1px solid var(--border-2);
    border-radius: 12px;
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
    z-index: 3001;
    overflow: hidden;
    font-family: var(--font);
  }
  .field {
    height: 54px;
    padding: 0 16px;
    display: flex;
    align-items: center;
    gap: 10px;
    border-bottom: 1px solid var(--border);
  }
  .caret {
    font-family: var(--mono);
    color: var(--accent);
    font-size: 15px;
  }
  input {
    flex: 1;
    background: none;
    border: 0;
    outline: 0;
    color: var(--text-bright);
    font: inherit;
    font-size: 15px;
  }
  input::placeholder {
    color: var(--text-dim);
  }
  kbd {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-muted);
    border: 1px solid var(--border-2);
    border-radius: 4px;
    padding: 1px 5px;
  }
  .list {
    max-height: min(420px, 60vh);
    overflow-y: auto;
    padding: 6px 0 8px;
  }
  .group {
    padding: 10px 18px 4px;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .item {
    width: calc(100% - 12px);
    margin: 0 6px;
    min-height: 38px;
    padding: 0 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    border: 0;
    border-radius: 7px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .item.on {
    background: var(--surface-3);
  }
  .hint {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .keys {
    margin-left: auto;
  }
  .empty {
    padding: 18px;
    color: var(--text-dim);
    font-size: 13px;
  }
  .foot {
    height: 38px;
    padding: 0 18px;
    display: flex;
    align-items: center;
    gap: 16px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-dim);
  }
  .spacer {
    margin-left: auto;
  }
  @media (max-width: 640px) {
    .foot .spacer {
      display: none;
    }
  }
</style>
