import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { hostUnder } from '../../src/utils/url-host.js';

test('hostUnder takes the domain and its subdomains, never a lookalike', () => {
  assert.ok(hostUnder('instagram.com', 'instagram.com'));
  assert.ok(hostUnder('cdn.instagram.com', ['tiktok.com', 'instagram.com']));
  assert.ok(!hostUnder('evilinstagram.com', 'instagram.com'));
  assert.ok(!hostUnder('instagram.com.evil.net', 'instagram.com'));
  assert.ok(!hostUnder(null, 'instagram.com'));
});
