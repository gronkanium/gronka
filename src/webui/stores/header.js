import { onDestroy } from 'svelte';
import { writable } from 'svelte/store';

// A page's own controls for the top bar (a snippet), set while that page is mounted.
export const headerActions = writable(null);

// The next page mounts before the last one is destroyed, so only clear what is still ours.
export function useHeaderActions(snippet) {
  headerActions.set(snippet);
  onDestroy(() => headerActions.update(current => (current === snippet ? null : current)));
}
