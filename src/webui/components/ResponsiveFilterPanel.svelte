<script>
  import { onMount } from 'svelte';
  import { ChevronDown, ChevronUp } from 'lucide-svelte';
  
  export let title = 'filters';
  export let defaultOpen = true;
  export let collapsible = true;
  
  let isOpen = defaultOpen;
  let isMobile = false;
  
  function checkMobile() {
    isMobile = window.innerWidth < 768;
    // Auto-collapse on mobile if defaultOpen is false
    if (isMobile && !defaultOpen) {
      isOpen = false;
    }
  }
  
  function toggle() {
    if (collapsible) {
      isOpen = !isOpen;
    }
  }
  
  onMount(() => {
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  });
</script>

<div class="filter-panel" class:collapsed={!isOpen}>
  {#if collapsible}
    <button class="filter-header" on:click={toggle}>
      <h3>{title}</h3>
      {#if isOpen}
        <ChevronUp size={18} />
      {:else}
        <ChevronDown size={18} />
      {/if}
    </button>
  {:else}
    <div class="filter-header">
      <h3>{title}</h3>
    </div>
  {/if}
  
  {#if isOpen}
    <div class="filter-content">
      <slot />
    </div>
  {/if}
</div>

<style>
  .filter-panel {
    padding: 1rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 3px;
    margin-bottom: 1rem;
  }
  
  @media (max-width: 767px) {
    .filter-panel {
      padding: 0.75rem;
      margin-bottom: 0.75rem;
    }
  }
  
  .filter-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0;
    margin-bottom: 1rem;
    text-align: left;
  }
  
  .filter-panel.collapsed .filter-header {
    margin-bottom: 0;
  }
  
  @media (max-width: 767px) {
    .filter-header {
      margin-bottom: 0.75rem;
    }
    
    .filter-panel.collapsed .filter-header {
      margin-bottom: 0;
    }
  }
  
  .filter-header h3 {
    margin: 0;
    font-size: 1rem;
    color: #fff;
    font-weight: 500;
  }
  
  @media (max-width: 767px) {
    .filter-header h3 {
      font-size: 0.9rem;
    }
  }
  
  .filter-content {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  
  @media (max-width: 767px) {
    .filter-content {
      gap: 0.75rem;
    }
  }
</style>

