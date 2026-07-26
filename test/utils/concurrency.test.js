import { test, describe } from 'bun:test';
import assert from 'node:assert';
import {
  createSlotLimiter,
  cobaltSlots,
  ytdlpSlots,
  mediaSlots,
} from '../../src/utils/concurrency.js';

// A deferred promise plus its resolver, so a test can hold a "download" open until it chooses.
function deferred() {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createSlotLimiter', () => {
  test('never runs more than the max concurrently, and queues the rest', async () => {
    const limiter = createSlotLimiter('test', 2);

    let running = 0;
    let peak = 0;
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started = [false, false, false, false];

    const tasks = gates.map((gate, i) =>
      limiter.run(async () => {
        started[i] = true;
        running++;
        peak = Math.max(peak, running);
        await gate.promise;
        running--;
      })
    );

    // Let the microtask queue settle: exactly `max` tasks should have started, rest queued.
    await new Promise(r => setTimeout(r, 10));
    assert.deepStrictEqual(started, [true, true, false, false], 'only 2 start, 2 queued');
    assert.strictEqual(limiter.stats().active, 2);
    assert.strictEqual(limiter.stats().queued, 2);

    // Release the first; the third should take its freed slot.
    gates[0].resolve();
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(started[2], true, 'third starts once a slot frees');
    assert.strictEqual(started[3], false, 'fourth still waits');

    // Drain everything.
    gates[1].resolve();
    gates[2].resolve();
    gates[3].resolve();
    await Promise.all(tasks);

    assert.strictEqual(peak, 2, 'concurrency never exceeded the cap');
    assert.strictEqual(limiter.stats().active, 0, 'all slots released');
    assert.strictEqual(limiter.stats().queued, 0);
  });

  test('releases the slot even when the task throws', async () => {
    const limiter = createSlotLimiter('test-throw', 2);
    await assert.rejects(
      limiter.run(async () => {
        throw new Error('boom');
      }),
      /boom/
    );
    assert.strictEqual(limiter.stats().active, 0, 'a throwing task must not leak its slot');
  });

  test('returns the task result', async () => {
    const limiter = createSlotLimiter('test-result', 2);
    const result = await limiter.run(async () => 42);
    assert.strictEqual(result, 42);
  });

  test('limiters are independent of one another', async () => {
    const a = createSlotLimiter('test-a', 1);
    const b = createSlotLimiter('test-b', 1);
    const gate = deferred();

    const held = a.run(() => gate.promise);
    await new Promise(r => setTimeout(r, 10));

    // b's slot must be unaffected by a being saturated.
    assert.strictEqual(await b.run(async () => 'ran'), 'ran');

    gate.resolve();
    await held;
  });
});

describe('shared limiters', () => {
  // These caps bound RAM and CPU on paths that buffer whole files. Raising one is a deliberate
  // capacity decision, not a refactor side effect - hence pinning them here.
  test('cobalt, yt-dlp and media downloads are each capped at 2', () => {
    assert.strictEqual(cobaltSlots.stats().max, 2);
    assert.strictEqual(ytdlpSlots.stats().max, 2);
    assert.strictEqual(mediaSlots.stats().max, 2);
  });
});
