import { AsyncLocalStorage } from 'node:async_hooks';

// Set by the worker around a job: {operationId} to resume a retried job's operation, and
// onOperation(id) to learn the operation a first attempt created.
export const jobContext = new AsyncLocalStorage();
