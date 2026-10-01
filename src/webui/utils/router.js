/**
 * Simple hash-based router for Svelte
 */

import { writable } from 'svelte/store';

// Current route store
export const currentRoute = writable({
  page: 'dashboard',
  params: {},
});

/**
 * Sanitize property key to prevent prototype pollution attacks
 * Prepends '$' to user-controlled keys to prevent access to built-in properties
 */
function sanitizePropertyKey(key) {
  // Prepend '$' to prevent access to prototype properties like __proto__, constructor, etc.
  return `$${key}`;
}

// Parse hash and update route
function parseHash() {
  return parseHashOf(window.location.hash);
}

function parseHashOf(full) {
  const hash = full.slice(1) || '/';
  const [path, queryString] = hash.split('?');
  const segments = path.split('/').filter(Boolean);

  let page = segments[0] || 'dashboard';
  const params = {};

  // Parse path parameters (e.g., /users/123 -> {userId: '123'})
  if (page === 'users' && segments[1]) {
    params.userId = segments[1];
    page = 'user-profile';
  }
  if (page === 'requests' && segments[1]) {
    params.requestId = segments[1];
    page = 'request';
  }
  // The alerts page became issues.
  if (page === 'alerts') page = 'issues';

  // Parse query parameters
  if (queryString) {
    queryString.split('&').forEach(param => {
      const [key, value] = param.split('=');
      if (key && value) {
        // Sanitize key to prevent prototype pollution attacks
        const sanitizedKey = sanitizePropertyKey(decodeURIComponent(key));
        params[sanitizedKey] = decodeURIComponent(value);
      }
    });
  }

  return { page, params };
}

// Initialize router
export function initRouter() {
  // Listen for hash changes
  const sync = () => currentRoute.set(parseHash());
  window.addEventListener('hashchange', sync);
  window.addEventListener('popstate', sync);

  // Parse initial route
  const route = parseHash();
  currentRoute.set(route);
}

// Navigate to a new route
export function navigate(page, params = {}) {
  let hash = `#/${page}`;

  // Add path parameters
  if (page === 'user-profile' && params.userId) {
    hash = `#/users/${params.userId}`;
    delete params.userId;
  }
  if (page === 'request' && params.requestId) {
    hash = `#/requests/${params.requestId}`;
    delete params.requestId;
  }

  // Add query parameters
  const queryParams = Object.keys(params);
  if (queryParams.length > 0) {
    const queryString = queryParams
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
      .join('&');
    hash += `?${queryString}`;
  }

  // Assigning location.hash is a navigation: on a phone it flashes the address bar and the page.
  const from = parseHash();
  if (hash === (window.location.hash || '#/')) return;
  const route = parseHashOf(hash);
  const samePage = route.page === from.page;
  window.history[samePage ? 'replaceState' : 'pushState'](null, '', hash);
  currentRoute.set(route);
  if (!samePage) window.scrollTo(0, 0);
}
