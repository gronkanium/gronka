import { test } from 'node:test';
import assert from 'node:assert';
import {
  isDiscordCdnUrl,
  isAttachmentExpired,
  getRequestHeaders,
} from '../../src/utils/discord-cdn.js';

test('isDiscordCdnUrl - detects main CDN domains', () => {
  assert.strictEqual(isDiscordCdnUrl('https://cdn.discordapp.com/attachments/123/456/file.png'), true);
  assert.strictEqual(isDiscordCdnUrl('https://media.discordapp.net/attachments/123/456/file.png'), true);
});

test('isDiscordCdnUrl - detects subdomain CDN domains', () => {
  assert.strictEqual(isDiscordCdnUrl('https://cdn-123.discordapp.com/attachments/123/456/file.png'), true);
  assert.strictEqual(isDiscordCdnUrl('https://media-456.discordapp.net/attachments/123/456/file.png'), true);
});

test('isDiscordCdnUrl - returns false for non-Discord domains', () => {
  assert.strictEqual(isDiscordCdnUrl('https://example.com/file.png'), false);
  assert.strictEqual(isDiscordCdnUrl('https://cdn.example.com/file.png'), false);
  assert.strictEqual(isDiscordCdnUrl('https://discord.com/file.png'), false);
});

test('isDiscordCdnUrl - returns false for invalid URLs', () => {
  assert.strictEqual(isDiscordCdnUrl('not a url'), false);
  assert.strictEqual(isDiscordCdnUrl(''), false);
  assert.strictEqual(isDiscordCdnUrl('ftp://cdn.discordapp.com/file.png'), false);
});

test('isDiscordCdnUrl - handles URLs with paths and query strings', () => {
  assert.strictEqual(isDiscordCdnUrl('https://cdn.discordapp.com/attachments/123/456/file.png?ex=abc&is=xyz'), true);
  assert.strictEqual(isDiscordCdnUrl('https://media.discordapp.net/attachments/123/456/file.png#fragment'), true);
});

test('isAttachmentExpired - returns true for URLs without expiry parameter', () => {
  assert.strictEqual(isAttachmentExpired('https://cdn.discordapp.com/attachments/123/456/file.png'), true);
  assert.strictEqual(isAttachmentExpired('https://cdn.discordapp.com/attachments/123/456/file.png?other=param'), true);
});

test('isAttachmentExpired - returns true for URLs with invalid expiry format', () => {
  assert.strictEqual(isAttachmentExpired('https://cdn.discordapp.com/attachments/123/456/file.png?ex=invalid'), true);
  assert.strictEqual(isAttachmentExpired('https://cdn.discordapp.com/attachments/123/456/file.png?ex=12345678901234'), true); // Too long
});

test('isAttachmentExpired - returns true for expired attachments', () => {
  // Create expired timestamp (past date in hex)
  const expiredTimestamp = Math.floor((Date.now() - 86400000) / 1000); // 24 hours ago
  const expiredHex = expiredTimestamp.toString(16);
  const expiredUrl = `https://cdn.discordapp.com/attachments/123/456/file.png?ex=${expiredHex}`;
  
  assert.strictEqual(isAttachmentExpired(expiredUrl), true);
});

test('isAttachmentExpired - returns false for valid future expiry', () => {
  // Create future timestamp (24 hours from now in hex)
  const futureTimestamp = Math.floor((Date.now() + 86400000) / 1000);
  const futureHex = futureTimestamp.toString(16);
  const futureUrl = `https://cdn.discordapp.com/attachments/123/456/file.png?ex=${futureHex}`;
  
  assert.strictEqual(isAttachmentExpired(futureUrl), false);
});

test('isAttachmentExpired - returns true for URLs expiring exactly now', () => {
  // Create timestamp exactly at current time (should be considered expired)
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const currentHex = currentTimestamp.toString(16);
  const currentUrl = `https://cdn.discordapp.com/attachments/123/456/file.png?ex=${currentHex}`;
  
  // Should be expired because we check >= expiryTime
  assert.strictEqual(isAttachmentExpired(currentUrl), true);
});

test('isAttachmentExpired - handles URLs with multiple query parameters', () => {
  const futureTimestamp = Math.floor((Date.now() + 86400000) / 1000);
  const futureHex = futureTimestamp.toString(16);
  const url = `https://cdn.discordapp.com/attachments/123/456/file.png?ex=${futureHex}&is=xyz&hm=abc`;
  
  assert.strictEqual(isAttachmentExpired(url), false);
});

test('isAttachmentExpired - returns true for invalid URL format', () => {
  assert.strictEqual(isAttachmentExpired('not a url'), true);
  assert.strictEqual(isAttachmentExpired(''), true);
});

test('isAttachmentExpired - handles hex timestamp with uppercase letters', () => {
  const futureTimestamp = Math.floor((Date.now() + 86400000) / 1000);
  const futureHex = futureTimestamp.toString(16).toUpperCase();
  const url = `https://cdn.discordapp.com/attachments/123/456/file.png?ex=${futureHex}`;
  
  assert.strictEqual(isAttachmentExpired(url), false);
});

test('getRequestHeaders - returns correct headers structure', () => {
  const headers = getRequestHeaders();
  
  assert.strictEqual(typeof headers['User-Agent'], 'string');
  assert.strictEqual(headers['Accept'], '*/*');
  assert.strictEqual(headers['Accept-Language'], 'en-US,en;q=0.9');
  assert.strictEqual(headers['Accept-Encoding'], 'identity');
  assert.strictEqual(headers['Referer'], 'https://discord.com/');
});

test('getRequestHeaders - User-Agent contains expected browser identifiers', () => {
  const headers = getRequestHeaders();
  const userAgent = headers['User-Agent'];
  
  assert(userAgent.includes('Mozilla'));
  assert(userAgent.includes('Chrome'));
  assert(userAgent.includes('Safari'));
});

test('getRequestHeaders - returns new object each call', () => {
  const headers1 = getRequestHeaders();
  const headers2 = getRequestHeaders();
  
  assert.notStrictEqual(headers1, headers2);
  assert.deepStrictEqual(headers1, headers2);
});

