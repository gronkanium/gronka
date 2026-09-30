import { onDestroy } from 'svelte';
import { writable } from 'svelte/store';

// A page's own controls for the top bar (a snippet), set while that page is mounted.
export const headerActions = writable(null);
// Breadcrumb trail for the top bar: [{ label, page, params }], the last entry is the current page.
export const headerCrumbs = writable(null);

// The next page mounts before the last one is destroyed, so only clear what is still ours.
export function useHeaderActions(snippet) {
  headerActions.set(snippet);
  onDestroy(() => headerActions.update(current => (current === snippet ? null : current)));
}

// Pages with a dynamic trail call setCrumbs from an effect; useCrumbs clears it on unmount.
let owner = 0;
export function useCrumbs() {
  const me = ++owner;
  onDestroy(() => headerCrumbs.update(current => (current?.owner === me ? null : current)));
  return list => headerCrumbs.set({ owner: me, list });
}
