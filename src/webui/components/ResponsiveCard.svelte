<script>
  export let title = '';
  export let subtitle = '';
  export let actions = null;
</script>

<div class="responsive-card">
  {#if title || actions}
    <div class="card-header">
      {#if title}
        <div class="card-title-section">
          <h3 class="card-title">{title}</h3>
          {#if subtitle}
            <p class="card-subtitle">{subtitle}</p>
          {/if}
        </div>
      {/if}
      {#if actions}
        <div class="card-actions">
          <slot name="actions" />
        </div>
      {/if}
    </div>
  {/if}
  <div class="card-content">
    <slot />
  </div>
</div>

<style>
  .responsive-card {
    padding: 1.5rem;
    background-color: #222;
    border: 1px solid #333;
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 100%;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }
  
  @media (max-width: 767px) {
    .responsive-card {
      padding: 1rem;
      gap: 0.75rem;
    }
  }
  
  @media (min-width: 1024px) {
    .responsive-card {
      max-width: 1400px;
    }
  }
  
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    border-bottom: 1px solid #333;
    padding-bottom: 0.75rem;
  }
  
  @media (max-width: 767px) {
    .card-header {
      flex-direction: column;
      gap: 0.75rem;
    }
  }
  
  .card-title-section {
    flex: 1;
    min-width: 0;
  }
  
  .card-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 500;
    color: #fff;
  }
  
  @media (max-width: 767px) {
    .card-title {
      font-size: 0.9rem;
    }
  }
  
  .card-subtitle {
    margin: 0.25rem 0 0 0;
    font-size: 0.85rem;
    color: #aaa;
  }
  
  @media (max-width: 767px) {
    .card-subtitle {
      font-size: 0.8rem;
    }
  }
  
  .card-actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  
  .card-content {
    flex: 1;
    min-width: 0;
    max-width: 100%;
    overflow-wrap: break-word;
    word-wrap: break-word;
  }
</style>

