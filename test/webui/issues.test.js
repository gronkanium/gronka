import { test, describe } from 'bun:test';
import assert from 'node:assert';
import {
  groupIssues,
  stateOf,
  isOpen,
  isNew,
  inTab,
  buckets,
  abbr,
  failureOf,
} from '../../src/webui/issues.js';

const reason = (text, extra = {}) => ({
  reason: text,
  count: 1,
  commands: ['download'],
  classes: [],
  lastSeen: 100,
  ...extra,
});

describe('issue grouping', () => {
  test('variants merge their event times and keep no user information', () => {
    const [g] = groupIssues([
      reason('video is 61m long', { times: [1, 2] }),
      reason('video is 62m long', { times: [3] }),
    ]);
    assert.deepStrictEqual(g.times.sort(), [1, 2, 3]);
    assert.ok(!('users' in g) && !('userIds' in g));
  });

  test('an issue is new only when every variant first appeared in the last day', () => {
    const now = 10 * 24 * 3600e3;
    const [g] = groupIssues([
      reason('could not deliver 1', { firstSeen: now - 3600e3 }),
      reason('could not deliver 2', { firstSeen: now - 3 * 24 * 3600e3 }),
    ]);
    assert.strictEqual(isNew(g, now), false);
    const [fresh] = groupIssues([reason('could not deliver 1', { firstSeen: now - 3600e3 })]);
    assert.strictEqual(isNew(fresh, now), true);
  });

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

describe('inTab', () => {
  const defect = { kind: 'defect' };
  test('open tabs take open and regressed issues of their kind', () => {
    assert.ok(inTab('open', defect, 'regressed'));
    assert.ok(inTab('defects', defect, 'open'));
    assert.ok(!inTab('upstream', defect, 'open'));
    assert.ok(!inTab('open', defect, 'muted'));
  });
  test('muted and resolved tabs take only their own state', () => {
    assert.ok(inTab('muted', defect, 'muted'));
    assert.ok(!inTab('resolved', defect, 'regressed'));
  });
});

describe('buckets', () => {
  test('counts each time into its hour, ending with the current one', () => {
    const at = new Date(2026, 0, 2, 10, 30).getTime();
    const b = buckets([at, at - 3600e3, at - 3600e3 + 60e3, at - 5 * 3600e3], 'hour', 3, at);
    assert.deepStrictEqual(
      b.map(x => x.n),
      [0, 2, 1]
    );
    assert.strictEqual(b.at(-1).at, new Date(2026, 0, 2, 10).getTime());
  });
  test('day buckets start at local midnight', () => {
    const at = new Date(2026, 0, 2, 10).getTime();
    assert.strictEqual(buckets([], 'day', 1, at)[0].at, new Date(2026, 0, 2).getTime());
  });
});

test('abbr shortens big counts', () => {
  assert.deepStrictEqual([999, 1000, 1500, 12_345, 2_500_000, null].map(abbr), [
    '999',
    '1k',
    '1.5k',
    '12k',
    '2.5M',
    '–',
  ]);
});

describe('failure details', () => {
  test('reads link, cause, trail and options, and survives old rows', () => {
    const f = failureOf({
      metadata: JSON.stringify({
        url: 'https://a.test/v',
        cause: 'HTTP 403',
        ref: 'r1',
        trail: [{ step: 'cobalt', error: 'timeout' }, null],
        options: { format: 'mp4' },
      }),
    });
    assert.strictEqual(f.url, 'https://a.test/v');
    assert.strictEqual(f.trail.length, 1);
    assert.deepStrictEqual(f.options, [['format', 'mp4']]);
    const old = failureOf({ metadata: '{"source":"a.test"}' });
    assert.deepStrictEqual([old.url, old.cause, old.trail, old.options], [null, null, [], []]);
    assert.strictEqual(failureOf({ metadata: 'nope' }).url, null);
  });

  test('a non-http link is never offered as a href', () => {
    assert.strictEqual(failureOf({ metadata: '{"url":"javascript:alert(1)"}' }).url, null);
  });

  test('cause groups get their own keys so states never collide with error groups', () => {
    const [a] = groupIssues([reason('HTTP 403')], 'error');
    const [b] = groupIssues([reason('HTTP 403')], 'cause');
    assert.notStrictEqual(a.key, b.key);
  });
});
