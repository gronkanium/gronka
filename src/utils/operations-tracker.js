// A request leaves one anonymous count when it settles, and nothing else of its own.
import { AsyncLocalStorage } from 'node:async_hooks';
import { countCommand } from './database.js';
import { createLogger } from './logger.js';

const logger = createLogger('bot');
const request = new AsyncLocalStorage();
const pendingWrites = new Set();

export function countOutcome(type, outcome) {
  const write = countCommand(type, outcome).catch(error => {
    logger.error(`Failed to count a ${type}: ${error.message}`);
  });
  pendingWrites.add(write);
  write.finally(() => pendingWrites.delete(write));
}

export async function flushCounts() {
  while (pendingWrites.size > 0) {
    await Promise.allSettled([...pendingWrites]);
  }
}

// Runs a command and counts it once when fn settles; the outcome is set by succeed() or failed().
export async function trackRequest(type, fn) {
  const state = { outcome: null };
  try {
    return await request.run(state, fn);
  } finally {
    countOutcome(type, state.outcome ?? 'error');
  }
}

export const requestOutcome = () => request.getStore()?.outcome ?? null;

export function succeed() {
  const state = request.getStore();
  if (state) state.outcome = 'success';
}

// Marks the running request failed; false when there is none, so the caller counts it itself.
export function failed() {
  const state = request.getStore();
  if (!state) return false;
  state.outcome = 'error';
  return true;
}
