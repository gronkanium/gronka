<script>
  /**
   * A thumbnail for a stored file that also tells whether the link still works: the browser
   * fetches the object, so a 404 from the bucket becomes the "dead" state. Videos show their
   * first frame via metadata preload; gifs and images load as images.
   *
   *   onstate('ok' | 'dead')  fires once the browser knows
   *   preview                 large mode with controls, for a detail panel
   */
  import { Play, ImageOff, Film } from 'lucide-svelte';

  let { url, type = 'image', size = 48, preview = false, onstate = null } = $props();

  let state = $state('loading');
  const set = s => {
    if (state === s) return;
    state = s;
    onstate?.(s);
  };
  const isVideo = $derived(type === 'video' || /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url || ''));
  // A media fragment asks for the first frame without downloading the whole file.
  const src = $derived(isVideo && !preview ? `${url}#t=0.1` : url);
</script>

<div
  class="thumb"
  class:preview
  class:dead={state === 'dead'}
  class:loading={state === 'loading'}
  style={preview ? '' : `width:${size}px;height:${size}px`}
>
  {#if state === 'dead'}
    <span class="ph"><ImageOff size={preview ? 28 : 16} /></span>
  {:else if isVideo}
    <video
      {src}
      muted
      playsinline
      preload="metadata"
      controls={preview}
      loop={preview}
      onloadeddata={() => set('ok')}
      onerror={() => set('dead')}
    ></video>
    {#if !preview && state === 'ok'}<span class="badge"><Play size={9} /></span>{/if}
  {:else}
    <img {src} alt="" loading="lazy" onload={() => set('ok')} onerror={() => set('dead')} />
  {/if}
  {#if state === 'loading'}
    <span class="ph faint"
      >{#if isVideo}<Film size={14} />{/if}</span
    >
  {/if}
</div>

<style>
  .thumb {
    position: relative;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    overflow: hidden;
    border-radius: var(--radius-sm);
    background: var(--bg-deep);
    border: 1px solid var(--border);
  }
  .thumb.preview {
    width: 100%;
    aspect-ratio: 16 / 10;
    border-radius: var(--radius);
  }
  img,
  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .preview img,
  .preview video {
    object-fit: contain;
  }
  .loading img,
  .loading video {
    opacity: 0;
  }
  .ph {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--text-dim);
  }
  .ph.faint {
    color: var(--surface-3);
  }
  .dead {
    background: var(--danger-bg-subtle);
    border-color: var(--danger-border);
  }
  .dead .ph {
    color: var(--danger);
  }
  .badge {
    position: absolute;
    right: 3px;
    bottom: 3px;
    width: 14px;
    height: 14px;
    display: grid;
    place-items: center;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.7);
    color: #fff;
  }
</style>
