import { test, describe } from 'bun:test';
import assert from 'node:assert';
import {
  generateHash,
  parseTenorUrl,
  downloadImage,
  downloadVideo,
} from '../../src/utils/file-downloader.js';
import axios from 'axios';

describe('file downloader utilities', () => {
  // Regression: axios aborts client-side once maxContentLength is exceeded, and that error
  // carries no `response`. The size branch only checked for a 413, so an oversized file was
  // reported as "it may be unavailable" — telling users a file was missing when it was too big.
  describe('oversize downloads report the size cap, not "unavailable"', () => {
    function throwMaxContentLength() {
      const error = new Error('maxContentLength size of 52428800 exceeded');
      error.code = 'ERR_BAD_RESPONSE';
      throw error;
    }

    test('downloadImage surfaces the size message on a client-side abort', async () => {
      const originalGet = axios.get;
      axios.get = throwMaxContentLength;
      try {
        await assert.rejects(
          () => downloadImage('https://example.com/huge.gif', false),
          error => {
            assert.match(error.message, /image file is too large/);
            return true;
          }
        );
      } finally {
        axios.get = originalGet;
      }
    });

    test('downloadVideo surfaces the size message on a client-side abort', async () => {
      const originalGet = axios.get;
      axios.get = throwMaxContentLength;
      try {
        await assert.rejects(
          () => downloadVideo('https://example.com/huge.mp4', false),
          error => {
            assert.match(error.message, /video file is too large/);
            return true;
          }
        );
      } finally {
        axios.get = originalGet;
      }
    });

    test('a genuine fetch failure still reports as unavailable', async () => {
      const originalGet = axios.get;
      axios.get = async () => {
        throw new Error('getaddrinfo ENOTFOUND example.com');
      };
      try {
        await assert.rejects(
          () => downloadImage('https://example.com/missing.gif', false),
          error => {
            assert.match(error.message, /may be unavailable/);
            return true;
          }
        );
      } finally {
        axios.get = originalGet;
      }
    });
  });

  describe('generateHash', () => {
    test('generates a stable 64-hex content hash', () => {
      const buffer = Buffer.from('test content');
      const hash = generateHash(buffer);

      assert.strictEqual(typeof hash, 'string');
      assert.strictEqual(hash.length, 64); // 32-byte hash as 64 hex chars
    });

    test('produces consistent hashes', () => {
      const buffer = Buffer.from('test content');
      const hash1 = generateHash(buffer);
      const hash2 = generateHash(buffer);

      assert.strictEqual(hash1, hash2);
    });

    test('produces different hashes for different content', () => {
      const buffer1 = Buffer.from('test content 1');
      const buffer2 = Buffer.from('test content 2');

      const hash1 = generateHash(buffer1);
      const hash2 = generateHash(buffer2);

      assert.notStrictEqual(hash1, hash2);
    });

    test('handles empty buffer', () => {
      const buffer = Buffer.from('');
      const hash = generateHash(buffer);

      assert.strictEqual(typeof hash, 'string');
      assert.strictEqual(hash.length, 64);
    });

    test('handles binary data', () => {
      const buffer = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
      const hash = generateHash(buffer);

      assert.strictEqual(typeof hash, 'string');
      assert.strictEqual(hash.length, 64);
    });
  });

  describe('parseTenorUrl', () => {
    test('extracts GIF URL from store-cache JSON', async () => {
      const tenorUrl = 'https://tenor.com/view/test-gif-1234567890';
      const mockGifUrl = 'https://media.tenor.com/images/test.gif';

      // Mock axios.get to return HTML with store-cache JSON
      const originalGet = axios.get;
      axios.get = async () => {
        return {
          data: `<html><head><script id="store-cache">${JSON.stringify({
            gifs: {
              byId: {
                1234567890: {
                  results: [
                    {
                      media_formats: {
                        gif: {
                          url: mockGifUrl,
                        },
                      },
                    },
                  ],
                },
              },
            },
          })}</script></head></html>`,
        };
      };

      try {
        const result = await parseTenorUrl(tenorUrl);
        assert.strictEqual(result, mockGifUrl);
      } finally {
        axios.get = originalGet;
      }
    });

    test('extracts GIF URL from og:image meta tag', async () => {
      const tenorUrl = 'https://tenor.com/view/test-gif-1234567890';
      const mockGifUrl = 'https://media.tenor.com/images/test.gif';

      const originalGet = axios.get;
      axios.get = async () => {
        return {
          data: `<html><head><meta property="og:image" content="${mockGifUrl}"></head></html>`,
        };
      };

      try {
        const result = await parseTenorUrl(tenorUrl);
        assert.strictEqual(result, mockGifUrl);
      } finally {
        axios.get = originalGet;
      }
    });

    test('falls back to direct URL pattern when parsing fails', async () => {
      const tenorUrl = 'https://tenor.com/view/test-gif-1234567890';
      const expectedUrl = 'https://c.tenor.com/1234567890/tenor.gif';

      const originalGet = axios.get;
      axios.get = async () => {
        return {
          data: '<html><head></head></html>', // No GIF data in HTML
        };
      };

      try {
        const result = await parseTenorUrl(tenorUrl);
        assert.strictEqual(result, expectedUrl);
      } finally {
        axios.get = originalGet;
      }
    });

    test('falls back to direct URL pattern on network error', async () => {
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

    test('extracts GIF URL from JSON-LD', async () => {
      const tenorUrl = 'https://tenor.com/view/test-gif-1234567890';
      const mockGifUrl = 'https://media.tenor.com/images/test.gif';

      const originalGet = axios.get;
      axios.get = async () => {
        return {
          data: `<html><head><script type="application/ld+json">${JSON.stringify({
            image: mockGifUrl,
          })}</script></head></html>`,
        };
      };

      try {
        const result = await parseTenorUrl(tenorUrl);
        assert.strictEqual(result, mockGifUrl);
      } finally {
        axios.get = originalGet;
      }
    });

    test('throws error for invalid Tenor URL format', async () => {
      const invalidUrl = 'https://example.com/not-a-tenor-url';

      await assert.rejects(async () => await parseTenorUrl(invalidUrl), {
        name: 'ValidationError',
        message: 'invalid Tenor URL format',
      });
    });

    test('handles Tenor URL with www prefix', async () => {
      const tenorUrl = 'https://www.tenor.com/view/test-gif-1234567890';
      const expectedUrl = 'https://c.tenor.com/1234567890/tenor.gif';

      const originalGet = axios.get;
      axios.get = async () => {
        return {
          data: '<html><head></head></html>',
        };
      };

      try {
        const result = await parseTenorUrl(tenorUrl);
        assert.strictEqual(result, expectedUrl);
      } finally {
        axios.get = originalGet;
      }
    });

    test('handles case-insensitive URL matching', async () => {
      const tenorUrl = 'https://TENOR.com/view/TEST-gif-1234567890';
      const expectedUrl = 'https://c.tenor.com/1234567890/tenor.gif';

      const originalGet = axios.get;
      axios.get = async () => {
        return {
          data: '<html><head></head></html>',
        };
      };

      try {
        const result = await parseTenorUrl(tenorUrl);
        assert.strictEqual(result, expectedUrl);
      } finally {
        axios.get = originalGet;
      }
    });
  });
});
