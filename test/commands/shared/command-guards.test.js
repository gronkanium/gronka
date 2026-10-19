import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { missingInputRefusal } from '../../../src/commands/shared/command-guards.js';

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
