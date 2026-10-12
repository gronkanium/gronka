import { describe, test, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import {
  DOWNLOAD_SERVICES,
  DOWNLOAD_SERVICE_IDS,
  getServiceForUrl,
  getDisabledServiceLabel,
} from '../../src/utils/download-services.js';
import { YTDLP_SITES } from '../../src/utils/ytdlp.js';
import { initDatabase, setSetting } from '../../src/utils/database.js';

describe('download-services registry', () => {
  test('service ids are unique and non-empty', () => {
    const ids = DOWNLOAD_SERVICES.map(s => s.id);
    assert.strictEqual(ids.length, new Set(ids).size, 'duplicate service id');
    assert.ok(ids.every(id => typeof id === 'string' && id.length > 0));
    assert.strictEqual(DOWNLOAD_SERVICE_IDS.size, ids.length);
  });

  test('every yt-dlp site has a registry entry', () => {
    for (const site of YTDLP_SITES) {
      const id = site.name.toLowerCase();
      assert.ok(DOWNLOAD_SERVICE_IDS.has(id), `missing registry entry for ${site.name}`);
    }
  });

  test('getServiceForUrl maps representative URLs across categories', () => {
    assert.strictEqual(getServiceForUrl('https://x.com/u/status/1')?.id, 'twitter');
    assert.strictEqual(getServiceForUrl('https://www.tiktok.com/@u/video/1')?.id, 'tiktok');
    assert.strictEqual(getServiceForUrl('https://www.tt.site/t/short123/')?.id, 'tiktok');
    assert.strictEqual(getServiceForUrl('https://jumpshare.com/s/file123AbC')?.id, 'jumpshare');
    assert.strictEqual(getServiceForUrl('https://v.redd.it/abc')?.id, 'reddit');
    assert.strictEqual(getServiceForUrl('https://youtu.be/abc')?.id, 'youtube');
    assert.strictEqual(getServiceForUrl('https://www.xvideos.com/video1/x')?.id, 'xvideos');
    assert.strictEqual(getServiceForUrl('https://redgifs.com/watch/x')?.id, 'redgifs');
    assert.strictEqual(getServiceForUrl('https://hentaigifz.com/slug/')?.id, 'hentaigifz');
    assert.strictEqual(getServiceForUrl('https://danbooru.donmai.us/posts/1')?.id, 'danbooru');
    assert.strictEqual(getServiceForUrl('https://e926.net/posts/1')?.id, 'e621');
    assert.strictEqual(
      getServiceForUrl('https://www.deviantart.com/someone/art/thing-1')?.id,
      'gallery-dl-deviantart'
    );
  });

  test('getServiceForUrl returns null for unknown and lookalike hosts', () => {
    assert.strictEqual(getServiceForUrl('https://example.com/x'), null);
    assert.strictEqual(getServiceForUrl('https://xvideos.com.evil.com/x'), null);
    assert.strictEqual(getServiceForUrl('not a url'), null);
  });
});

describe('getDisabledServiceLabel gating', () => {
  beforeAll(async () => {
    await initDatabase();
  });
  afterAll(async () => {
    await setSetting('disabled_services', '[]');
  });

  test('returns the label only for a disabled service', async () => {
    await setSetting('disabled_services', JSON.stringify(['xvideos']));
    assert.strictEqual(
      await getDisabledServiceLabel('https://www.xvideos.com/video1/x'),
      'XVideos'
    );
    // a different service is unaffected
    assert.strictEqual(await getDisabledServiceLabel('https://youtube.com/watch?v=x'), null);
    // an unknown host is never gated
    assert.strictEqual(await getDisabledServiceLabel('https://example.com/x'), null);

    await setSetting('disabled_services', '[]');
    assert.strictEqual(await getDisabledServiceLabel('https://www.xvideos.com/video1/x'), null);
  });

  test('TikTok aliases and Jumpshare respect their source switches', async () => {
    await setSetting('disabled_services', JSON.stringify(['tiktok', 'jumpshare']));
    assert.strictEqual(await getDisabledServiceLabel('https://www.tt.site/t/short123/'), 'TikTok');
    assert.strictEqual(await getDisabledServiceLabel('https://jumpshare.com/s/test'), 'Jumpshare');
    await setSetting('disabled_services', '[]');
  });
});
