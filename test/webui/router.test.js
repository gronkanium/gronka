import { test, expect, beforeAll, afterAll } from 'bun:test';
import { get as read } from 'svelte/store';

let navigate;
let currentRoute;

beforeAll(async () => {
  const state = { hash: '#/' };
  globalThis.window = {
    location: {
      get hash() {
        return state.hash;
      },
    },
    history: {
      pushState: (_s, _t, h) => (state.hash = h),
      replaceState: (_s, _t, h) => (state.hash = h),
    },
    scrollTo: () => {},
  };
  ({ navigate, currentRoute } = await import('../../src/webui/utils/router.js'));
});

afterAll(() => {
  delete globalThis.window;
});

test('query params land prefixed so they cannot touch prototype keys', () => {
  navigate('issues', { issue: 'abc', __proto__x: '1' });
  expect(read(currentRoute).page).toBe('issues');
  expect(read(currentRoute).params.$issue).toBe('abc');
});
