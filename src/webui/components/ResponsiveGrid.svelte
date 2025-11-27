<script>
  import { onMount } from 'svelte';
  
  export let columns = { mobile: 1, tablet: 2, desktop: 3 };
  export let gap = '1rem';
  
  let isMobile = false;
  let isTablet = false;
  
  function checkViewport() {
    const width = window.innerWidth;
    isMobile = width < 768;
    isTablet = width >= 768 && width < 1024;
  }
  
  $: gridColumns = isMobile 
    ? columns.mobile 
    : isTablet 
      ? columns.tablet 
      : columns.desktop;
  
  onMount(() => {
    checkViewport();
    window.addEventListener('resize', checkViewport);
    return () => window.removeEventListener('resize', checkViewport);
  });
</script>

<div class="responsive-grid" style="--grid-columns: {gridColumns}; --grid-gap: {gap};">
  <slot />
</div>

<style>
  .responsive-grid {
    display: grid;
    grid-template-columns: repeat(var(--grid-columns, 3), 1fr);
    gap: var(--grid-gap, 1rem);
  }
  
  @media (max-width: 767px) {
    .responsive-grid {
      grid-template-columns: 1fr;
    }
  }
  
  @media (min-width: 768px) and (max-width: 1023px) {
    .responsive-grid {
      grid-template-columns: repeat(var(--grid-columns-tablet, 2), 1fr);
    }
  }
</style>

