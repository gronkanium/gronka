import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseTimestamp, parseTimestampOrThrow } from '../../src/utils/timestamp.js';

describe('timestamp utilities', () => {
  describe('parseTimestamp', () => {
    describe('plain numbers (seconds)', () => {
      test('parses integer seconds', () => {
        assert.deepStrictEqual(parseTimestamp('43'), { seconds: 43, error: null });
        assert.deepStrictEqual(parseTimestamp('103'), { seconds: 103, error: null });
        assert.deepStrictEqual(parseTimestamp('0'), { seconds: 0, error: null });
      });

      test('parses decimal seconds', () => {
        assert.deepStrictEqual(parseTimestamp('43.5'), { seconds: 43.5, error: null });
        assert.deepStrictEqual(parseTimestamp('0.5'), { seconds: 0.5, error: null });
        assert.deepStrictEqual(parseTimestamp('103.25'), { seconds: 103.25, error: null });
      });

      test('parses numeric type', () => {
        assert.deepStrictEqual(parseTimestamp(43), { seconds: 43, error: null });
        assert.deepStrictEqual(parseTimestamp(43.5), { seconds: 43.5, error: null });
        assert.deepStrictEqual(parseTimestamp(0), { seconds: 0, error: null });
      });
    });

    describe('MM:SS format', () => {
      test('parses standard MM:SS', () => {
        assert.deepStrictEqual(parseTimestamp('0:43'), { seconds: 43, error: null });
        assert.deepStrictEqual(parseTimestamp('1:43'), { seconds: 103, error: null });
        assert.deepStrictEqual(parseTimestamp('1:00'), { seconds: 60, error: null });
        assert.deepStrictEqual(parseTimestamp('0:00'), { seconds: 0, error: null });
      });

      test('parses MM:SS with leading zeros', () => {
        assert.deepStrictEqual(parseTimestamp('01:43'), { seconds: 103, error: null });
        assert.deepStrictEqual(parseTimestamp('00:05'), { seconds: 5, error: null });
      });

      test('allows minutes > 59', () => {
        assert.deepStrictEqual(parseTimestamp('90:00'), { seconds: 5400, error: null });
        assert.deepStrictEqual(parseTimestamp('90:30'), { seconds: 5430, error: null });
        assert.deepStrictEqual(parseTimestamp('120:00'), { seconds: 7200, error: null });
      });

      test('parses MM:SS with decimal seconds', () => {
        assert.deepStrictEqual(parseTimestamp('1:43.5'), { seconds: 103.5, error: null });
        assert.deepStrictEqual(parseTimestamp('0:30.25'), { seconds: 30.25, error: null });
      });

      test('rejects seconds >= 60', () => {
        const result = parseTimestamp('1:60');
        assert.strictEqual(result.seconds, null);
        assert.strictEqual(result.error, 'seconds must be 0-59 in MM:SS format');

        const result2 = parseTimestamp('1:99');
        assert.strictEqual(result2.seconds, null);
        assert.strictEqual(result2.error, 'seconds must be 0-59 in MM:SS format');
      });
    });

    describe('HH:MM:SS format', () => {
      test('parses standard HH:MM:SS', () => {
        assert.deepStrictEqual(parseTimestamp('1:05:30'), { seconds: 3930, error: null });
        assert.deepStrictEqual(parseTimestamp('0:01:30'), { seconds: 90, error: null });
        assert.deepStrictEqual(parseTimestamp('2:00:00'), { seconds: 7200, error: null });
      });

      test('parses HH:MM:SS with leading zeros', () => {
        assert.deepStrictEqual(parseTimestamp('01:05:30'), { seconds: 3930, error: null });
        assert.deepStrictEqual(parseTimestamp('00:00:05'), { seconds: 5, error: null });
      });

      test('parses HH:MM:SS with decimal seconds', () => {
        assert.deepStrictEqual(parseTimestamp('1:05:30.5'), { seconds: 3930.5, error: null });
        assert.deepStrictEqual(parseTimestamp('0:00:00.5'), { seconds: 0.5, error: null });
      });

      test('rejects minutes >= 60 in HH:MM:SS', () => {
        const result = parseTimestamp('1:60:30');
        assert.strictEqual(result.seconds, null);
        assert.strictEqual(result.error, 'minutes must be 0-59 in HH:MM:SS format');
      });

      test('rejects seconds >= 60 in HH:MM:SS', () => {
        const result = parseTimestamp('1:05:60');
        assert.strictEqual(result.seconds, null);
        assert.strictEqual(result.error, 'seconds must be 0-59 in HH:MM:SS format');
      });
    });

    describe('null/undefined/empty handling', () => {
      test('returns null for null input', () => {
        assert.deepStrictEqual(parseTimestamp(null), { seconds: null, error: null });
      });

      test('returns null for undefined input', () => {
        assert.deepStrictEqual(parseTimestamp(undefined), { seconds: null, error: null });
      });

      test('returns null for empty string', () => {
        assert.deepStrictEqual(parseTimestamp(''), { seconds: null, error: null });
      });

      test('returns null for whitespace-only string', () => {
        assert.deepStrictEqual(parseTimestamp('   '), { seconds: null, error: null });
      });
    });

    describe('whitespace handling', () => {
      test('trims leading and trailing whitespace', () => {
        assert.deepStrictEqual(parseTimestamp('  43  '), { seconds: 43, error: null });
        assert.deepStrictEqual(parseTimestamp('  1:43  '), { seconds: 103, error: null });
        assert.deepStrictEqual(parseTimestamp('\t1:05:30\n'), { seconds: 3930, error: null });
      });
    });

    describe('invalid formats', () => {
      test('rejects non-numeric strings', () => {
        const result = parseTimestamp('abc');
        assert.strictEqual(result.seconds, null);
        assert.ok(result.error.includes('invalid timestamp format'));
      });

      test('rejects negative numbers', () => {
        const result = parseTimestamp(-10);
        assert.strictEqual(result.seconds, null);
        assert.strictEqual(result.error, 'timestamp cannot be negative');
      });

      test('rejects partial formats', () => {
        const result1 = parseTimestamp(':43');
        assert.strictEqual(result1.seconds, null);
        assert.ok(result1.error.includes('invalid timestamp format'));

        const result2 = parseTimestamp('1:');
        assert.strictEqual(result2.seconds, null);
        assert.ok(result2.error.includes('invalid timestamp format'));
      });

      test('rejects four-part timestamps', () => {
        const result = parseTimestamp('1:2:3:4');
        assert.strictEqual(result.seconds, null);
        assert.ok(result.error.includes('invalid timestamp format'));
      });

      test('rejects timestamps with extra colons', () => {
        const result = parseTimestamp('1::30');
        assert.strictEqual(result.seconds, null);
        assert.ok(result.error.includes('invalid timestamp format'));
      });
    });

    describe('backwards compatibility', () => {
      test('handles all documented examples', () => {
        // From the user's examples
        assert.deepStrictEqual(parseTimestamp('43'), { seconds: 43, error: null });
        assert.deepStrictEqual(parseTimestamp('103'), { seconds: 103, error: null });
        assert.deepStrictEqual(parseTimestamp('0:43'), { seconds: 43, error: null });
        assert.deepStrictEqual(parseTimestamp('1:43'), { seconds: 103, error: null });
        assert.deepStrictEqual(parseTimestamp('1:05:30'), { seconds: 3930, error: null });
      });
    });
  });

  describe('parseTimestampOrThrow', () => {
    test('returns seconds for valid input', () => {
      assert.strictEqual(parseTimestampOrThrow('43'), 43);
      assert.strictEqual(parseTimestampOrThrow('1:43'), 103);
      assert.strictEqual(parseTimestampOrThrow(null), null);
    });

    test('throws error for invalid input', () => {
      assert.throws(() => parseTimestampOrThrow('abc', 'start_time'), /invalid start_time:/);

      assert.throws(() => parseTimestampOrThrow('1:60', 'end_time'), /invalid end_time:/);
    });

    test('uses default field name in error', () => {
      assert.throws(() => parseTimestampOrThrow('abc'), /invalid timestamp:/);
    });
  });
});
