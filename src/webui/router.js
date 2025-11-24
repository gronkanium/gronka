/**
 * Simple hash-based router for Svelte
 */

import { writable, derived } from 'svelte/store';

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
  const hash = window.location.hash.slice(1) || '/';
  const [path, queryString] = hash.split('?');
  const segments = path.split('/').filter(Boolean);

  let page = segments[0] || 'dashboard';
  const params = {};

  // Parse path parameters (e.g., /users/123 -> {userId: '123'})
  if (page === 'users' && segments[1]) {
    params.userId = segments[1];
    page = 'user-profile';
  } else if (page === 'operations' && segments[1]) {
    params.operationId = segments[1];
    page = 'operation-detail';
  }

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
  window.addEventListener('hashchange', () => {
    const route = parseHash();
    currentRoute.set(route);
  });

  // Parse initial route
  const route = parseHash();
  currentRoute.set(route);
}

// Navigate to a new route
export function navigate(page, params = {}) {
  let hash = `#/${page}`;

  // Add path parameters
  if (params.userId) {
    hash = `#/users/${params.userId}`;
    delete params.userId;
  } else if (params.operationId) {
    hash = `#/operations/${params.operationId}`;
    delete params.operationId;
  }

  // Add query parameters
  const queryParams = Object.keys(params);
  if (queryParams.length > 0) {
    const queryString = queryParams
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
      .join('&');
    hash += `?${queryString}`;
  }

  window.location.hash = hash;
}

// Derived store for checking active page
export function isActivePage(page) {
  return derived(currentRoute, $route => $route.page === page);
}
