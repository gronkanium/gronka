import { test } from 'node:test';
import assert from 'node:assert';
import { generateHash, parseTenorUrl } from '../../src/utils/file-downloader.js';
import axios from 'axios';

test('generateHash - generates SHA-256 hash', () => {
  const buffer = Buffer.from('test content');
  const hash = generateHash(buffer);
  
  assert.strictEqual(typeof hash, 'string');
  assert.strictEqual(hash.length, 64); // SHA-256 produces 64 hex characters
});

test('generateHash - produces consistent hashes', () => {
  const buffer = Buffer.from('test content');
  const hash1 = generateHash(buffer);
  const hash2 = generateHash(buffer);
  
  assert.strictEqual(hash1, hash2);
});

test('generateHash - produces different hashes for different content', () => {
  const buffer1 = Buffer.from('test content 1');
  const buffer2 = Buffer.from('test content 2');
  
  const hash1 = generateHash(buffer1);
  const hash2 = generateHash(buffer2);
  
  assert.notStrictEqual(hash1, hash2);
});

test('generateHash - handles empty buffer', () => {
  const buffer = Buffer.from('');
  const hash = generateHash(buffer);
  
  assert.strictEqual(typeof hash, 'string');
  assert.strictEqual(hash.length, 64);
});

test('generateHash - handles binary data', () => {
  const buffer = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
  const hash = generateHash(buffer);
  
  assert.strictEqual(typeof hash, 'string');
  assert.strictEqual(hash.length, 64);
});

test('parseTenorUrl - extracts GIF URL from store-cache JSON', async () => {
  const tenorUrl = 'https://tenor.com/view/test-gif-1234567890';
  const mockGifUrl = 'https://media.tenor.com/images/test.gif';
  
  // Mock axios.get to return HTML with store-cache JSON
  const originalGet = axios.get;
  axios.get = async () => {
    return {
      data: `<html><head><script id="store-cache">${JSON.stringify({
        gifs: {
          byId: {
            '1234567890': {
              results: [{
                media_formats: {
                  gif: {
                    url: mockGifUrl
                  }
                }
              }]
            }
          }
        }
      })}</script></head></html>`
    };
  };
  
  try {
    const result = await parseTenorUrl(tenorUrl);
    assert.strictEqual(result, mockGifUrl);
  } finally {
    axios.get = originalGet;
  }
});

test('parseTenorUrl - extracts GIF URL from og:image meta tag', async () => {
  const tenorUrl = 'https://tenor.com/view/test-gif-1234567890';
  const mockGifUrl = 'https://media.tenor.com/images/test.gif';
  
  const originalGet = axios.get;
  axios.get = async () => {
    return {
      data: `<html><head><meta property="og:image" content="${mockGifUrl}"></head></html>`
    };
  };
  
  try {
    const result = await parseTenorUrl(tenorUrl);
    assert.strictEqual(result, mockGifUrl);
  } finally {
    axios.get = originalGet;
  }
});

test('parseTenorUrl - falls back to direct URL pattern when parsing fails', async () => {
  const tenorUrl = 'https://tenor.com/view/test-gif-1234567890';
  const expectedUrl = 'https://c.tenor.com/1234567890/tenor.gif';
  
  const originalGet = axios.get;
  axios.get = async () => {
    return {
      data: '<html><head></head></html>' // No GIF data in HTML
    };
  };
  
  try {
    const result = await parseTenorUrl(tenorUrl);
    assert.strictEqual(result, expectedUrl);
  } finally {
    axios.get = originalGet;
  }
});

test('parseTenorUrl - falls back to direct URL pattern on network error', async () => {
  const tenorUrl = 'https://tenor.com/view/test-gif-1234567890';
  const expectedUrl = 'https://c.tenor.com/1234567890/tenor.gif';
  
  const originalGet = axios.get;
  axios.get = async () => {
    throw new Error('Network error');
  };
  
  try {
    const result = await parseTenorUrl(tenorUrl);
    assert.strictEqual(result, expectedUrl);
  } finally {
    axios.get = originalGet;
  }
});

test('parseTenorUrl - extracts GIF URL from JSON-LD', async () => {
  const tenorUrl = 'https://tenor.com/view/test-gif-1234567890';
  const mockGifUrl = 'https://media.tenor.com/images/test.gif';
  
  const originalGet = axios.get;
  axios.get = async () => {
    return {
      data: `<html><head><script type="application/ld+json">${JSON.stringify({
        image: mockGifUrl
      })}</script></head></html>`
    };
  };
  
  try {
    const result = await parseTenorUrl(tenorUrl);
    assert.strictEqual(result, mockGifUrl);
  } finally {
    axios.get = originalGet;
  }
});

test('parseTenorUrl - throws error for invalid Tenor URL format', async () => {
  const invalidUrl = 'https://example.com/not-a-tenor-url';
  
  await assert.rejects(
    async () => await parseTenorUrl(invalidUrl),
    {
      name: 'Error',
      message: 'invalid Tenor URL format'
    }
  );
});

test('parseTenorUrl - handles Tenor URL with www prefix', async () => {
  const tenorUrl = 'https://www.tenor.com/view/test-gif-1234567890';
  const expectedUrl = 'https://c.tenor.com/1234567890/tenor.gif';
  
  const originalGet = axios.get;
  axios.get = async () => {
    return {
      data: '<html><head></head></html>'
    };
  };
  
  try {
    const result = await parseTenorUrl(tenorUrl);
    assert.strictEqual(result, expectedUrl);
  } finally {
    axios.get = originalGet;
  }
});

test('parseTenorUrl - handles case-insensitive URL matching', async () => {
  const tenorUrl = 'https://TENOR.com/view/TEST-gif-1234567890';
  const expectedUrl = 'https://c.tenor.com/1234567890/tenor.gif';
  
  const originalGet = axios.get;
  axios.get = async () => {
    return {
      data: '<html><head></head></html>'
    };
  };
  
  try {
    const result = await parseTenorUrl(tenorUrl);
    assert.strictEqual(result, expectedUrl);
  } finally {
    axios.get = originalGet;
  }
});

