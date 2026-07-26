import { test, describe } from 'bun:test';
import assert from 'node:assert';
import {
  isYouTubeUrl,
  isRedGifsUrl,
  getYtdlpSite,
  YtdlpRateLimitError,
} from '../../src/utils/ytdlp.js';
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

  describe('isRedGifsUrl', () => {
    test('returns true for redgifs watch/ifr URLs', () => {
      assert.strictEqual(isRedGifsUrl('https://www.redgifs.com/watch/somegif'), true);
      assert.strictEqual(isRedGifsUrl('https://redgifs.com/watch/somegif'), true);
      assert.strictEqual(isRedGifsUrl('https://redgifs.com/ifr/somegif'), true);
      assert.strictEqual(isRedGifsUrl('http://redgifs.com/watch/somegif'), true);
    });

    test('returns true for redgifs subdomains', () => {
      assert.strictEqual(isRedGifsUrl('https://v3.redgifs.com/watch/somegif'), true);
      assert.strictEqual(isRedGifsUrl('https://media.redgifs.com/SomeGif.mp4'), true);
    });

    test('returns false for non-redgifs URLs', () => {
      assert.strictEqual(isRedGifsUrl('https://youtube.com/watch?v=abc'), false);
      assert.strictEqual(isRedGifsUrl('https://gfycat.com/somegif'), false);
    });

    test('returns false for lookalike domains', () => {
      assert.strictEqual(isRedGifsUrl('https://notredgifs.com/watch/abc'), false);
      assert.strictEqual(isRedGifsUrl('https://redgifs.com.fake.com/watch/abc'), false);
    });

    test('returns false for invalid/empty input', () => {
      assert.strictEqual(isRedGifsUrl('not-a-url'), false);
      assert.strictEqual(isRedGifsUrl(''), false);
      assert.strictEqual(isRedGifsUrl(null), false);
      assert.strictEqual(isRedGifsUrl(undefined), false);
    });
  });

  describe('getYtdlpSite', () => {
    test('resolves each supported yt-dlp site to its display name', () => {
      assert.strictEqual(getYtdlpSite('https://youtube.com/watch?v=abc'), 'YouTube');
      assert.strictEqual(getYtdlpSite('https://youtu.be/abc'), 'YouTube');
      assert.strictEqual(getYtdlpSite('https://www.redgifs.com/watch/x'), 'RedGifs');
      assert.strictEqual(getYtdlpSite('https://imgur.com/gallery/x'), 'Imgur');
      assert.strictEqual(getYtdlpSite('https://i.imgur.com/x.mp4'), 'Imgur');
      assert.strictEqual(getYtdlpSite('https://kick.com/user/clips/x'), 'Kick');
      assert.strictEqual(getYtdlpSite('https://coub.com/view/x'), 'Coub');
      assert.strictEqual(getYtdlpSite('https://rumble.com/v123-title.html'), 'Rumble');
      assert.strictEqual(getYtdlpSite('https://www.newgrounds.com/portal/view/1'), 'Newgrounds');
      assert.strictEqual(getYtdlpSite('https://www.bilibili.com/video/BV1'), 'Bilibili');
      assert.strictEqual(getYtdlpSite('https://b23.tv/abc'), 'Bilibili');
      assert.strictEqual(
        getYtdlpSite('https://www.pornhub.com/view_video.php?viewkey=x'),
        'Pornhub'
      );
      assert.strictEqual(getYtdlpSite('https://www.xvideos.com/video1/x'), 'XVideos');
      assert.strictEqual(getYtdlpSite('https://xhamster.com/videos/x'), 'xHamster');
      assert.strictEqual(getYtdlpSite('https://www.redtube.com/123'), 'RedTube');
      assert.strictEqual(getYtdlpSite('https://www.xiaohongshu.com/explore/abc'), 'Xiaohongshu');
      assert.strictEqual(getYtdlpSite('http://xhslink.com/o/abc'), 'Xiaohongshu');
    });

    test('preserves the xsec_token an /explore/ link needs to resolve', () => {
      // getYtdlpSite classifies by hostname only and must not rewrite the URL — dropping
      // xsec_token makes the same Xiaohongshu post fail to resolve.
      const url =
        'https://www.xiaohongshu.com/explore/6a508e83000000002102380b?xsec_token=ABC%3D&type=video';
      assert.strictEqual(getYtdlpSite(url), 'Xiaohongshu');
      assert.ok(url.includes('xsec_token=ABC%3D'));
    });

    test('returns null for cobalt/social and unknown hosts', () => {
      assert.strictEqual(getYtdlpSite('https://twitter.com/user/status/1'), null);
      assert.strictEqual(getYtdlpSite('https://tiktok.com/@u/video/1'), null);
      assert.strictEqual(getYtdlpSite('https://hentaigifz.com/some-slug/'), null);
      assert.strictEqual(getYtdlpSite('https://example.com/x'), null);
    });

    test('returns null for lookalike domains and invalid input', () => {
      assert.strictEqual(getYtdlpSite('https://notyoutube.com/watch?v=abc'), null);
      assert.strictEqual(getYtdlpSite('https://pornhub.com.evil.com/x'), null);
      assert.strictEqual(getYtdlpSite('not-a-url'), null);
      assert.strictEqual(getYtdlpSite(''), null);
      assert.strictEqual(getYtdlpSite(null), null);
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
