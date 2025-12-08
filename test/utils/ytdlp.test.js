import { test, describe } from 'node:test';
import assert from 'node:assert';
import { isYouTubeUrl, YtdlpRateLimitError } from '../../src/utils/ytdlp.js';
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
});
