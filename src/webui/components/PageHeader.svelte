<script>
  /**
   * The block at the top of every page: an optional breadcrumb trail, the title, one line
   * saying what the page is for, and the page's primary controls on the right.
   *
   *   crumbs   [{ label, page, params }] rendered before the title
   *   actions  snippet for the right side
   *   below    snippet rendered under the title row (tabs, a toolbar)
   */
  import { ChevronRight } from 'lucide-svelte';
  import { navigate } from '../utils/router.js';

  let {
    title,
    description = '',
    crumbs = null,
    mono = false,
    actions = null,
    below = null,
    children = null,
  } = $props();
</script>

<header class="page-head">
  <div class="titles">
    {#if crumbs?.length}
      <nav class="crumbs" aria-label="breadcrumb">
        {#each crumbs as c, i (i)}
          {#if i}<ChevronRight size={13} class="sep" />{/if}
          <button onclick={() => navigate(c.page, c.params ?? {})}>{c.label}</button>
        {/each}
      </nav>
    {/if}
    <h1 class:mono>
      {title}{#if children}{@render children()}{/if}
    </h1>
    {#if description}<div class="desc">{description}</div>{/if}
  </div>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</header>
{#if below}<div class="below">{@render below()}</div>{/if}

<style>
  h1.mono {
    font-family: var(--mono);
    font-weight: 500;
    font-size: var(--fs-xl);
  }
  .below {
    margin: -8px 0 20px;
  }
</style>
