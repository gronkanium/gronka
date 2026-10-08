import { test, describe } from 'bun:test';
import assert from 'node:assert';
import {
  parseTenorUrl,
  downloadImage,
  downloadVideo,
  isDirectMediaUrl,
  isMediaResponse,
} from '../../src/utils/file-downloader.js';
import axios from 'axios';
import { Readable } from 'node:stream';

describe('file downloader utilities', () => {
  describe('oversize downloads report the size cap, not "unavailable"', () => {
    const throwMaxContentLength = async () => ({
      data: Readable.from([]),
      headers: { 'content-length': String(1e12) },
    });

    test('downloadImage surfaces the size message on a client-side abort', async () => {
      const originalGet = axios.get;
      axios.get = throwMaxContentLength;
      try {
        await assert.rejects(
          () => downloadImage('https://example.com/huge.gif'),
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
          () => downloadVideo('https://example.com/huge.mp4'),
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
          () => downloadImage('https://example.com/missing.gif'),
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

  describe('isDirectMediaUrl', () => {
    test('accepts the direct media links users actually paste', () => {
      assert.strictEqual(isDirectMediaUrl('https://cdn.gronka.dev/videos/abc.mp4'), true);
      assert.strictEqual(isDirectMediaUrl('https://video.twimg.com/ext_tw/1/vid.mp4'), true);
      assert.strictEqual(isDirectMediaUrl('https://example.com/a.gif'), true);
      assert.strictEqual(isDirectMediaUrl('https://example.com/PHOTO.JPEG'), true);
    });

    test('accepts direct audio files instead of requiring a social-media host', () => {
      for (const ext of ['ogg', 'mp3', 'm4a', 'wav', 'flac']) {
        assert.strictEqual(isDirectMediaUrl(`https://example.com/track.${ext}?download=1`), true);
      }
    });

    test('ignores the query string when reading the extension', () => {
      assert.strictEqual(
        isDirectMediaUrl('https://cdn.discordapp.com/attachments/1/2/f.mp4?ex=a&is=b&hm=c'),
        true
      );
      assert.strictEqual(isDirectMediaUrl('https://pbs.twimg.com/media/Gcth.jpg?name=orig'), true);
    });

    test('rejects pages and extensionless URLs', () => {
      assert.strictEqual(isDirectMediaUrl('https://example.com/page.html'), false);
      assert.strictEqual(isDirectMediaUrl('https://open.spotify.com/track/123'), false);
      assert.strictEqual(isDirectMediaUrl('https://www.google.com/search?q=cats'), false);
      assert.strictEqual(isDirectMediaUrl('https://example.com/video'), false);
      assert.strictEqual(isDirectMediaUrl('not-a-url'), false);
      assert.strictEqual(isDirectMediaUrl(''), false);
    });
  });

  describe('isMediaResponse', () => {
    const gif = Buffer.from('GIF89a' + 'x'.repeat(20));
    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.alloc(8)]);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(8),
    ]);
    const html = Buffer.from('<!doctype html><html><head>bad</head></html>');

    test('accepts a media content-type', () => {
      assert.strictEqual(isMediaResponse('video/mp4', mp4), true);
      assert.strictEqual(isMediaResponse('image/gif', gif), true);
    });

    test('accepts audio responses and sniffs generic audio downloads', () => {
      assert.strictEqual(isMediaResponse('audio/ogg', Buffer.from('OggS' + 'x'.repeat(20))), true);
      assert.strictEqual(
        isMediaResponse('application/ogg', Buffer.from('OggS' + 'x'.repeat(20))),
        true
      );
      assert.strictEqual(isMediaResponse('application/ogg', html), false);
      for (const signature of ['OggS', 'fLaC', 'ID3']) {
        const bytes = Buffer.from(signature + 'x'.repeat(20));
        assert.strictEqual(isMediaResponse('application/octet-stream', bytes), true);
        assert.strictEqual(isMediaResponse('text/html', bytes), false);
      }
      const wav = Buffer.from('RIFFxxxxWAVE' + 'x'.repeat(20));
      assert.strictEqual(isMediaResponse('application/octet-stream', wav), true);
      const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(20)]);
      assert.strictEqual(isMediaResponse('application/octet-stream', mp3), true);
    });

    test('rejects a non-media content-type even when the bytes look like media', () => {
      assert.strictEqual(isMediaResponse('text/html', gif), false);
      assert.strictEqual(isMediaResponse('application/json', mp4), false);
    });

    test('falls back to magic bytes for generic or absent content-types', () => {
      assert.strictEqual(isMediaResponse('application/octet-stream', gif), true);
      assert.strictEqual(isMediaResponse('application/octet-stream', mp4), true);
      assert.strictEqual(isMediaResponse('application/octet-stream', png), true);
      assert.strictEqual(isMediaResponse('', gif), true);
      assert.strictEqual(isMediaResponse('application/octet-stream', html), false);
    });

    test('rejects a body too short to carry a signature', () => {
      assert.strictEqual(isMediaResponse('', Buffer.alloc(4)), false);
      assert.strictEqual(isMediaResponse('', null), false);
    });
  });
});
