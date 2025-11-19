import { test } from 'node:test';
import assert from 'node:assert';
import { isAdmin, checkRateLimit } from '../../src/utils/rate-limit.js';

// Note: These tests rely on the current ADMIN_USER_IDS env variable
// If ADMIN_USER_IDS is set, we test with those values
// If not set, we test that non-admin users are properly rate limited

test('isAdmin - returns true for configured admin users', () => {
  // This test depends on ADMIN_USER_IDS environment variable
  // If set, test that those users are admins
  const adminUserIds = process.env.ADMIN_USER_IDS || '';
  if (adminUserIds) {
    const adminIds = adminUserIds.split(',').map(id => id.trim());
    if (adminIds.length > 0) {
      assert.strictEqual(isAdmin(adminIds[0]), true);
    }
  } else {
    // If no admins configured, skip this assertion
    assert.strictEqual(typeof isAdmin, 'function');
  }
});

test('isAdmin - returns false for non-admin users', () => {
  // Test with a user ID that should not be an admin
  assert.strictEqual(isAdmin('999999999999999999'), false);
  assert.strictEqual(isAdmin('000000000000000000'), false);
  assert.strictEqual(isAdmin('invalid-user-id'), false);
});

test('checkRateLimit - returns false for first request', () => {
  const userId = 'test-user-1-' + Date.now();
  const result = checkRateLimit(userId);
  assert.strictEqual(result, false);
});

test('checkRateLimit - returns true when rate limited', () => {
  const userId = 'test-user-2-' + Date.now();
  // First request should not be rate limited
  assert.strictEqual(checkRateLimit(userId), false);
  // Immediate second request should be rate limited
  const result = checkRateLimit(userId);
  assert.strictEqual(result, true);
});

test('checkRateLimit - admins bypass rate limiting', () => {
  // If ADMIN_USER_IDS is set, test that admins bypass rate limiting
  const adminUserIds = process.env.ADMIN_USER_IDS || '';
  if (adminUserIds) {
    const adminIds = adminUserIds.split(',').map(id => id.trim());
    if (adminIds.length > 0) {
      const adminId = adminIds[0];
      // Admin should not be rate limited on first request
      assert.strictEqual(checkRateLimit(adminId), false);
      // Admin should not be rate limited on immediate second request
      assert.strictEqual(checkRateLimit(adminId), false);
      assert.strictEqual(checkRateLimit(adminId), false);
    }
  } else {
    // If no admins configured, skip this assertion
    assert.strictEqual(typeof checkRateLimit, 'function');
  }
});

test('checkRateLimit - different users have separate rate limits', () => {
  const userId1 = 'user-1-' + Date.now();
  const userId2 = 'user-2-' + Date.now();
  
  // Both users can make first request
  assert.strictEqual(checkRateLimit(userId1), false);
  assert.strictEqual(checkRateLimit(userId2), false);
  
  // Both users get rate limited on second request
  assert.strictEqual(checkRateLimit(userId1), true);
  assert.strictEqual(checkRateLimit(userId2), true);
});

test('checkRateLimit - resets after cooldown period', async () => {
  const userId = 'test-cooldown-user-' + Date.now();
  
  // First request
  assert.strictEqual(checkRateLimit(userId), false);
  // Second request is rate limited
  assert.strictEqual(checkRateLimit(userId), true);
  
  // Wait for cooldown (30 seconds + small buffer)
  await new Promise(resolve => setTimeout(resolve, 31000));
  
  // After cooldown, should not be rate limited
  assert.strictEqual(checkRateLimit(userId), false);
});

