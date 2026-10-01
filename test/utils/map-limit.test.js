import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../../src/utils/map-limit.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 1));

test('keeps order and never runs more than the limit at once', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async n => {
    peak = Math.max(peak, ++running);
    await tick();
    running--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70]);
  assert.equal(peak, 3);
});

test('rejects on the first failure and starts nothing after it', async () => {
  const started = [];
  await assert.rejects(
    mapLimit([1, 2, 3, 4, 5, 6], 2, async n => {
      started.push(n);
      await tick();
      if (n === 1) throw new Error('boom');
    }),
    /boom/
  );
  await tick();
  assert.ok(started.length <= 3, `started ${started.length}`);
});
