import { test, describe } from 'node:test';
import assert from 'node:assert';
import { isYouTubeUrl, YtdlpRateLimitError, formatTimestamp } from '../../src/utils/ytdlp.js';
import { NetworkError } from '../../src/utils/errors.js';

describe('ytdlp utilities', () => {
  describe('isYouTubeUrl', () => {
    test('returns true for standard youtube.com URLs', () => {
      assert.strictEqual(isYouTubeUrl('https://youtube.com/watch?v=abc123'), true);
      assert.strictEqual(isYouTubeUrl('https://www.youtube.com/watch?v=abc123'), true);
      assert.strictEqual(isYouTubeUrl('http://youtube.com/watch?v=abc123'), true);
    });

    test('returns true for youtu.be short URLs', () => {
      assert.strictEqual(isYouTubeUrl('https://youtu.be/abc123'), true);
      assert.strictEqual(isYouTubeUrl('http://youtu.be/abc123'), true);
    });

    test('returns true for mobile youtube URLs', () => {
      assert.strictEqual(isYouTubeUrl('https://m.youtube.com/watch?v=abc123'), true);
    });

    test('returns true for youtube subdomain URLs', () => {
      assert.strictEqual(isYouTubeUrl('https://music.youtube.com/watch?v=abc123'), true);
      assert.strictEqual(isYouTubeUrl('https://gaming.youtube.com/watch?v=abc123'), true);
    });

    test('returns true for youtube shorts URLs', () => {
      assert.strictEqual(isYouTubeUrl('https://youtube.com/shorts/abc123'), true);
      assert.strictEqual(isYouTubeUrl('https://www.youtube.com/shorts/abc123'), true);
    });

    test('returns true for youtube playlist URLs', () => {
      assert.strictEqual(
        isYouTubeUrl('https://youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'),
        true
      );
    });

    test('returns false for non-YouTube URLs', () => {
      assert.strictEqual(isYouTubeUrl('https://twitter.com/user/status/123'), false);
      assert.strictEqual(isYouTubeUrl('https://tiktok.com/@user/video/123'), false);
      assert.strictEqual(isYouTubeUrl('https://instagram.com/p/abc123'), false);
      assert.strictEqual(isYouTubeUrl('https://reddit.com/r/videos/comments/abc'), false);
      assert.strictEqual(isYouTubeUrl('https://vimeo.com/123456'), false);
      assert.strictEqual(isYouTubeUrl('https://dailymotion.com/video/abc'), false);
    });

    test('returns false for lookalike domains', () => {
      assert.strictEqual(isYouTubeUrl('https://notyoutube.com/watch?v=abc'), false);
      assert.strictEqual(isYouTubeUrl('https://youtube.com.fake.com/watch?v=abc'), false);
      assert.strictEqual(isYouTubeUrl('https://fakeyoutu.be/abc123'), false);
    });

    test('returns false for invalid URLs', () => {
      assert.strictEqual(isYouTubeUrl('not-a-url'), false);
      assert.strictEqual(isYouTubeUrl(''), false);
      assert.strictEqual(isYouTubeUrl('youtube.com/watch?v=abc'), false); // Missing protocol
    });

    test('returns false for null/undefined', () => {
      assert.strictEqual(isYouTubeUrl(null), false);
      assert.strictEqual(isYouTubeUrl(undefined), false);
    });
  });

  describe('YtdlpRateLimitError', () => {
    test('extends NetworkError', () => {
      const error = new YtdlpRateLimitError('Rate limited');
      assert.strictEqual(error instanceof NetworkError, true);
      assert.strictEqual(error instanceof Error, true);
    });

    test('has correct name property', () => {
      const error = new YtdlpRateLimitError('Rate limited');
      assert.strictEqual(error.name, 'YtdlpRateLimitError');
    });

    test('stores message correctly', () => {
      const error = new YtdlpRateLimitError('YouTube rate limit exceeded');
      assert.strictEqual(error.message, 'YouTube rate limit exceeded');
    });

    test('stores retryAfter value', () => {
      const error = new YtdlpRateLimitError('Rate limited', 5000);
      assert.strictEqual(error.retryAfter, 5000);
    });

    test('retryAfter defaults to null', () => {
      const error = new YtdlpRateLimitError('Rate limited');
      assert.strictEqual(error.retryAfter, null);
    });

    test('can be caught as NetworkError', () => {
      let caught = false;
      try {
        throw new YtdlpRateLimitError('Test', 1000);
      } catch (e) {
        if (e instanceof NetworkError) {
          caught = true;
        }
      }
      assert.strictEqual(caught, true);
    });
  });

  describe('formatTimestamp', () => {
    test('formats seconds under 60 correctly', () => {
      assert.strictEqual(formatTimestamp(0), '00:00:00.00');
      assert.strictEqual(formatTimestamp(41), '00:00:41.00');
      assert.strictEqual(formatTimestamp(59), '00:00:59.00');
    });

    test('formats seconds over 60 correctly (prevents MM:SS misinterpretation)', () => {
      // This is the critical fix: 123 seconds should be 00:02:03, not 1:23
      assert.strictEqual(formatTimestamp(123), '00:02:03.00');
      assert.strictEqual(formatTimestamp(90), '00:01:30.00');
      assert.strictEqual(formatTimestamp(60), '00:01:00.00');
    });

    test('formats hours correctly', () => {
      assert.strictEqual(formatTimestamp(3600), '01:00:00.00');
      assert.strictEqual(formatTimestamp(3661), '01:01:01.00');
      assert.strictEqual(formatTimestamp(7325), '02:02:05.00');
    });

    test('handles decimal seconds correctly', () => {
      assert.strictEqual(formatTimestamp(41.5), '00:00:41.50');
      assert.strictEqual(formatTimestamp(123.75), '00:02:03.75');
      assert.strictEqual(formatTimestamp(0.1), '00:00:00.10');
    });

    test('returns inf for infinity string', () => {
      assert.strictEqual(formatTimestamp('inf'), 'inf');
    });

    test('returns inf for NaN values', () => {
      assert.strictEqual(formatTimestamp(NaN), 'inf');
      assert.strictEqual(formatTimestamp('not-a-number'), 'inf');
      assert.strictEqual(formatTimestamp(undefined), 'inf');
    });

    test('handles string numbers correctly', () => {
      assert.strictEqual(formatTimestamp('41'), '00:00:41.00');
      assert.strictEqual(formatTimestamp('123'), '00:02:03.00');
    });

    test('user scenario: start_time:41, end_time:123 should produce correct range', () => {
      // User provides start_time:41, end_time:123
      // duration = 123 - 41 = 82 seconds
      // start = 41, end = 41 + 82 = 123
      const start = 41;
      const duration = 82; // end_time (123) - start_time (41)
      const end = start + duration;

      const startFormatted = formatTimestamp(start);
      const endFormatted = formatTimestamp(end);

      assert.strictEqual(startFormatted, '00:00:41.00');
      assert.strictEqual(endFormatted, '00:02:03.00');

      // The yt-dlp section format should be: *00:00:41.00-00:02:03.00
      // This represents 82 seconds of video (123s - 41s)
      const section = `*${startFormatted}-${endFormatted}`;
      assert.strictEqual(section, '*00:00:41.00-00:02:03.00');
    });
  });
});
