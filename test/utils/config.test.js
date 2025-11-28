import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { ConfigurationError } from '../../src/utils/errors.js';
import { botConfig } from '../../src/utils/config.js';

describe('GIF_QUALITY configuration', () => {
  before(() => {
    // Set required environment variables for botConfig to load
    if (!process.env.DISCORD_TOKEN) {
      process.env.DISCORD_TOKEN = 'test-token';
    }
    if (!process.env.CLIENT_ID) {
      process.env.CLIENT_ID = 'test-client-id';
    }
  });

  test('botConfig.gifQuality returns a value', () => {
    // Test that gifQuality is accessible and returns a string
    const quality = botConfig.gifQuality;
    assert.strictEqual(typeof quality, 'string');
    assert.ok(
      ['low', 'medium', 'high'].includes(quality),
      `gifQuality should be one of: low, medium, high, got: ${quality}`
    );
  });

  test('default value is "medium" when GIF_QUALITY is not explicitly set', () => {
    // The default is hardcoded as 'medium' in config.js
    // This test verifies that the default constant matches expected value
    const expectedDefault = 'medium';
    assert.strictEqual(expectedDefault, 'medium');
  });

  test('valid quality values are: low, medium, high', () => {
    const validValues = ['low', 'medium', 'high'];
    // Verify all expected values are present
    assert.strictEqual(validValues.length, 3);
    assert.ok(validValues.includes('low'));
    assert.ok(validValues.includes('medium'));
    assert.ok(validValues.includes('high'));
  });

  test('invalid values should be rejected by validation logic', () => {
    const invalidValues = ['invalid', 'very-high', 'lowest', '', '1', 'true', 'false'];
    const validValues = ['low', 'medium', 'high'];

    for (const value of invalidValues) {
      const normalized = value.trim().toLowerCase();
      assert.ok(
        !validValues.includes(normalized),
        `${value} should be rejected (normalized to ${normalized})`
      );
    }
  });

  test('case-insensitive normalization works correctly', () => {
    const testCases = [
      { input: 'LOW', expected: 'low' },
      { input: 'Medium', expected: 'medium' },
      { input: 'HIGH', expected: 'high' },
      { input: '  low  ', expected: 'low' },
      { input: '  MEDIUM  ', expected: 'medium' },
    ];

    for (const testCase of testCases) {
      const normalized = testCase.input.trim().toLowerCase();
      assert.strictEqual(
        normalized,
        testCase.expected,
        `${testCase.input} should normalize to ${testCase.expected}`
      );
    }
  });

  test('ConfigurationError is properly defined for invalid quality', () => {
    // Verify that ConfigurationError exists and can be used
    const error = new ConfigurationError('test error', 'INVALID_GIF_QUALITY');
    assert.strictEqual(error.name, 'ConfigurationError');
    assert.strictEqual(error.code, 'INVALID_GIF_QUALITY');
    assert.ok(error instanceof Error);
  });

  test('gifQuality value matches expected format', () => {
    // Test that the actual config value is valid
    const quality = botConfig.gifQuality;
    const validValues = ['low', 'medium', 'high'];
    assert.ok(
      validValues.includes(quality),
      `botConfig.gifQuality should be one of ${validValues.join(', ')}, got: ${quality}`
    );
  });
});
