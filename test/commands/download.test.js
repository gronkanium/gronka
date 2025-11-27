import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('download command parameter conversion', () => {
  /**
   * Helper function to simulate the parameter conversion logic from handleDownloadCommand
   * This matches the logic in src/commands/download.js lines 1311-1328
   */
  function convertTimeParameters(startTime, endTime) {
    let trimStartTime = null;
    let trimDuration = null;

    if (startTime !== null && endTime !== null) {
      // Both provided: use range
      trimStartTime = startTime;
      trimDuration = endTime - startTime;
    } else if (startTime !== null) {
      // Only start_time: start at that time, continue to end
      trimStartTime = startTime;
      trimDuration = null;
    } else if (endTime !== null) {
      // Only end_time: start at beginning, end at that time
      trimStartTime = null;
      trimDuration = endTime;
    }

    return { trimStartTime, trimDuration };
  }

  test('converts both start_time and end_time to startTime and duration', () => {
    const { trimStartTime, trimDuration } = convertTimeParameters(1.5, 2.5);

    assert.strictEqual(trimStartTime, 1.5);
    assert.strictEqual(trimDuration, 1.0); // 2.5 - 1.5
  });

  test('converts only start_time (end_time is null)', () => {
    const { trimStartTime, trimDuration } = convertTimeParameters(1.5, null);

    assert.strictEqual(trimStartTime, 1.5);
    assert.strictEqual(trimDuration, null);
  });

  test('converts only end_time (start_time is null)', () => {
    const { trimStartTime, trimDuration } = convertTimeParameters(null, 2.5);

    assert.strictEqual(trimStartTime, null);
    assert.strictEqual(trimDuration, 2.5);
  });

  test('returns null for both when neither parameter is provided', () => {
    const { trimStartTime, trimDuration } = convertTimeParameters(null, null);

    assert.strictEqual(trimStartTime, null);
    assert.strictEqual(trimDuration, null);
  });

  test('handles zero start_time with end_time', () => {
    const { trimStartTime, trimDuration } = convertTimeParameters(0, 2.5);

    assert.strictEqual(trimStartTime, 0);
    assert.strictEqual(trimDuration, 2.5);
  });

  test('calculates correct duration for decimal values', () => {
    const { trimStartTime, trimDuration } = convertTimeParameters(1.2, 3.7);

    assert.strictEqual(trimStartTime, 1.2);
    assert.strictEqual(trimDuration, 2.5); // 3.7 - 1.2
  });

  test('handles large time values', () => {
    const { trimStartTime, trimDuration } = convertTimeParameters(100.5, 250.8);

    assert.strictEqual(trimStartTime, 100.5);
    assert.strictEqual(trimDuration, 150.3); // 250.8 - 100.5
  });

  test('handles fractional seconds correctly', () => {
    const { trimStartTime, trimDuration } = convertTimeParameters(0.1, 0.9);

    assert.strictEqual(trimStartTime, 0.1);
    assert.strictEqual(trimDuration, 0.8); // 0.9 - 0.1
  });

  test('handles end_time equal to start_time (should be caught by validation)', () => {
    // Note: In actual code, this should be caught by validation (endTime <= startTime)
    // But the conversion logic itself would produce duration = 0
    const { trimStartTime, trimDuration } = convertTimeParameters(2.5, 2.5);

    assert.strictEqual(trimStartTime, 2.5);
    assert.strictEqual(trimDuration, 0); // 2.5 - 2.5 (would be invalid, caught by validation)
  });

  test('handles multiple conversion calls independently', () => {
    const result1 = convertTimeParameters(1.0, 2.0);
    const result2 = convertTimeParameters(3.0, 4.0);
    const result3 = convertTimeParameters(null, null);

    assert.strictEqual(result1.trimStartTime, 1.0);
    assert.strictEqual(result1.trimDuration, 1.0);
    assert.strictEqual(result2.trimStartTime, 3.0);
    assert.strictEqual(result2.trimDuration, 1.0);
    assert.strictEqual(result3.trimStartTime, null);
    assert.strictEqual(result3.trimDuration, null);
  });

  describe('time parameter validation', () => {
    /**
     * Helper function to simulate the validation logic from handleDownloadCommand
     * This matches the logic in src/commands/download.js lines 1297-1309
     */
    function validateTimeParameters(startTime, endTime) {
      if (startTime !== null && endTime !== null) {
        if (endTime <= startTime) {
          return {
            valid: false,
            error: 'end_time must be greater than start_time.',
          };
        }
      }
      return { valid: true };
    }

    test('validates that end_time is greater than start_time', () => {
      const result = validateTimeParameters(2.5, 1.5);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'end_time must be greater than start_time.');
    });

    test('validates that end_time cannot equal start_time', () => {
      const result = validateTimeParameters(2.5, 2.5);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'end_time must be greater than start_time.');
    });

    test('allows valid time range', () => {
      const result = validateTimeParameters(1.5, 2.5);
      assert.strictEqual(result.valid, true);
    });

    test('allows only start_time (no validation needed)', () => {
      const result = validateTimeParameters(1.5, null);
      assert.strictEqual(result.valid, true);
    });

    test('allows only end_time (no validation needed)', () => {
      const result = validateTimeParameters(null, 2.5);
      assert.strictEqual(result.valid, true);
    });

    test('allows neither parameter (no validation needed)', () => {
      const result = validateTimeParameters(null, null);
      assert.strictEqual(result.valid, true);
    });

    test('validates decimal values correctly', () => {
      const invalidResult = validateTimeParameters(2.5, 2.49);
      assert.strictEqual(invalidResult.valid, false);

      const validResult = validateTimeParameters(2.5, 2.51);
      assert.strictEqual(validResult.valid, true);
    });
  });

  describe('trimming integration logic', () => {
    /**
     * Helper function to simulate trimming decision logic from processDownload
     * This matches the logic in src/commands/download.js for determining when to trim
     */
    function shouldTrimFile(fileType, ext, startTime, duration) {
      // GIF trimming logic (lines 400-492)
      if (fileType === 'gif') {
        return startTime !== null || duration !== null;
      }

      // Video with .gif extension trimmed as GIF (lines 611-703)
      if (fileType === 'video' && ext === '.gif') {
        return startTime !== null || duration !== null;
      }

      // Regular video trimming (lines 768-849)
      if (fileType === 'video') {
        return startTime !== null || duration !== null;
      }

      return false;
    }

    test('determines GIF should be trimmed when startTime provided', () => {
      assert.strictEqual(shouldTrimFile('gif', '.gif', 1.5, null), true);
    });

    test('determines GIF should be trimmed when duration provided', () => {
      assert.strictEqual(shouldTrimFile('gif', '.gif', null, 2.5), true);
    });

    test('determines GIF should not be trimmed when no time params', () => {
      assert.strictEqual(shouldTrimFile('gif', '.gif', null, null), false);
    });

    test('determines video with .gif extension should be trimmed as GIF', () => {
      assert.strictEqual(shouldTrimFile('video', '.gif', 1.5, null), true);
    });

    test('determines regular video should be trimmed when startTime provided', () => {
      assert.strictEqual(shouldTrimFile('video', '.mp4', 1.5, null), true);
    });

    test('determines regular video should be trimmed when duration provided', () => {
      assert.strictEqual(shouldTrimFile('video', '.mp4', null, 2.5), true);
    });

    test('determines video should not be trimmed when no time params', () => {
      assert.strictEqual(shouldTrimFile('video', '.mp4', null, null), false);
    });
  });

  describe('trimmed video file extension logic', () => {
    /**
     * Helper function to simulate file extension logic for trimmed videos
     * This matches the logic in src/commands/download.js lines 396-397, 779-782, 809
     */
    function getTrimmedVideoExtension(originalExt, wasTrimmed) {
      // Always use .mp4 extension for trimmed videos (trimVideo outputs MP4 format)
      if (wasTrimmed) {
        return '.mp4';
      }
      return originalExt;
    }

    test('returns .mp4 extension for trimmed video regardless of original extension', () => {
      assert.strictEqual(getTrimmedVideoExtension('.webm', true), '.mp4');
      assert.strictEqual(getTrimmedVideoExtension('.mov', true), '.mp4');
      assert.strictEqual(getTrimmedVideoExtension('.avi', true), '.mp4');
      assert.strictEqual(getTrimmedVideoExtension('.mp4', true), '.mp4');
    });

    test('returns original extension for non-trimmed video', () => {
      assert.strictEqual(getTrimmedVideoExtension('.webm', false), '.webm');
      assert.strictEqual(getTrimmedVideoExtension('.mov', false), '.mov');
      assert.strictEqual(getTrimmedVideoExtension('.mp4', false), '.mp4');
    });
  });

  describe('hash regeneration after trimming', () => {
    /**
     * Helper function to simulate hash regeneration logic
     * This matches the logic in src/commands/download.js lines 430, 639, 802
     * Hash is regenerated after trimming because content changed
     */
    function shouldRegenerateHash(wasTrimmed) {
      // Hash is regenerated after trimming because the content changed
      return wasTrimmed;
    }

    test('determines hash should be regenerated after trimming', () => {
      assert.strictEqual(shouldRegenerateHash(true), true);
    });

    test('determines hash should not be regenerated when not trimmed', () => {
      assert.strictEqual(shouldRegenerateHash(false), false);
    });
  });
});
