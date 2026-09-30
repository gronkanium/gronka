import { writable } from 'svelte/store';

// A page's own controls for the top bar (a snippet), set while that page is mounted.
export const headerActions = writable(null);
