<script>
  import Stats from './Stats.svelte';
  import Health from './Health.svelte';
  import Operations from './Operations.svelte';
</script>

<main>
  <header>
    <h1>gronka</h1>
  </header>
  <div class="content">
    <Stats />
    <Health />
    <Operations />
  </div>
</main>

<style>
  :global(body) {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    background-color: #1a1a1a;
    color: #e0e0e0;
    line-height: 1.6;
  }

  :global(*) {
    box-sizing: border-box;
  }

  main {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  header {
    padding: 2rem;
    border-bottom: 1px solid #333;
  }

  header h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 500;
    color: #fff;
  }

  .content {
    flex: 1;
    padding: 2rem;
    display: grid;
    grid-template-columns: 1fr 1fr;
    align-items: start;
    gap: 2rem;
    row-gap: 1rem;
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
  }

  .content > :global(section:last-child) {
    margin-top: 0;
  }

  @media (max-width: 768px) {
    .content {
      grid-template-columns: 1fr;
      padding: 1rem;
    }

    header {
      padding: 1rem;
    }
  }
</style>

