<script>
  /** Initials-style avatar for a Discord id: the hue comes from the id so a user looks the same everywhere. */
  let { id = '', size = 24, label = null } = $props();

  const hue = $derived.by(() => {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  });
  const text = $derived(label ?? String(id).slice(-2));
</script>

<span
  class="avatar"
  class:lg={size >= 40}
  style="--h:{hue}; width:{size}px; height:{size}px; font-size:{Math.round(size * 0.4)}px"
  aria-hidden="true">{text}</span
>
