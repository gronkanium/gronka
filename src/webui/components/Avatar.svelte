<script>
  import { blobatarUri } from 'blobatar/uri';

  let { id = '', size = 24 } = $props();

  const src = $derived(blobatarUri(String(id)));
</script>

<img class="avatar" {src} alt="" width={size} height={size} aria-hidden="true" />
