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

test('requests keeps userId as a filter instead of opening the profile', () => {
  navigate('requests', { userId: '123' });
  expect(read(currentRoute).page).toBe('requests');
  expect(read(currentRoute).params.$userId).toBe('123');
});

test('user-profile and request take their ids from the path', () => {
  navigate('user-profile', { userId: '123' });
  expect(read(currentRoute)).toEqual({ page: 'user-profile', params: { userId: '123' } });
  navigate('request', { requestId: 'abc', span: 's1' });
  expect(read(currentRoute).page).toBe('request');
  expect(read(currentRoute).params.requestId).toBe('abc');
  expect(read(currentRoute).params.$span).toBe('s1');
});
