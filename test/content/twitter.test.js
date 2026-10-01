import { test, expect, describe } from 'bun:test';
import {
  tweetIdFromUrl,
  isTwitterContentUrl,
  normalizeFxTweet,
  fetchTweetThread,
} from '../../src/content/twitter.js';
import { toPlainText } from '../../src/content/schema.js';

// Shapes taken from api.fxtwitter.com responses, trimmed to the fields that matter.
const author = (screen_name, name = screen_name) => ({
  screen_name,
  name,
  id: `id-${screen_name}`,
});

const tweet = (id, fields = {}) => ({
  id,
  url: `https://x.com/${fields.author?.screen_name ?? 'pen'}/status/${id}`,
  text: `post ${id}`,
  author: author('pen', 'Penguin'),
  created_timestamp: 1_760_000_000 + Number(id),
  likes: 10,
  retweets: 2,
  replies: 1,
  views: 500,
  lang: 'en',
  replying_to: null,
  replying_to_status: null,
  media: null,
  quote: null,
  ...fields,
});

const api = tweets => {
  const calls = [];
  const byId = Object.fromEntries(tweets.map(item => [item.id, item]));
  const fetcher = async url => {
    calls.push(url);
    const id = url.split('/').pop();
    if (!byId[id]) {
      const error = new Error('404');
      error.response = { status: 404 };
      throw error;
    }
    return { code: 200, message: 'OK', tweet: byId[id] };
  };
  return { fetcher, calls };
};

describe('tweetIdFromUrl', () => {
  test('accepts x, twitter, mobile, i/status and the embed-fixer mirrors', () => {
    for (const url of [
      'https://x.com/pen/status/123456',
      'https://twitter.com/pen/status/123456?s=46&t=abc',
      'https://mobile.twitter.com/pen/status/123456/photo/1',
      'https://x.com/i/web/status/123456',
      'https://fxtwitter.com/pen/status/123456',
      'https://vxtwitter.com/pen/status/123456',
    ]) {
      expect(tweetIdFromUrl(url)).toBe('123456');
      expect(isTwitterContentUrl(url)).toBe(true);
    }
  });

  test('rejects profiles, lists and lookalike hosts', () => {
    for (const url of [
      'https://x.com/pen',
      'https://x.com/i/lists/1',
      'https://x.com.evil.example/pen/status/123456',
      'https://example.com/pen/status/123456',
      'nope',
    ]) {
      expect(tweetIdFromUrl(url)).toBeNull();
    }
  });
});

describe('normalizeFxTweet', () => {
  test('maps text, author, stats, media and the quoted post', () => {
    const out = normalizeFxTweet(
      tweet('3', {
        text: 'look https://t.co/abc and https://example.com/page https://x.com/other/status/1?s=20',
        media: {
          all: [
            {
              type: 'photo',
              url: 'https://pbs.twimg.com/media/a.jpg',
              width: 10,
              height: 20,
              altText: 'a bird',
            },
            { type: 'video', url: 'https://video.twimg.com/v.mp4', width: 1280, height: 720 },
          ],
          external: { url: 'https://youtube.com/watch?v=x' },
        },
        quote: tweet('1', { author: author('other', 'Other'), quote: tweet('0') }),
        possibly_sensitive: true,
        poll: {
          choices: [
            { label: 'yes', count: 3 },
            { label: 'no', count: 1 },
          ],
          total_votes: 4,
        },
      })
    );
    expect(out).toMatchObject({
      id: '3',
      url: 'https://x.com/pen/status/3',
      author: { handle: 'pen', name: 'Penguin', url: 'https://x.com/pen' },
      createdAt: '2025-10-09T08:53:23.000Z',
      text: 'look https://t.co/abc and https://example.com/page https://x.com/other/status/1?s=20',
      links: ['https://example.com/page', 'https://youtube.com/watch?v=x'],
      stats: { likes: 10, reposts: 2, replies: 1, views: 500, score: null },
      flags: { nsfw: true },
      extra: { lang: 'en', poll: { totalVotes: 4 } },
    });
    expect(out.media).toEqual([
      {
        type: 'image',
        url: 'https://pbs.twimg.com/media/a.jpg',
        alt: 'a bird',
        width: 10,
        height: 20,
      },
      { type: 'video', url: 'https://video.twimg.com/v.mp4', alt: null, width: 1280, height: 720 },
    ]);
    expect(out.quoted.author.handle).toBe('other');
    expect(out.quoted.quoted).toBeNull();
    expect(out.parent).toBeNull();
  });

  test('a reply names its parent and an article uses the long text', () => {
    const out = normalizeFxTweet(
      tweet('5', {
        replying_to: 'someone',
        replying_to_status: '4',
        article: { title: 'long read', content: { text: 'the whole article' } },
      })
    );
    expect(out.parent).toEqual({
      id: '4',
      url: 'https://x.com/someone/status/4',
      author: { handle: 'someone', name: null, url: 'https://x.com/someone' },
    });
    expect(out.text).toBe('the whole article');
    expect(out.extra.article).toEqual({ title: 'long read' });
  });
});

