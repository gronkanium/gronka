<script>
  import { createEventDispatcher } from 'svelte';

  export let offset = 0;
  export let limit = 50;
  export let total = 0;
  export let disabled = false;
  export let pageSizes = null; // e.g. [10, 25, 50, 100] to show a page-size select

  const dispatch = createEventDispatcher();

  function prev() {
    if (offset > 0) {
      dispatch('page', { offset: Math.max(0, offset - limit), limit });
    }
  }

  function next() {
    if (offset + limit < total) {
      dispatch('page', { offset: offset + limit, limit });
    }
  }

  function changeLimit(event) {
    dispatch('page', { offset: 0, limit: parseInt(event.target.value, 10) });
  }
</script>

<div class="pagination">
  <div class="pagination-info">
    {#if total > 0}
      showing {offset + 1}-{Math.min(offset + limit, total)} of {total}
    {:else}
      no results
    {/if}
  </div>
  <div class="pagination-controls">
    {#if pageSizes}
      <select value={limit} on:change={changeLimit} {disabled} class="page-size-select">
        {#each pageSizes as size}
          <option value={size}>{size} per page</option>
        {/each}
      </select>
    {/if}
    <button on:click={prev} disabled={offset === 0 || disabled}>previous</button>
    <button on:click={next} disabled={offset + limit >= total || disabled}>next</button>
  </div>
</div>

<style>
  .pagination {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem;
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .pagination-info {
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .pagination-controls {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .pagination-controls button {
    padding: 0.4rem 0.8rem;
    font-size: 0.85rem;
    background-color: var(--surface-3);
    color: var(--text-bright);
    border: 1px solid var(--border-2);
    cursor: pointer;
    border-radius: var(--radius);
  }

  .pagination-controls button:hover:not(:disabled) {
    background-color: var(--border-2);
  }

  .pagination-controls button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .page-size-select {
    padding: 0.4rem 0.6rem;
    font-size: 0.85rem;
    background-color: var(--surface-2);
    border: 1px solid var(--surface-3);
    color: var(--text-bright);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .page-size-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (max-width: 768px) {
    .pagination {
      flex-direction: column;
      gap: 0.75rem;
      align-items: stretch;
    }

    .pagination-controls {
      width: 100%;
    }

    .pagination-controls button {
      flex: 1;
      min-height: 44px;
    }
  }
</style>
