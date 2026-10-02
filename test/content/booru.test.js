import { test, expect, describe } from 'bun:test';
import { isBooruContentUrl, fetchBooruThread } from '../../src/content/booru.js';

const danbooru = {
  id: 42,
  created_at: '2024-05-01T10:00:00.000-04:00',
  uploader_id: 7,
  score: 120,
  fav_count: 33,
  rating: 'g',
  source: 'https://www.pixiv.net/artworks/1',
  md5: 'abc',
  file_size: 1000,
  image_width: 800,
  image_height: 600,
  file_ext: 'png',
  file_url: 'https://cdn.donmai.us/original/ab/c/abc.png',
  tag_string_artist: 'some_artist',
  tag_string_character: 'a_girl',
  tag_string_copyright: 'a_series',
  tag_string_general: '1girl smile',
  tag_string_meta: 'highres',
};

const e621 = {
  post: {
    id: 9,
    created_at: '2024-05-01T10:00:00.000+02:00',
    uploader_id: 3,
    description: 'a description',
    rating: 'e',
    score: { total: 50 },
    fav_count: 5,
    sources: ['https://example.com/a', 'https://example.com/b'],
    flags: { deleted: false },
    file: { width: 10, height: 20, ext: 'webm', size: 99, md5: 'ffeedd', url: null },
    tags: { general: ['solo'], artist: ['conditional_dnp', 'artist_x'], species: ['fox'] },
  },
};

const moe = [
  {
    id: 5,
    created_at: 1714557600,
    author: 'uploader',
    creator_id: 2,
    tags: 'tag_a tag_b',
    rating: 'q',
    score: 12,
    source: '',
    md5: 'm',
    file_size: 5,
    width: 3,
    height: 4,
    file_url: 'https://files.yande.re/image/m/yande.re%205.gif',
  },
];

const serve = (json, calls = []) => ({
  calls,
  fetchJson: async apiUrl => {
    calls.push(apiUrl);
    return json;
  },
});

describe('booru content links', () => {
  test('matches posts on several boorus', () => {
    for (const url of [
      'https://danbooru.donmai.us/posts/42?q=x',
      'https://e926.net/posts/9',
      'https://e621.net/posts/9',
      'https://yande.re/post/show/5',
      'https://konachan.com/post/show/5/tags',
    ]) {
      expect(isBooruContentUrl(url)).toBe(true);
    }
    expect(isBooruContentUrl('https://danbooru.donmai.us/')).toBe(false);
    expect(isBooruContentUrl('https://example.com/posts/1')).toBe(false);
  });

  test('rejects an unsupported link with BAD_URL', async () => {
    const error = await fetchBooruThread('https://example.com/posts/1', serve({})).catch(e => e);
    expect(error.code).toBe('BAD_URL');
    expect(error.statusCode).toBe(400);
  });
});

describe('fetchBooruThread', () => {
  test('danbooru: grouped tags, normalized rating, image media', async () => {
    const calls = [];
    const result = await fetchBooruThread(
      'https://danbooru.donmai.us/posts/42',
      serve(danbooru, calls)
    );
    expect(calls).toEqual(['https://danbooru.donmai.us/posts/42.json']);
    expect(result.source).toBe('booru');
    expect(result.thread).toEqual([]);
    expect(result.comments).toEqual([]);
    const { post } = result;
    expect(post.text).toBe('');
    expect(post.title).toBeNull();
    expect(post.createdAt).toBe('2024-05-01T14:00:00.000Z');
    expect(post.extra.tags.artist).toEqual(['some_artist']);
    expect(post.extra.tags.general).toEqual(['1girl', 'smile']);
    expect(post.extra.rating).toBe('safe');
    expect(post.flags.nsfw).toBe(false);
    expect(post.stats.score).toBe(120);
    expect(post.stats.likes).toBe(33);
    expect(post.links).toEqual(['https://www.pixiv.net/artworks/1']);
    expect(post.extra.source).toBe('https://www.pixiv.net/artworks/1');
    expect(post.extra.md5).toBe('abc');
    expect(post.media).toEqual([
      {
        type: 'image',
        url: 'https://cdn.donmai.us/original/ab/c/abc.png',
        alt: null,
        width: 800,
        height: 600,
      },
    ]);
  });

  test('e621: derives the file url, video type, explicit is nsfw, drops conditional_dnp', async () => {
    const { post } = await fetchBooruThread('https://e926.net/posts/9', serve(e621));
    expect(post.text).toBe('a description');
    expect(post.media[0].type).toBe('video');
    expect(post.media[0].url).toBe('https://static1.e621.net/data/ff/ee/ffeedd.webm');
    expect(post.extra.rating).toBe('explicit');
    expect(post.flags.nsfw).toBe(true);
    expect(post.extra.tags.artist).toEqual(['artist_x']);
    expect(post.extra.tags.species).toEqual(['fox']);
    expect(post.stats.score).toBe(50);
    expect(post.links).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  test('moebooru: gif media, uploader, questionable is nsfw, unix date', async () => {
    const calls = [];
    const { post, url } = await fetchBooruThread('https://yande.re/post/show/5', serve(moe, calls));
    expect(calls).toEqual(['https://yande.re/post.json?tags=id:5']);
    expect(url).toBe('https://yande.re/post/show/5');
    expect(post.author.handle).toBe('uploader');
    expect(post.media[0].type).toBe('gif');
    expect(post.extra.rating).toBe('questionable');
    expect(post.flags.nsfw).toBe(true);
    expect(post.createdAt).toBe('2024-05-01T10:00:00.000Z');
    expect(post.extra.tags.general).toEqual(['tag_a', 'tag_b']);
  });

  test('missing posts are CONTENT_GONE', async () => {
    const gone = [
      serve([]),
      serve({ post: { ...e621.post, flags: { deleted: true } } }),
      {
        fetchJson: async () => {
          throw Object.assign(new Error('nope'), { response: { status: 404 } });
        },
      },
    ];
    for (const source of gone) {
      const error = await fetchBooruThread('https://yande.re/post/show/5', source).catch(e => e);
      expect(error.code).toBe('CONTENT_GONE');
    }
  });

  test('other failures are a plain fetch error', async () => {
    const error = await fetchBooruThread('https://e926.net/posts/9', {
      fetchJson: async () => {
        throw new Error('socket hang up');
      },
    }).catch(e => e);
    expect(error.message).toBe('failed to fetch the post');
  });
});
