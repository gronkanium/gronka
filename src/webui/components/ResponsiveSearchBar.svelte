<script>
  import { Search, X } from 'lucide-svelte';
  
  export let placeholder = 'Search...';
  export let value = '';
  export let onSearch = null;
  export let onClear = null;
  export let showClearButton = true;
  
  function handleInput(event) {
    value = event.target.value;
    if (onSearch) {
      onSearch(value);
    }
  }
  
  function handleClear() {
    value = '';
    if (onClear) {
      onClear();
    } else if (onSearch) {
      onSearch('');
    }
  }
  
  function handleSubmit(event) {
    event.preventDefault();
    if (onSearch) {
      onSearch(value);
    }
  }
</script>

<form class="search-bar" on:submit={handleSubmit}>
  <div class="search-input-wrapper">
    <Search size={18} class="search-icon" />
    <input
      type="text"
      class="search-input"
      placeholder={placeholder}
      bind:value
      on:input={handleInput}
    />
    {#if showClearButton && value}
      <button
        type="button"
        class="clear-btn"
        on:click={handleClear}
        aria-label="Clear search"
      >
        <X size={16} />
      </button>
    {/if}
  </div>
  <button type="submit" class="search-btn touch-target">
    <span class="search-btn-text">search</span>
    <Search size={16} class="search-btn-icon" />
  </button>
</form>

<style>
  .search-bar {
    display: flex;
    gap: 0.5rem;
    width: 100%;
  }
  
  @media (max-width: 767px) {
    .search-bar {
      flex-direction: column;
      gap: 0.5rem;
    }
  }
  
  .search-input-wrapper {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    background-color: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    position: relative;
  }
  
  @media (max-width: 767px) {
    .search-input-wrapper {
      padding: 0.5rem;
    }
  }
  
  :global(.search-icon) {
    color: var(--text-muted);
    flex-shrink: 0;
  }
  
  .search-input {
    flex: 1;
    background: none;
    border: none;
    color: var(--text-bright);
    font-size: 0.9rem;
    outline: none;
    min-width: 0;
  }
  
  @media (max-width: 767px) {
    .search-input {
      font-size: 0.85rem;
    }
  }
  
  .clear-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    flex-shrink: 0;
  }
  
  .clear-btn:hover {
    color: var(--text-bright);
  }
  
  .search-btn {
    padding: 0.5rem 1rem;
    background-color: var(--surface-3);
    color: var(--text-bright);
    border: 1px solid var(--border-2);
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 0.85rem;
    transition: background-color 0.2s;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 44px;
    min-height: 44px;
    white-space: nowrap;
  }
  
  @media (max-width: 767px) {
    .search-btn {
      width: 100%;
      justify-content: center;
    }
  }
  
  .search-btn:hover {
    background-color: var(--border-2);
  }
  
  :global(.search-btn-icon) {
    display: none;
  }
  
  @media (max-width: 767px) {
    .search-btn-text {
      display: none;
    }
    
    :global(.search-btn-icon) {
      display: block;
    }
  }
</style>

