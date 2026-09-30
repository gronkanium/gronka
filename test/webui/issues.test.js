import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { groupIssues, stateOf, isOpen } from '../../src/webui/issues.js';

const reason = (text, extra = {}) => ({
  reason: text,
  count: 1,
  commands: ['download'],
  classes: [],
  lastSeen: 100,
  ...extra,
});

describe('issue grouping', () => {
  test('variants that differ only in numbers or charset become one issue', () => {
    const groups = groupIssues([
      reason('video is 64m 48s long, maximum allowed is 60 minutes.', { count: 2 }),
      reason('video is 113m 18s long, maximum allowed is 60 minutes.'),
      reason('unsupported content type: text/html; charset=utf-8'),
      reason('unsupported content type: text/html; charset=UTF-8'),
    ]);
    assert.strictEqual(groups.length, 2);
    assert.deepStrictEqual(
      groups.map(g => [g.title, g.count, g.members.length]),
      [
        ['video is Nm Ns long, maximum allowed is N minutes.', 3, 2],
        ['unsupported content type: text/html', 2, 2],
      ]
    );
  });

  test('recorded error classes decide the kind, a defect class wins, text is only a fallback', () => {
    const [user, upstream, mixed, guessed] = groupIssues([
      reason('a', { classes: ['ValidationError'], count: 4 }),
      reason('b', { classes: ['NetworkError'], count: 3 }),
      reason('c', { classes: ['TypeError', 'ValidationError'], count: 2 }),
      reason('tiktok.com is blocking downloads'),
    ]);
    assert.deepStrictEqual(
      [user.kind, upstream.kind, mixed.kind, guessed.kind],
      ['user', 'upstream', 'defect', 'upstream']
    );
    assert.strictEqual(guessed.basis, 'by a guess from the message');
  });
});

describe('issue state', () => {
  const [g] = groupIssues([reason('boom', { lastSeen: 1000 })]);

  test('a resolved issue reopens as regressed when it happens after the resolve', () => {
    assert.strictEqual(stateOf(g, { [g.key]: { state: 'resolved', at: 2000 } }), 'resolved');
    assert.strictEqual(stateOf(g, { [g.key]: { state: 'resolved', at: 500 } }), 'regressed');
    assert.ok(isOpen(g, { [g.key]: { state: 'resolved', at: 500 } }));
  });

  test('a mute expires', () => {
    assert.strictEqual(stateOf(g, { [g.key]: { state: 'muted', until: 3000 } }, 2000), 'muted');
    assert.strictEqual(stateOf(g, { [g.key]: { state: 'muted', until: 3000 } }, 4000), 'open');
  });
});
