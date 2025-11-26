<script>
  import { ChevronDown, ChevronRight } from 'lucide-svelte';
  
  export let columns = [];
  export let data = [];
  export let mobileCardLayout = false;
  export let sortable = false;
  export let expandable = false;
  export let expandedRows = new Set();
  export let onExpand = null;
  export let renderExpanded = null;
  export let keyField = 'id';
  
  let sortColumn = null;
  let sortDirection = 'asc';
  let isMobile = false;
  
  function checkMobile() {
    isMobile = window.innerWidth < 768;
  }
  
  function handleSort(column) {
    if (!sortable || !column.sortable) return;
    
    if (sortColumn === column.key) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortColumn = column.key;
      sortDirection = 'asc';
    }
  }
  
  function toggleExpand(row) {
    if (!expandable || !onExpand) return;
    onExpand(row);
  }
  
  $: sortedData = sortable && sortColumn
    ? [...data].sort((a, b) => {
        const aVal = a[sortColumn];
        const bVal = b[sortColumn];
        const multiplier = sortDirection === 'asc' ? 1 : -1;
        
        if (aVal === null || aVal === undefined) return 1 * multiplier;
        if (bVal === null || bVal === undefined) return -1 * multiplier;
        
        if (typeof aVal === 'number' && typeof bVal === 'number') {
          return (aVal - bVal) * multiplier;
        }
        
        return String(aVal).localeCompare(String(bVal)) * multiplier;
      })
    : data;
  
  $: isRowExpanded = (row) => expandedRows.has(row[keyField]);
  
  onMount(() => {
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  });
</script>

{#if isMobile && mobileCardLayout}
  <!-- Mobile Card Layout -->
  <div class="table-cards">
    {#each sortedData as row (row[keyField])}
      <div class="table-card">
        {#each columns as column}
          <div class="card-field">
            <div class="card-label">{column.label}</div>
            <div class="card-value">
              {#if column.render}
                {@html column.render(row)}
              {:else}
                {row[column.key] || 'N/A'}
              {/if}
            </div>
          </div>
        {/each}
        {#if expandable && renderExpanded}
          <div class="card-expand">
            <button class="expand-btn" on:click={() => toggleExpand(row)}>
              {#if isRowExpanded(row)}
                <ChevronDown size={16} />
                <span>hide details</span>
              {:else}
                <ChevronRight size={16} />
                <span>show details</span>
              {/if}
            </button>
            {#if isRowExpanded(row)}
              <div class="card-expanded-content">
                {@html renderExpanded(row)}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{:else}
  <!-- Desktop Table or Mobile Scroll -->
  <div class="table-container scrollable-container">
    <table>
      <thead>
        <tr>
          {#if expandable}
            <th class="expand-col"></th>
          {/if}
          {#each columns as column}
            <th
              class:sortable={sortable && column.sortable}
              on:click={() => handleSort(column)}
              style={column.width ? `width: ${column.width}` : ''}
            >
              {column.label}
              {#if sortable && column.sortable && sortColumn === column.key}
                <span class="sort-indicator">{sortDirection === 'asc' ? '↑' : '↓'}</span>
              {/if}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each sortedData as row (row[keyField])}
          <tr class:expanded={isRowExpanded(row)}>
            {#if expandable}
              <td class="expand-cell">
                <button class="expand-btn" on:click={() => toggleExpand(row)}>
                  {#if isRowExpanded(row)}
                    <ChevronDown size={16} />
                  {:else}
                    <ChevronRight size={16} />
                  {/if}
                </button>
              </td>
            {/if}
            {#each columns as column}
              <td>
                {#if column.render}
                  {@html column.render(row)}
                {:else}
                  {row[column.key] || 'N/A'}
                {/if}
              </td>
            {/each}
          </tr>
          {#if expandable && isRowExpanded(row) && renderExpanded}
            <tr class="expanded-row">
              <td colspan={columns.length + (expandable ? 1 : 0)} class="expanded-content">
                {@html renderExpanded(row)}
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .table-container {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
    min-width: 600px;
  }
  
  @media (max-width: 767px) {
    table {
      font-size: 0.8rem;
      min-width: 500px;
    }
  }
  
  thead {
    background-color: #2a2a2a;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  
  th {
    padding: 0.75rem 0.5rem;
    text-align: left;
    font-weight: 500;
    color: #aaa;
    border-bottom: 1px solid #333;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    white-space: nowrap;
  }
  
  @media (max-width: 767px) {
    th {
      padding: 0.5rem 0.25rem;
      font-size: 0.75rem;
    }
  }
  
  th.sortable {
    cursor: pointer;
    user-select: none;
  }
  
  th.sortable:hover {
    background-color: #333;
    color: #fff;
  }
  
  .sort-indicator {
    margin-left: 0.25rem;
    color: #51cf66;
  }
  
  tbody tr {
    border-bottom: 1px solid #2a2a2a;
  }
  
  tbody tr:hover {
    background-color: #2a2a2a;
  }
  
  tbody tr.expanded {
    background-color: #2a2a2a;
  }
  
  td {
    padding: 0.75rem 0.5rem;
    color: #e0e0e0;
  }
  
  @media (max-width: 767px) {
    td {
      padding: 0.5rem 0.25rem;
    }
  }
  
  .expand-col {
    width: 40px;
    text-align: center;
  }
  
  .expand-cell {
    text-align: center;
    width: 40px;
  }
  
  .expand-btn {
    background: none;
    border: none;
    color: #aaa;
    cursor: pointer;
    font-size: 0.9rem;
    padding: 0.25rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 44px;
    min-height: 44px;
    justify-content: center;
  }
  
  .expand-btn:hover {
    color: #fff;
  }
  
  .expanded-row {
    background-color: #1a1a1a;
  }
  
  .expanded-content {
    padding: 1.5rem !important;
  }
  
  @media (max-width: 767px) {
    .expanded-content {
      padding: 1rem !important;
    }
  }
  
  /* Mobile Card Layout */
  .table-cards {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  
  .table-card {
    background-color: #222;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  
  .card-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  
  .card-label {
    font-size: 0.75rem;
    color: #aaa;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 500;
  }
  
  .card-value {
    font-size: 0.9rem;
    color: #e0e0e0;
    word-break: break-word;
  }
  
  .card-expand {
    margin-top: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid #333;
  }
  
  .card-expand .expand-btn {
    width: 100%;
    justify-content: flex-start;
    padding: 0.5rem;
  }
  
  .card-expanded-content {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid #2a2a2a;
  }
</style>

