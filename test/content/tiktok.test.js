import { test, expect, describe } from 'bun:test';
import {
  isTiktokContentUrl,
  normalizeTiktokItem,
  fetchTiktokThread,
} from '../../src/content/tiktok.js';

const item = {
  id: '7231338487075638570',
  desc: 'take time https://example.com/a #tag',
  createTime: '1683677202',
  author: { uniqueId: 'tiktok', nickname: 'TikTok' },
  stats: { diggCount: 5, commentCount: 2, shareCount: 1, playCount: 100 },
  video: {
    cover: 'https://cdn.example/cover.jpg',
    playAddr: 'https://cdn.example/play.mp4',
    width: 720,
    height: 1280,
  },
  music: { title: 'original sound', authorName: 'TikTok' },
};

const pageOf = (itemStruct, statusCode = 0) =>
  `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: {
      'webapp.video-detail': { statusCode, ...(itemStruct ? { itemInfo: { itemStruct } } : {}) },
    },
  })}</script></html>`;

const canonical = 'https://www.tiktok.com/@tiktok/video/7231338487075638570';

const fakeHttp = ({ html = '', url = canonical, oembed, pageError } = {}) => {
  const calls = { page: [], oembed: [] };
  return {
    calls,
    page: async u => {
      calls.page.push(u);
      if (pageError) throw pageError;
      return { html, url };
    },
    oembed: async u => {
      calls.oembed.push(u);
      if (oembed instanceof Error) throw oembed;
      return oembed;
    },
  };
};

describe('isTiktokContentUrl', () => {
  test('accepts video, photo and short links', () => {
    expect(isTiktokContentUrl(canonical)).toBe(true);
    expect(isTiktokContentUrl('https://www.tiktok.com/@a.b/photo/7231338487075638570')).toBe(true);
    expect(isTiktokContentUrl('https://vm.tiktok.com/ZMabc123/')).toBe(true);
    expect(isTiktokContentUrl('https://vt.tiktok.com/ZSabc123/')).toBe(true);
    expect(isTiktokContentUrl('https://www.tiktok.com/t/ZTabc123/')).toBe(true);
  });

  test('rejects profiles, bare short hosts and other sites', () => {
    expect(isTiktokContentUrl('https://www.tiktok.com/@tiktok')).toBe(false);
    expect(isTiktokContentUrl('https://vm.tiktok.com/')).toBe(false);
    expect(isTiktokContentUrl('https://nottiktok.com/@a/video/7231338487075638570')).toBe(false);
    expect(isTiktokContentUrl('nope')).toBe(false);
  });
});

describe('normalizeTiktokItem', () => {
  test('maps caption, author, date, stats, cover and video', () => {
    const result = normalizeTiktokItem(item, canonical);
    expect(result.id).toBe(item.id);
    expect(result.author).toEqual({
      handle: 'tiktok',
      name: 'TikTok',
      url: 'https://www.tiktok.com/@tiktok',
    });
    expect(result.createdAt).toBe(new Date(1683677202 * 1000).toISOString());
    expect(result.links).toEqual(['https://example.com/a']);
    expect(result.stats).toMatchObject({ likes: 5, reposts: 1, replies: 2, views: 100 });
    expect(result.media.map(m => [m.type, m.url])).toEqual([
      ['image', 'https://cdn.example/cover.jpg'],
      ['video', 'https://cdn.example/play.mp4'],
    ]);
    expect(result.extra).toEqual({
      kind: 'video',
      music: { title: 'original sound', author: 'TikTok' },
    });
  });

  test('a video without a play url returns only the cover', () => {
    const result = normalizeTiktokItem(
      { ...item, video: { cover: 'https://cdn.example/c.jpg' } },
      canonical
    );
    expect(result.media.map(m => m.type)).toEqual(['image']);
  });

  test('a photo post lists each image', () => {
    const photos = {
      ...item,
      video: undefined,
      imagePost: {
        images: [
          { imageURL: { urlList: ['https://cdn.example/1.jpg'] }, imageWidth: 10, imageHeight: 20 },
          { imageURL: { urlList: ['https://cdn.example/2.jpg'] } },
          { imageURL: { urlList: [] } },
        ],
      },
    };
    const result = normalizeTiktokItem(photos, canonical);
    expect(result.media.map(m => m.url)).toEqual([
      'https://cdn.example/1.jpg',
      'https://cdn.example/2.jpg',
    ]);
    expect(result.media[0]).toMatchObject({ width: 10, height: 20 });
    expect(result.extra.kind).toBe('photo');
  });
});

describe('fetchTiktokThread', () => {
  test('reads the page json and reports the canonical url', async () => {
    const http = fakeHttp({ html: pageOf(item), url: `${canonical}?is_from_webapp=1` });
    const result = await fetchTiktokThread('https://vm.tiktok.com/ZMabc123/', { http });
    expect(result.source).toBe('tiktok');
    expect(result.url).toBe(canonical);
    expect(result.post.text).toContain('take time');
    expect(result.thread).toEqual([]);
    expect(http.calls.page).toEqual(['https://vm.tiktok.com/ZMabc123/']);
    expect(http.calls.oembed).toHaveLength(0);
  });

  test('falls back to oembed when the page has no json', async () => {
    const http = fakeHttp({
      html: '<html></html>',
      oembed: {
        title: 'caption',
        author_name: 'TikTok',
        author_unique_id: 'tiktok',
        thumbnail_url: 'https://cdn.example/t.jpg',
      },
    });
    const result = await fetchTiktokThread(canonical, { http });
    expect(result.post.text).toBe('caption');
    expect(result.post.author.handle).toBe('tiktok');
    expect(result.post.media[0].url).toBe('https://cdn.example/t.jpg');
    expect(http.calls.oembed).toEqual([canonical]);
  });

  test('a non-zero page status is CONTENT_GONE without an oembed call', async () => {
    const http = fakeHttp({ html: pageOf(null, 10204) });
    await expect(fetchTiktokThread(canonical, { http })).rejects.toMatchObject({
      code: 'CONTENT_GONE',
    });
    expect(http.calls.oembed).toHaveLength(0);
  });

  test('a 404 page and a 4xx oembed are CONTENT_GONE', async () => {
    const notFound = Object.assign(new Error('nf'), { response: { status: 404 } });
    await expect(
      fetchTiktokThread(canonical, { http: fakeHttp({ pageError: notFound }) })
    ).rejects.toMatchObject({ code: 'CONTENT_GONE' });
    const refused = Object.assign(new Error('bad'), { response: { status: 400 } });
    await expect(
      fetchTiktokThread(canonical, { http: fakeHttp({ html: '<html></html>', oembed: refused }) })
    ).rejects.toMatchObject({ code: 'CONTENT_GONE' });
  });

  test('a short link that lands off a video is BAD_URL', async () => {
    const http = fakeHttp({ url: 'https://www.tiktok.com/@tiktok' });
    await expect(
      fetchTiktokThread('https://vm.tiktok.com/ZMabc123/', { http })
    ).rejects.toMatchObject({ code: 'BAD_URL', statusCode: 400 });
  });

  test('a non-tiktok link is BAD_URL before any request', async () => {
    const http = fakeHttp();
    await expect(fetchTiktokThread('https://example.com/x', { http })).rejects.toMatchObject({
      code: 'BAD_URL',
    });
    expect(http.calls.page).toHaveLength(0);
  });

  test('a network failure is a curated error', async () => {
    const http = fakeHttp({ pageError: new Error('socket hang up') });
    await expect(fetchTiktokThread(canonical, { http })).rejects.toMatchObject({
      message: 'failed to reach tiktok',
    });
  });
});