describe('fetchTweetThread', () => {
  const chain = [
    tweet('1', { text: '1/ a thread' }),
    tweet('2', { text: '2/ more', replying_to: 'pen', replying_to_status: '1' }),
    tweet('3', { text: '3/ end', replying_to: 'pen', replying_to_status: '2' }),
    tweet('9', {
      text: 'a reply by someone else',
      author: author('fan'),
      replying_to: 'pen',
      replying_to_status: '3',
    }),
  ];

  test('a link to the last post walks up to the first and answers in order', async () => {
    const { fetcher, calls } = api(chain);
    const out = await fetchTweetThread('https://x.com/pen/status/3', { fetcher });
    expect(out.source).toBe('twitter');
    expect(out.url).toBe('https://x.com/pen/status/3');
    expect(out.post.id).toBe('3');
    expect(out.thread.map(item => item.text)).toEqual(['1/ a thread', '2/ more', '3/ end']);
    expect(out.comments).toEqual([]);
    expect(out.truncated).toBe(false);
    expect(calls).toHaveLength(3);
  });

  test('the walk stops where the author changes, and thread:false never walks', async () => {
    const { fetcher } = api(chain);
    const reply = await fetchTweetThread('https://x.com/fan/status/9', { fetcher });
    expect(reply.thread).toEqual([]);
    expect(reply.post.parent.id).toBe('3');

    const { fetcher: again, calls } = api(chain);
    const single = await fetchTweetThread('https://x.com/pen/status/3', {
      fetcher: again,
      thread: false,
    });
    expect(single.thread).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test('a missing parent ends the walk with what was read, marked truncated', async () => {
    const { fetcher } = api(chain.slice(1));
    const out = await fetchTweetThread('https://x.com/pen/status/3', { fetcher });
    expect(out.thread.map(item => item.id)).toEqual(['2', '3']);
    expect(out.truncated).toBe(true);
  });

  test('a deleted post is CONTENT_GONE and a non-status link is BAD_URL', async () => {
    const { fetcher } = api([]);
    await expect(
      fetchTweetThread('https://x.com/pen/status/404', { fetcher })
    ).rejects.toMatchObject({
      code: 'CONTENT_GONE',
    });
    await expect(fetchTweetThread('https://x.com/pen', { fetcher })).rejects.toMatchObject({
      code: 'BAD_URL',
    });
  });

  test('plain text renders the thread in order with the quote indented', async () => {
    const { fetcher } = api([
      tweet('1', { text: 'first' }),
      tweet('2', {
        text: 'second',
        replying_to: 'pen',
        replying_to_status: '1',
        quote: tweet('7', { text: 'quoted words', author: author('q') }),
      }),
    ]);
    const text = toPlainText(await fetchTweetThread('https://x.com/pen/status/2', { fetcher }));
    expect(text).toBe(
      [
        'twitter: https://x.com/pen/status/2',
        '',
        '@pen (Penguin) · 2025-10-09 08:53',
        'first',
        '',
        '@pen (Penguin) · 2025-10-09 08:53',
        'second',
        '> quoting https://x.com/q/status/7',
        '> @q · 2025-10-09 08:53',
        '> quoted words',
        '',
      ].join('\n')
    );
  });
});
