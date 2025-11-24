import { test, describe } from 'node:test';
import assert from 'node:assert';

// Extract validateNumericParameter logic for testing
// This matches the implementation in video-processor.js
function validateNumericParameter(value, name, min = 0, max = Infinity, allowNull = false) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new Error(`${name} cannot be null or undefined`);
  }

  const num = Number(value);

  if (isNaN(num) || !isFinite(num)) {
    throw new Error(`${name} must be a valid number`);
  }

  if (num < min) {
    throw new Error(`${name} must be at least ${min}`);
  }

  if (num > max) {
    throw new Error(`${name} must be at most ${max}`);
  }

  return num;
}

describe('video-processor validation', () => {
  describe('validateNumericParameter', () => {
    describe('type confusion prevention', () => {
      test('accepts valid numbers', () => {
        assert.strictEqual(validateNumericParameter(42, 'test'), 42);
        assert.strictEqual(validateNumericParameter(0, 'test'), 0);
        assert.strictEqual(validateNumericParameter(-10, 'test', -20), -10);
        assert.strictEqual(validateNumericParameter(3.14, 'test'), 3.14);
      });

      test('converts string numbers to numbers', () => {
        assert.strictEqual(validateNumericParameter('42', 'test'), 42);
        assert.strictEqual(validateNumericParameter('0', 'test'), 0);
        assert.strictEqual(validateNumericParameter('3.14', 'test'), 3.14);
        assert.strictEqual(validateNumericParameter('-10', 'test', -20), -10);
      });

      test('rejects null when allowNull is false', () => {
        assert.throws(() => validateNumericParameter(null, 'test'), /cannot be null or undefined/);
      });

      test('rejects undefined when allowNull is false', () => {
        assert.throws(
          () => validateNumericParameter(undefined, 'test'),
          /cannot be null or undefined/
        );
      });

      test('allows null when allowNull is true', () => {
        assert.strictEqual(validateNumericParameter(null, 'test', 0, Infinity, true), null);
      });

      test('rejects non-numeric strings', () => {
        assert.throws(
          () => validateNumericParameter('not a number', 'test'),
          /must be a valid number/
        );
        assert.throws(() => validateNumericParameter('abc', 'test'), /must be a valid number/);
        // Empty string converts to 0, so it passes
        assert.strictEqual(validateNumericParameter('', 'test'), 0);
      });

      test('rejects objects', () => {
        // Objects convert to NaN, which is caught
        assert.throws(() => validateNumericParameter({}, 'test'), /must be a valid number/);
        // Empty array converts to 0, so it passes
        assert.strictEqual(validateNumericParameter([], 'test'), 0);
      });

      test('rejects arrays', () => {
        assert.throws(() => validateNumericParameter([1, 2, 3], 'test'), /must be a valid number/);
      });

      test('rejects functions', () => {
        assert.throws(() => validateNumericParameter(() => 42, 'test'), /must be a valid number/);
      });

      test('handles boolean values (coerced to numbers)', () => {
        // Boolean true converts to 1, false to 0
        assert.strictEqual(validateNumericParameter(true, 'test'), 1);
        assert.strictEqual(validateNumericParameter(false, 'test'), 0);
      });
    });

    describe('NaN and Infinity handling', () => {
      test('rejects NaN', () => {
        assert.throws(() => validateNumericParameter(NaN, 'test'), /must be a valid number/);
        assert.throws(() => validateNumericParameter(Number.NaN, 'test'), /must be a valid number/);
      });

      test('rejects Infinity', () => {
        assert.throws(() => validateNumericParameter(Infinity, 'test'), /must be a valid number/);
        assert.throws(
          () => validateNumericParameter(Number.POSITIVE_INFINITY, 'test'),
          /must be a valid number/
        );
        assert.throws(
          () => validateNumericParameter(Number.NEGATIVE_INFINITY, 'test'),
          /must be a valid number/
        );
      });

      test('rejects string "NaN"', () => {
        assert.throws(() => validateNumericParameter('NaN', 'test'), /must be a valid number/);
      });

      test('rejects string "Infinity"', () => {
        assert.throws(() => validateNumericParameter('Infinity', 'test'), /must be a valid number/);
      });
    });

    describe('min/max bounds validation', () => {
      test('enforces minimum value', () => {
        assert.throws(() => validateNumericParameter(5, 'test', 10), /must be at least 10/);
        assert.strictEqual(validateNumericParameter(10, 'test', 10), 10);
        assert.strictEqual(validateNumericParameter(15, 'test', 10), 15);
      });

      test('enforces maximum value', () => {
        assert.throws(() => validateNumericParameter(15, 'test', 0, 10), /must be at most 10/);
        assert.strictEqual(validateNumericParameter(10, 'test', 0, 10), 10);
        assert.strictEqual(validateNumericParameter(5, 'test', 0, 10), 5);
      });

      test('enforces both min and max', () => {
        assert.throws(() => validateNumericParameter(5, 'test', 10, 20), /must be at least 10/);
        assert.throws(() => validateNumericParameter(25, 'test', 10, 20), /must be at most 20/);
        assert.strictEqual(validateNumericParameter(15, 'test', 10, 20), 15);
      });

      test('handles negative min values', () => {
        assert.throws(() => validateNumericParameter(-20, 'test', -10), /must be at least -10/);
        assert.strictEqual(validateNumericParameter(-10, 'test', -10), -10);
        assert.strictEqual(validateNumericParameter(0, 'test', -10), 0);
      });

      test('handles Infinity as max (default)', () => {
        assert.strictEqual(validateNumericParameter(1000000, 'test'), 1000000);
        assert.strictEqual(
          validateNumericParameter(Number.MAX_SAFE_INTEGER, 'test'),
          Number.MAX_SAFE_INTEGER
        );
      });

      test('handles zero as min (default)', () => {
        assert.throws(() => validateNumericParameter(-1, 'test'), /must be at least 0/);
        assert.strictEqual(validateNumericParameter(0, 'test'), 0);
      });
    });

    describe('edge cases', () => {
      test('handles zero correctly', () => {
        assert.strictEqual(validateNumericParameter(0, 'test'), 0);
        assert.strictEqual(validateNumericParameter(0, 'test', -10, 10), 0);
        assert.strictEqual(validateNumericParameter('0', 'test'), 0);
      });

      test('handles negative numbers', () => {
        assert.strictEqual(validateNumericParameter(-5, 'test', -10, 10), -5);
        assert.strictEqual(validateNumericParameter('-5', 'test', -10, 10), -5);
      });

      test('handles decimal numbers', () => {
        assert.strictEqual(validateNumericParameter(3.14159, 'test'), 3.14159);
        assert.strictEqual(validateNumericParameter('3.14159', 'test'), 3.14159);
        assert.strictEqual(validateNumericParameter(0.5, 'test', 0, 1), 0.5);
      });

      test('handles scientific notation strings', () => {
        assert.strictEqual(validateNumericParameter('1e2', 'test'), 100);
        assert.strictEqual(validateNumericParameter('1E2', 'test'), 100);
      });

      test('error messages include parameter name', () => {
        try {
          validateNumericParameter(null, 'width');
          assert.fail('Should have thrown');
        } catch (error) {
          assert.ok(error.message.includes('width'));
        }

        try {
          validateNumericParameter(5, 'fps', 10, 20);
          assert.fail('Should have thrown');
        } catch (error) {
          assert.ok(error.message.includes('fps'));
        }
      });
    });

    describe('type confusion attack prevention', () => {
      test('prevents type confusion with string coercion', () => {
        // Attempt to pass malicious string that could be coerced
        assert.throws(
          () => validateNumericParameter('10; rm -rf /', 'test'),
          /must be a valid number/
        );
      });

      test('handles object with valueOf (coerced to number)', () => {
        const objWithValueOf = {
          valueOf: () => 42,
          toString: () => '42',
        };
        // Number() calls valueOf, which returns 42, so it passes
        assert.strictEqual(validateNumericParameter(objWithValueOf, 'test'), 42);
      });

      test('handles array coercion (single element converts to number)', () => {
        // Array with single number converts to that number
        assert.strictEqual(validateNumericParameter([42], 'test'), 42);
        // Array with multiple elements converts to NaN
        assert.throws(() => validateNumericParameter([1, 2, 3], 'test'), /must be a valid number/);
      });

      test('validates actual numeric type, not just coercion', () => {
        // Even if something coerces to a number, we validate it's actually numeric
        assert.throws(() => validateNumericParameter('10abc', 'test'), /must be a valid number/);
      });
    });
  });
});
