import { test, expect, describe, beforeAll } from 'bun:test';
import {
  createOperation,
  createFailedOperation,
  updateOperationStatus,
  logOperationStep,
  getOperation,
  getRecentOperations,
  cleanupStuckOperations,
  flushAllOperationLogs,
} from '../../src/utils/operations-tracker.js';
import { initDatabase, getCommandTotals } from '../../src/utils/database.js';

const total = async (command, outcome) =>
  (await getCommandTotals()).find(r => r.command === command && r.outcome === outcome)?.count ?? 0;

describe('operations tracker', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  test('an operation holds no user, only what it is and how it is going', () => {
    const id = createOperation('download', { commandSource: 'slash' });
    const op = getOperation(id);
    expect(op).toMatchObject({ id, type: 'download', status: 'pending', source: 'slash' });
    expect(op).not.toHaveProperty('userId');
    expect(op).not.toHaveProperty('originalUrl');
  });

  test('status changes and steps stay in memory', () => {
    const id = createOperation('convert');
    updateOperationStatus(id, 'running');
    logOperationStep(id, 'render', 'success', { message: 'done', metadata: { secret: 1 } });
    const op = getOperation(id);
    expect(op.status).toBe('running');
    expect(op.performanceMetrics.steps[0]).toMatchObject({ step: 'render', message: 'done' });
    expect(op.performanceMetrics.steps[0]).not.toHaveProperty('metadata');
  });

  test('a finished operation adds one anonymous count for its outcome', async () => {
    const command = `t${Date.now()}`;
    const ok = createOperation(command);
    updateOperationStatus(ok, 'success', { fileSize: 10 });
    const bad = createOperation(command);
    updateOperationStatus(bad, 'error', { error: 'boom' });
    createFailedOperation(command, 'refused');
    await flushAllOperationLogs();
    expect(await total(command, 'success')).toBe(1);
    expect(await total(command, 'error')).toBe(2);
    expect(getOperation(ok).performanceMetrics.duration).toBeGreaterThan(0);
  });

  test('keeps at most 100 operations, newest first', () => {
    for (let i = 0; i < 120; i++) createOperation('optimize');
    const recent = getRecentOperations();
    expect(recent.length).toBe(100);
    expect(recent[0].timestamp).toBeGreaterThanOrEqual(recent[99].timestamp);
  });

  test('stuck operations are marked failed, finished ones are left alone', async () => {
    const stuck = createOperation('download');
    updateOperationStatus(stuck, 'running');
    getOperation(stuck).timestamp = Date.now() - 20 * 60 * 1000;
    const done = createOperation('download');
    updateOperationStatus(done, 'success');
    expect(cleanupStuckOperations(16)).toBeGreaterThanOrEqual(1);
    expect(getOperation(stuck).status).toBe('error');
    expect(getOperation(done).status).toBe('success');
    await flushAllOperationLogs();
  });

  test('unknown ids are ignored', () => {
    expect(() => updateOperationStatus('nope', 'success')).not.toThrow();
    expect(() => logOperationStep('nope', 'x', 'success')).not.toThrow();
    expect(getOperation('nope')).toBeNull();
  });
});
