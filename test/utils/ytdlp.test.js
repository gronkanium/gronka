import { test, describe } from 'bun:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyYtdlpFailure,
  isYouTubeUrl,
  getYtdlpSite,
  getSiteArgs,
  canonicalYtdlpUrl,
  YtdlpRateLimitError,
  getCookieArgs,
} from '../../src/utils/ytdlp.js';
import { NetworkError } from '../../src/utils/errors.js';
import { getGalleryDlSite } from '../../src/utils/gallery-dl.js';

describe('ytdlp utilities', () => {
  test('pornhub shorties links resolve to the video page', () => {
    assert.strictEqual(
      canonicalYtdlpUrl('https://www.pornhub.com/shorties/683af55667459?x=1'),
      'https://www.pornhub.com/view_video.php?viewkey=683af55667459'
    );
    const other = 'https://www.pornhub.com/view_video.php?viewkey=1';
    assert.strictEqual(canonicalYtdlpUrl(other), other);
  });

  test('drops the creator from Snapchat spotlight links, which yt-dlp only matches bare', () => {
    assert.strictEqual(
      canonicalYtdlpUrl('https://www.snapchat.com/@nasa/spotlight/W7_EDlXWTBiX?locale=en'),
      'https://www.snapchat.com/spotlight/W7_EDlXWTBiX'
    );
    const bare = 'https://www.snapchat.com/spotlight/W7_EDlXWTBiX';
    assert.strictEqual(canonicalYtdlpUrl(bare), bare);
  });

  describe('gallery-dl site detection', () => {
    test('resolves supported gallery hosts', () => {
      assert.strictEqual(
        getGalleryDlSite('https://www.deviantart.com/someone/art/thing-123'),
        'DeviantArt'
      );
      assert.strictEqual(
        getGalleryDlSite('https://www.deviantart.com/user/art/work-1'),
        'DeviantArt'
      );
      assert.strictEqual(getGalleryDlSite('https://wallhaven.cc/w/abc123'), 'Wallhaven');
    });

    test('rejects unknown and lookalike hosts', () => {
      assert.strictEqual(getGalleryDlSite('https://example.com/gallery'), null);
      assert.strictEqual(getGalleryDlSite('https://deviantart.com.example.com/art/1'), null);
      assert.strictEqual(getGalleryDlSite('not-a-url'), null);
    });
  });

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
  describe('getSiteArgs', () => {
    const siteArgs = (...args) => getSiteArgs(...args).slice(2);
    test('turns off the generic extractor for every site', () => {
      for (const url of [
        'https://evil.tumblr.com/x',
        'https://www.youtube.com/watch?v=x',
        'https://rumble.com/v1',
      ]) {
        assert.deepStrictEqual(getSiteArgs(url).slice(0, 2), ['--ies', 'default,-generic']);
      }
    });
    test('allows the manifest reader only for native Reddit HLS manifests', () => {
      assert.deepStrictEqual(
        getSiteArgs('https://v.redd.it/abc123/HLSPlaylist.m3u8?a=1').slice(0, 2),
        ['--ies', 'default']
      );
      for (const url of [
        'http://v.redd.it/abc/HLSPlaylist.m3u8',
        'https://v.redd.it:444/abc/HLSPlaylist.m3u8',
        'https://user@v.redd.it/abc/HLSPlaylist.m3u8',
        'https://v.redd.it.evil.com/abc/HLSPlaylist.m3u8',
        'https://evil.v.redd.it/abc/HLSPlaylist.m3u8',
        'https://v.redd.it/abc/page.html',
        'https://v.redd.it/abc/other.m3u8',
        'https://example.com/abc/HLSPlaylist.m3u8',
      ])
        assert.equal(getSiteArgs(url)[1], 'default,-generic', url);
    });
    test('reads Rule34Video through the generic KVS player instead of its broken extractor', () => {
      assert.equal(getSiteArgs('https://rule34video.com/video/1/x')[1], 'default,-rule34video');
      assert.equal(
        getSiteArgs('https://rule34video.com.evil.com/video/1/x')[1],
        'default,-generic'
      );
    });
    test('sends only geo-blocked sites through GEO_PROXY_URL, and only when it is set', () => {
      const saved = process.env.GEO_PROXY_URL;
      try {
        delete process.env.GEO_PROXY_URL;
        assert.deepStrictEqual(siteArgs('https://xhamster.com/videos/x-1'), []);
        process.env.GEO_PROXY_URL = 'http://vpn:8888';
        assert.deepStrictEqual(siteArgs('https://xhamster.com/videos/x-1'), [
          '--proxy',
          'http://vpn:8888',
          '-N',
          '8',
        ]);
        assert.deepStrictEqual(siteArgs('https://www.pornhub.com/view_video.php?viewkey=1'), [
          '--impersonate',
          'chrome',
          '--proxy',
          'http://vpn:8888',
          '-N',
          '8',
        ]);
        assert.deepStrictEqual(siteArgs('https://www.redtube.com/1'), [
          '--proxy',
          'http://vpn:8888',
          '-N',
          '8',
          '--referer',
          'https://www.redtube.com/',
        ]);
        assert.deepStrictEqual(siteArgs('https://www.youtube.com/watch?v=x'), []);
        assert.deepStrictEqual(siteArgs('https://rumble.com/v1'), ['--impersonate', 'chrome']);
        assert.deepStrictEqual(siteArgs('https://www.facebook.com/reel/1'), [
          '--impersonate',
          'chrome',
        ]);
        assert.deepStrictEqual(siteArgs('https://rule34.xxx/index.php?page=post&s=view&id=1'), [
          '--impersonate',
          'chrome',
        ]);
        assert.deepStrictEqual(siteArgs('https://www.tiktok.com/@a/video/1', true), [
          '--proxy',
          'http://vpn:8888',
          '-N',
          '8',
        ]);
      } finally {
        if (saved === undefined) delete process.env.GEO_PROXY_URL;
        else process.env.GEO_PROXY_URL = saved;
      }
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
      assert.strictEqual(getYtdlpSite('https://rumble.com/v1abc-thing.html'), 'Rumble');
      assert.strictEqual(getYtdlpSite('https://www.nicovideo.jp/watch/sm9'), 'Niconico');
      assert.strictEqual(getYtdlpSite('https://sp.nicovideo.jp/watch/sm9'), 'Niconico');
      assert.strictEqual(getYtdlpSite('https://nico.ms/sm9'), 'Niconico');
      assert.strictEqual(getYtdlpSite('https://www.bilibili.com/video/BV1'), 'Bilibili');
      assert.strictEqual(getYtdlpSite('https://b23.tv/abc'), 'Bilibili');
      assert.strictEqual(getYtdlpSite('https://www.xvideos.com/video1/x'), 'XVideos');
      assert.strictEqual(getYtdlpSite('https://www.xvideos.com/video1/x'), 'XVideos');
      assert.strictEqual(getYtdlpSite('https://xhamster.com/videos/x'), 'xHamster');
      assert.strictEqual(getYtdlpSite('https://www.redtube.com/123'), 'RedTube');
      assert.strictEqual(getYtdlpSite('https://rule34video.com/video/1/x/'), 'Rule34Video');
      assert.strictEqual(getYtdlpSite('https://www.xiaohongshu.com/explore/abc'), 'Xiaohongshu');
      assert.strictEqual(getYtdlpSite('http://xhslink.com/o/abc'), 'Xiaohongshu');
      assert.strictEqual(getYtdlpSite('https://medal.tv/games/x/clips/abc'), 'Medal');
    });

    test('preserves the xsec_token an /explore/ link needs to resolve', () => {
      // getYtdlpSite classifies by hostname only and must not rewrite the URL, dropping
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
      assert.strictEqual(getYtdlpSite('https://xvideos.com.evil.com/x'), null);
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

  describe('classifyYtdlpFailure', () => {
    const code = (output, url = 'https://youtu.be/x') => classifyYtdlpFailure(output, url).code;

    test('site-specific answers apply only to their site', () => {
      const tiktok404 = 'ERROR: unable to download video data: HTTP Error 404: Not Found';
      assert.strictEqual(
        code(tiktok404, 'https://www.tiktok.com/@a/video/1'),
        'REGION_COPY_MISSING'
      );
      assert.strictEqual(code(tiktok404, 'https://youtu.be/x'), 'YTDLP_UNKNOWN');
      assert.strictEqual(code('HTTP Error 403', 'https://medal.tv/clips/x'), 'CLIP_NOT_PUBLISHED');
      assert.strictEqual(code('HTTP Error 403', 'https://youtu.be/x'), 'YTDLP_UNKNOWN');
    });

    test('a link no extractor matches is unsupported, not unknown', () => {
      assert.strictEqual(
        code('ERROR: No suitable extractor found for URL https://share.snapchat.com/m/x'),
        'YTDLP_UNSUPPORTED_URL'
      );
    });

    test('order decides overlapping wording', () => {
      assert.strictEqual(code('ERROR: This video is DRM protected'), 'DRM_PROTECTED');
      assert.strictEqual(code('Sign in to confirm your age'), 'AGE_RESTRICTED');
    });

    test('limits reach the messages that name them', () => {
      const error = classifyYtdlpFailure('larger than max-filesize', 'https://youtu.be/x', {
        maxSize: 50 * 2 ** 20,
      });
      assert.match(error.message, /over the 50MB limit/);
    });
  });
  test('yt-dlp gets a private copy of the cookie jar that follows the original', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jar-'));
    const jar = path.join(dir, 'jar.txt');
    const saved = process.env.YTDLP_COOKIES_PATH;
    process.env.YTDLP_COOKIES_PATH = jar;
    try {
      fs.writeFileSync(jar, 'one');
      const [, copy] = getCookieArgs('https://www.tiktok.com/@a/video/1');
      assert.notStrictEqual(copy, jar);
      assert.strictEqual(fs.readFileSync(copy, 'utf8'), 'one');
      fs.writeFileSync(jar, 'two');
      fs.utimesSync(jar, new Date(), new Date(Date.now() + 5000));
      assert.strictEqual(fs.readFileSync(getCookieArgs('https://x.com/a')[1], 'utf8'), 'two');
    } finally {
      if (saved === undefined) delete process.env.YTDLP_COOKIES_PATH;
      else process.env.YTDLP_COOKIES_PATH = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
