<script>
  import { Check, Copy, ExternalLink } from 'lucide-svelte';
  import { createCopier } from '../utils/copier.svelte.js';

  let { text = '', full = text, label, href = null, children } = $props();
  const copier = createCopier();
</script>

<span class="cv">
  {#if children}
    <span class="cv-c">{@render children()}</span>
  {:else if href}
    <a class="cv-t" {href} target="_blank" rel="noreferrer" title={full}
      ><span class="ellipsis">{text}</span><ExternalLink size={11} /></a
    >
  {:else}
    <span class="cv-t ellipsis" title={full}>{text}</span>
  {/if}
  <button
    class="cv-b"
    class:done={copier.copied}
    title={copier.copied ? 'Copied' : 'Copy'}
    aria-label="Copy {label}"
    onclick={() => copier.copy(full)}
    >{#if copier.copied}<Check size={12} />{:else}<Copy size={12} />{/if}</button
  >
</span>

<style>
  .cv {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: 100%;
  }
  .cv-c {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .cv-t {
    min-width: 0;
    font-family: var(--mono);
    font-size: var(--fs-sm);
  }
  a.cv-t {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  a.cv-t :global(svg) {
    flex-shrink: 0;
  }
  .cv-b {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--text-dim);
    display: inline-grid;
    place-items: center;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .cv:hover .cv-b,
  .cv-b:focus-visible,
  .cv-b.done {
    opacity: 1;
  }
  .cv-b:hover {
    background: var(--card-3);
    color: var(--text-bright);
  }
  .cv-b.done {
    color: var(--success-text);
  }
  @media (hover: none) {
    .cv-b {
      opacity: 1;
    }
  }
</style>
