import { test, expect, describe } from 'bun:test';
import {
  isInstagramContentUrl,
  normalizeInstagramItem,
  fetchInstagramThread,
} from '../../src/content/instagram.js';

const image = url => ({ image_versions2: { candidates: [{ url }, { url: `${url}-small` }] } });

const photo = {
  pk: '123',
  taken_at: 1790000000,
  caption: { text: 'hello https://example.com/x.' },
  user: { username: 'pen', full_name: 'Penguin' },
  like_count: 10,
  comment_count: 2,
  ...image('https://scontent.cdninstagram.com/a.jpg'),
  original_width: 1080,
  original_height: 1350,
};

const reel = {
  ...photo,
  video_versions: [{ url: 'https://scontent.cdninstagram.com/v.mp4' }],
  play_count: 900,
};

const carousel = {
  ...photo,
  carousel_media: [
    image('https://scontent.cdninstagram.com/1.jpg'),
    {
      ...image('https://scontent.cdninstagram.com/2.jpg'),
      video_versions: [{ url: 'https://scontent.cdninstagram.com/2.mp4' }],
    },
  ],
};

const api = item => {
  const calls = [];
  const get = async (path, referer, cookie) => {
    calls.push({ path, referer, cookie });
    return { items: item ? [item] : [] };
  };
  return { get, calls };
};
const withSession = { cookie: () => 'sessionid=abc' };

describe('isInstagramContentUrl', () => {
  test('accepts posts, reels and share-sheet forms', () => {
    expect(isInstagramContentUrl('https://www.instagram.com/p/CuE2WNQs6vH/')).toBe(true);
    expect(isInstagramContentUrl('https://instagram.com/reel/CuE2WNQs6vH/?igsh=x')).toBe(true);
    expect(isInstagramContentUrl('https://www.instagram.com/pen/p/CuE2WNQs6vH/')).toBe(true);
  });

  test('rejects profiles, stories and other hosts', () => {
    expect(isInstagramContentUrl('https://www.instagram.com/pen/')).toBe(false);
    expect(isInstagramContentUrl('https://www.instagram.com/stories/pen/123/')).toBe(false);
    expect(isInstagramContentUrl('https://example.com/p/CuE2WNQs6vH/')).toBe(false);
    expect(isInstagramContentUrl('not a url')).toBe(false);
  });
});

describe('normalizeInstagramItem', () => {
  test('maps caption, author, date, stats and the best image', () => {
    const result = normalizeInstagramItem(photo, 'CuE2WNQs6vH');
    expect(result.id).toBe('123');
    expect(result.url).toBe('https://www.instagram.com/p/CuE2WNQs6vH/');
    expect(result.author).toEqual({
      handle: 'pen',
      name: 'Penguin',
      url: 'https://www.instagram.com/pen/',
    });
    expect(result.createdAt).toBe(new Date(1790000000 * 1000).toISOString());
    expect(result.links).toEqual(['https://example.com/x']);
    expect(result.stats).toMatchObject({ likes: 10, replies: 2, views: null });
    expect(result.media).toEqual([
      {
        type: 'image',
        url: 'https://scontent.cdninstagram.com/a.jpg',
        alt: null,
        width: 1080,
        height: 1350,
      },
    ]);
    expect(result.extra.kind).toBe('photo');
  });

  test('a reel carries its video and play count', () => {
    const result = normalizeInstagramItem(reel, 'abc');
    expect(result.media.map(m => m.type)).toEqual(['video']);
    expect(result.media[0].url).toBe('https://scontent.cdninstagram.com/v.mp4');
    expect(result.stats.views).toBe(900);
  });

  test('a carousel lists every slide in order', () => {
    const result = normalizeInstagramItem(carousel, 'abc');
    expect(result.media.map(m => [m.type, m.url.split('/').pop()])).toEqual([
      ['image', '1.jpg'],
      ['video', '2.mp4'],
    ]);
    expect(result.extra.kind).toBe('carousel');
  });

  test('a missing caption is an empty string', () => {
    expect(normalizeInstagramItem({ ...photo, caption: null }, 'abc').text).toBe('');
  });
});

describe('fetchInstagramThread', () => {
  test('makes exactly one request, with the media id and session', async () => {
    const { get, calls } = api(photo);
    const result = await fetchInstagramThread('https://www.instagram.com/p/CuE2WNQs6vH/', {
      get,
      ...withSession,
      comments: 20,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/v1/media/3135870261135649735/info/');
    expect(calls[0].cookie).toBe('sessionid=abc');
    expect(result.source).toBe('instagram');
    expect(result.thread).toEqual([]);
    expect(result.comments).toEqual([]);
  });

  test('no session is NO_SESSION and sends nothing', async () => {
    const { get, calls } = api(photo);
    await expect(
      fetchInstagramThread('https://www.instagram.com/p/CuE2WNQs6vH/', { get, cookie: () => null })
    ).rejects.toMatchObject({ code: 'NO_SESSION' });
    expect(calls).toHaveLength(0);
  });

  test('an empty answer is CONTENT_GONE', async () => {
    const { get } = api(null);
    await expect(
      fetchInstagramThread('https://www.instagram.com/p/CuE2WNQs6vH/', { get, ...withSession })
    ).rejects.toMatchObject({ code: 'CONTENT_GONE' });
  });

  test('a non-post link is BAD_URL', async () => {
    const { get, calls } = api(photo);
    await expect(
      fetchInstagramThread('https://www.instagram.com/pen/', { get, ...withSession })
    ).rejects.toMatchObject({ code: 'BAD_URL', statusCode: 400 });
    expect(calls).toHaveLength(0);
  });
});
