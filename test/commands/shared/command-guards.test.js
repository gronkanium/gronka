import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  missingInputRefusal,
  resolveTimeOptions,
} from '../../../src/commands/shared/command-guards.js';
import { createFakeInteraction } from '../../helpers/fake-interaction.js';

function withTimes(start, end) {
  const { interaction, calls } = createFakeInteraction({ deferred: false });
  const given = { start, end };
  interaction.options = { getString: name => given[name] ?? null };
  return { interaction, calls };
}

describe('missingInputRefusal', () => {
  test('a mention that replies to a message points at the apps menu', () => {
    const refusal = missingInputRefusal(
      { isPrefixCommand: true, message: { reference: { messageId: '1' } } },
      'convert',
      'please provide a file.'
    );
    assert.match(refusal.message, /apps > convert/);
    assert.ok(refusal.detail);
  });

  test('anything else keeps the plain message', () => {
    assert.deepEqual(missingInputRefusal({}, 'convert', 'please provide a file.'), {
      message: 'please provide a file.',
    });
    assert.deepEqual(missingInputRefusal({ isPrefixCommand: true, message: {} }, 'optimize', 'x'), {
      message: 'x',
    });
  });
});

describe('resolveTimeOptions', () => {
  test('turns start and end into a start and a duration', async () => {
    const cases = [
      [['1:00', '90'], { startTime: 60, endTime: 90, duration: 30 }],
      [['12.5', null], { startTime: 12.5, endTime: null, duration: null }],
      [[null, '1:02:30'], { startTime: null, endTime: 3750, duration: 3750 }],
      [['0', '2.5'], { startTime: 0, endTime: 2.5, duration: 2.5 }],
      [[null, null], { startTime: null, endTime: null, duration: null }],
    ];
    for (const [[start, end], expected] of cases) {
      const { interaction, calls } = withTimes(start, end);
      assert.deepEqual(await resolveTimeOptions(interaction, { type: 'download' }), expected);
      assert.equal(calls.reply.length, 0);
    }
  });

  test('a backwards or empty range is refused with a reply', async () => {
    for (const [start, end] of [
      ['20', '10'],
      ['5', '5'],
    ]) {
      const { interaction, calls } = withTimes(start, end);
      assert.equal(await resolveTimeOptions(interaction, { type: 'convert' }), null);
      assert.equal(calls.reply[0].content, 'the end time has to be after the start time.');
    }
  });

  test('a value that is not a time names the option it came from', async () => {
    const { interaction, calls } = withTimes('soon', null);
    assert.equal(await resolveTimeOptions(interaction, { type: 'download' }), null);
    assert.match(calls.reply[0].content, /^start: /);
  });
});
