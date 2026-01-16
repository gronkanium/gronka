<script>
  export let title = '';
  export let value = null;
  export let subtitle = '';
  export let status = 'neutral'; // good, warning, critical, neutral
</script>

<div class="kpi-card status-{status}">
  <div class="kpi-title">{title}</div>
  <div class="kpi-value">{value ?? 'N/A'}</div>
  {#if subtitle}
    <div class="kpi-subtitle">{subtitle}</div>
  {/if}
</div>

<style>
  .kpi-card {
    padding: 1rem;
    background-color: #1a1a1a;
    border: 1px solid #333;
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    border-left: 3px solid #444;
  }

  .kpi-card.status-good {
    border-left-color: #51cf66;
  }

  .kpi-card.status-warning {
    border-left-color: #ffd93d;
  }

  .kpi-card.status-critical {
    border-left-color: #ff6b6b;
  }

  .kpi-card.status-neutral {
    border-left-color: #4dabf7;
  }

  .kpi-title {
    font-size: 0.7rem;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .kpi-value {
    font-size: 1.75rem;
    font-weight: 600;
    color: #fff;
    line-height: 1.2;
  }

  .status-good .kpi-value {
    color: #51cf66;
  }

  .status-warning .kpi-value {
    color: #ffd93d;
  }

  .status-critical .kpi-value {
    color: #ff6b6b;
  }

  .kpi-subtitle {
    font-size: 0.75rem;
    color: #666;
  }

  @media (max-width: 768px) {
    .kpi-value {
      font-size: 1.5rem;
    }
  }
</style>
