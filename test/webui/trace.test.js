import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { buildTimeline, buildTree, highlight, pctOf, spanAttrs } from '../../src/webui/trace.js';

const op = { type: 'download', latestTimestamp: 0 };
const trace = {
  logs: [
    { timestamp: 1000, step: 'created', status: 'pending' },
    { timestamp: 4000, step: 'status_update', status: 'error', message: 'boom' },
  ],
};
const logs = [
  {
    timestamp: 2000,
    message: 'resolving',
    level: 'INFO',
    component: 'download',
    metadata: { worker: 'w1' },
  },
  {
    timestamp: 3000,
    message: 'slow',
    level: 'WARN',
    component: 'download',
    metadata: { worker: 'w1' },
  },
];

describe('buildTimeline', () => {
  test('merges steps and logs in time order and groups runs by bot or worker', () => {
    const t = buildTimeline(op, trace, logs);
    assert.strictEqual(t.span, 3000);
    assert.deepStrictEqual(
      t.groups.map(g => [g.group, g.rows.map(r => r.label)]),
      [
        ['bot', ['received /download']],
        ['w1', ['resolving', 'slow']],
        ['bot', ['failed: boom']],
      ]
    );
  });

  test('is null with nothing recorded', () => {
    assert.strictEqual(buildTimeline(op, { logs: [] }, []), null);
    assert.strictEqual(buildTimeline(null, trace, logs), null);
  });
});

describe('buildTree', () => {
  test('numbers worker attempts and counts errors per group', () => {
    const { groups, spans } = buildTree(buildTimeline(op, trace, logs));
    assert.deepStrictEqual(
      groups.map(g => [g.label, g.kids.length, g.errors]),
      [
        ['Bot gateway', 1, 0],
        ['Attempt 1 · w1', 2, 0],
        ['Bot gateway', 1, 1],
      ]
    );
    assert.deepStrictEqual(
      spans.map(s => s.tone),
      ['bot', 'worker', 'warn', 'err']
    );
  });
});

test('highlight marks every case-insensitive match', () => {
  assert.deepStrictEqual(highlight('Fail then FAIL', 'fail'), [
    { t: 'Fail', m: true },
    { t: ' then ' },
    { t: 'FAIL', m: true },
  ]);
  assert.deepStrictEqual(highlight('abc', ''), [{ t: 'abc' }]);
});

test('pctOf flags tiny shares instead of rounding them to zero', () => {
  assert.strictEqual(pctOf(1, 10_000), '<0.1%');
  assert.strictEqual(pctOf(2500, 10_000), '25.0%');
});

test('spanAttrs flattens log metadata and skips empty values', () => {
  const [span] = buildTree(buildTimeline(op, { logs: [] }, logs)).spans;
  assert.deepStrictEqual(spanAttrs(span), [
    ['level', 'INFO'],
    ['component', 'download'],
    ['worker', 'w1'],
  ]);
});
