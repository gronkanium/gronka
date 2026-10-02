// Operations in flight, in this process's memory only. A request leaves no record of its own:
// when it ends, one anonymous count goes to command_counts, and a failure also leaves an alert.

import crypto from 'crypto';
import { countCommand } from './database.js';
import { createLogger } from './logger.js';

const operations = [];
const MAX_OPERATIONS = 100;

const logger = createLogger('bot');

const pendingWrites = new Set();

function count(operation) {
  const write = countCommand(operation.type, operation.status).catch(error => {
    logger.error(`Failed to count a ${operation.type}: ${error.message}`);
  });
  pendingWrites.add(write);
  write.finally(() => pendingWrites.delete(write));
}

export async function flushAllOperationLogs() {
  while (pendingWrites.size > 0) {
    await Promise.allSettled([...pendingWrites]);
  }
}

function newOperation(type, status, context, id = null) {
  const operation = {
    id: id ?? `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
    type,
    status,
    fileSize: null,
    timestamp: Date.now(),
    startTime: Date.now(),
    error: null,
    source: context.commandSource ?? null,
    performanceMetrics: { duration: null, steps: [] },
  };
  operations.unshift(operation);
  if (operations.length > MAX_OPERATIONS) operations.pop();
  return operation;
}

// A request refused before it started; the caller records the failure if it wants one.
export function createFailedOperation(type, errorMessage, context = {}) {
  const operation = newOperation(type, 'error', context);
  operation.error = errorMessage;
  operation.performanceMetrics.duration = 0;
  count(operation);
  return operation.id;
}

// resumeId continues a job a stopped worker left behind under the same operation.
export function createOperation(type, context = {}, resumeId = null) {
  const operation = newOperation(type, 'pending', context, resumeId);
  logger.debug(`Operation ${type} created [op: ${operation.id}]`);
  return operation.id;
}

export function updateOperationStatus(operationId, status, data = {}) {
  const operation = operations.find(op => op.id === operationId);
  if (!operation) {
    logger.warn(`Operation ${operationId} not found`);
    return;
  }
  operation.status = status;
  operation.timestamp = Date.now();
  if (data.fileSize !== undefined) operation.fileSize = data.fileSize;
  if (data.error !== undefined) operation.error = data.error;
  if (status === 'success' || status === 'error') {
    operation.performanceMetrics.duration = Math.max(1, Date.now() - operation.startTime);
    count(operation);
  }
}

export function getRecentOperations(limit = null) {
  return limit === null ? [...operations] : operations.slice(0, limit);
}

export function getOperation(operationId) {
  return operations.find(op => op.id === operationId) || null;
}

export function logOperationStep(operationId, step, status, data = {}) {
  const operation = operations.find(op => op.id === operationId);
  if (!operation) {
    logger.warn(`Operation ${operationId} not found`);
    return;
  }
  const now = Date.now();
  operation.performanceMetrics.steps.push({
    step,
    status,
    timestamp: now,
    duration: now - operation.startTime,
    message: data.message ?? null,
  });
  logger.debug(`Operation step ${step} ${status} [op: ${operationId}]`);
}

// Operations of this process still running after maxAgeMinutes are marked failed.
export function cleanupStuckOperations(maxAgeMinutes = 10) {
  const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
  let cleaned = 0;
  for (const op of operations) {
    if ((op.status === 'running' || op.status === 'pending') && op.timestamp < cutoff) {
      updateOperationStatus(op.id, 'error', { error: 'Operation timed out' });
      cleaned++;
    }
  }
  if (cleaned) logger.warn(`Marked ${cleaned} stuck operation(s) as failed`);
  return cleaned;
}
