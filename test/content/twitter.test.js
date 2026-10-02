import { test, expect, describe } from 'bun:test';
import {
  tweetIdFromUrl,
  isTwitterContentUrl,
  normalizeTweet,
  fetchTweetThread,
} from '../../src/content/twitter.js';
import { toPlainText } from '../../src/content/schema.js';

// Shapes from x's graphql TweetResultByRestId / TweetDetail, trimmed to the fields that matter.
const user = (screen_name, name = screen_name) => ({
  result: { core: { screen_name, name }, legacy: {} },
});

const tweet = (id, fields = {}) => ({
  __typename: 'Tweet',
  rest_id: id,
  core: { user_results: user(fields.handle ?? 'pen', fields.name ?? 'Penguin') },
  views: { count: '500' },
  legacy: {
    id_str: id,
    full_text: `post ${id}`,
    created_at: 'Wed Oct 01 12:00:00 +0000 2026',
    favorite_count: 10,
    retweet_count: 2,
    reply_count: 1,
    quote_count: 0,
    lang: 'en',
    entities: { urls: [], media: [] },
    in_reply_to_status_id_str: fields.replyTo ?? null,
    in_reply_to_screen_name: fields.replyToHandle ?? null,
    ...fields.legacy,
  },
  ...fields.extra,
});

// A fake gql: posts by id for TweetResultByRestId, a fixed conversation for TweetDetail.
const api = (tweets, { conversation = [], guestHidden = [] } = {}) => {
  const calls = [];
  const byId = Object.fromEntries(tweets.map(item => [item.rest_id, item]));
  const gql = async (op, variables, { session }) => {
    calls.push({ op, session, id: variables.tweetId ?? variables.focalTweetId });
    if (op === 'TweetDetail') {
      return {
        data: {
          threaded_conversation_with_injections_v2: {
            instructions: [
              {
                entries: conversation.map((items, i) => ({
                  entryId: `conversationthread-${i}`,
                  content: {
                    items: items.map(result => ({
                      item: { itemContent: { tweet_results: { result } } },
                    })),
                  },
                })),
              },
            ],
          },
        },
      };
    }
    const id = variables.tweetId;
    const hidden = !session && guestHidden.includes(id);
    const result = byId[id] && !hidden ? byId[id] : { __typename: 'TweetTombstone' };
    return { data: { tweetResult: { result } } };
  };
  return { gql, calls };
};

describe('tweetIdFromUrl', () => {
  test('accepts x, twitter, mobile, i/status and embed mirrors', () => {
    for (const url of [
      'https://x.com/pen/status/123456',
      'https://twitter.com/pen/status/123456?s=46&t=abc',
      'https://mobile.twitter.com/pen/status/123456/photo/1',
      'https://x.com/i/web/status/123456',
      'https://fixupx.com/pen/status/123456',
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

describe('normalizeTweet', () => {
  test('maps text with expanded links, author, stats, media and the quoted post', () => {
    const out = normalizeTweet(
      tweet('5', {
        legacy: {
          full_text: 'look https://t.co/abc https://t.co/media',
          entities: {
            urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com/page' }],
            media: [{ url: 'https://t.co/media' }],
          },
          extended_entities: {
            media: [
              {
                type: 'photo',
                media_url_https: 'https://pbs.twimg.com/media/a.jpg',
                ext_alt_text: 'a penguin',
                original_info: { width: 800, height: 600 },
              },
              {
                type: 'video',
                video_info: {
                  variants: [
                    {
                      content_type: 'video/mp4',
                      bitrate: 256000,
                      url: 'https://video.twimg.com/low.mp4',
                    },
                    {
                      content_type: 'video/mp4',
                      bitrate: 2176000,
                      url: 'https://video.twimg.com/high.mp4',
                    },
                    {
                      content_type: 'application/x-mpegURL',
                      url: 'https://video.twimg.com/pl.m3u8',
                    },
                  ],
                },
              },
            ],
          },
          possibly_sensitive: true,
        },
        extra: { quoted_status_result: { result: tweet('4', { handle: 'gull' }) } },
      })
    );
    expect(out.text).toBe('look https://example.com/page');
    expect(out.author).toEqual({ handle: 'pen', name: 'Penguin', url: 'https://x.com/pen' });
    expect(out.createdAt).toBe('2026-10-01T12:00:00.000Z');
    expect(out.stats).toMatchObject({ likes: 10, reposts: 2, replies: 1, views: 500 });
    expect(out.flags.nsfw).toBe(true);
    expect(out.media).toEqual([
      {
        type: 'image',
        url: 'https://pbs.twimg.com/media/a.jpg?name=orig',
        alt: 'a penguin',
        width: 800,
        height: 600,
      },
      {
        type: 'video',
        url: 'https://video.twimg.com/high.mp4',
        alt: null,
        width: null,
        height: null,
      },
    ]);
    expect(out.links).toEqual(['https://example.com/page']);
    expect(out.quoted).toMatchObject({ id: '4', author: { handle: 'gull' } });
  });

  test('long posts use the note text, replies name their parent, tombstones are null', () => {
    const out = normalizeTweet({
      __typename: 'TweetWithVisibilityResults',
      tweet: tweet('7', {
        replyTo: '6',
        replyToHandle: 'gull',
        extra: { note_tweet: { note_tweet_results: { result: { text: 'the whole long post' } } } },
      }),
    });
    expect(out.text).toBe('the whole long post');
    expect(out.parent).toEqual({
      id: '6',
      url: 'https://x.com/gull/status/6',
      author: { handle: 'gull', name: null, url: 'https://x.com/gull' },
    });
    expect(normalizeTweet({ __typename: 'TweetTombstone' })).toBeNull();
  });
});

describe('fetchTweetThread', () => {
  const chain = [
    tweet('1'),
    tweet('2', { replyTo: '1', replyToHandle: 'pen' }),
    tweet('3', { replyTo: '2', replyToHandle: 'pen' }),
  ];

  test('a link to the last post walks up as a guest and answers in order', async () => {
    const { gql, calls } = api(chain);
    const out = await fetchTweetThread('https://x.com/pen/status/3', { gql });
    expect(out.thread.map(p => p.id)).toEqual(['1', '2', '3']);
    expect(out.post.id).toBe('3');
    expect(calls.every(c => c.session === false)).toBe(true);
  });

  test('the walk stops where the author changes, and thread:false never walks', async () => {
    const { gql } = api([
      tweet('1', { handle: 'gull' }),
      tweet('2', { replyTo: '1', replyToHandle: 'gull' }),
    ]);
    expect((await fetchTweetThread('https://x.com/pen/status/2', { gql })).thread).toEqual([]);
    const second = api(chain);
    await fetchTweetThread('https://x.com/pen/status/3', { gql: second.gql, thread: false });
    expect(second.calls).toHaveLength(1);
  });

  test('a deleted post is CONTENT_GONE and a non-status link is BAD_URL', async () => {
    const { gql } = api([]);
    await expect(fetchTweetThread('https://x.com/pen/status/9', { gql })).rejects.toMatchObject({
      code: 'CONTENT_GONE',
    });
    await expect(fetchTweetThread('https://x.com/pen', { gql })).rejects.toMatchObject({
      code: 'BAD_URL',
    });
  });

  test('replies are off unless asked for, and plain text renders the thread in order', async () => {
    const { gql, calls } = api(chain);
    const out = await fetchTweetThread('https://x.com/pen/status/3', { gql });
    expect(out.comments).toEqual([]);
    expect(calls.some(c => c.op === 'TweetDetail')).toBe(false);
    expect(toPlainText(out)).toContain('post 1');
    expect(toPlainText(out).indexOf('post 1')).toBeLessThan(toPlainText(out).indexOf('post 3'));
  });
});

describe('with an x session', () => {
  const withSession = async fn => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(os.tmpdir(), `x-session-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({ twitter: ['auth_token=fake; ct0=fake'] }));
    const before = process.env.INSTAGRAM_COOKIES_PATH;
    process.env.INSTAGRAM_COOKIES_PATH = file;
    try {
      await fn();
    } finally {
      process.env.INSTAGRAM_COOKIES_PATH = before;
      fs.rmSync(file, { force: true });
    }
  };

  test('a post guests cannot see is read with the session', () =>
    withSession(async () => {
      const { gql, calls } = api([tweet('8')], { guestHidden: ['8'] });
      const out = await fetchTweetThread('https://x.com/pen/status/8', { gql });
      expect(out.post.id).toBe('8');
      expect(calls.map(c => c.session)).toEqual([false, true]);
    }));

  test('replies are capped, and the author following up below is thread, not comments', () =>
    withSession(async () => {
      const own = tweet('11', { replyTo: '10', replyToHandle: 'pen' });
      const replies = Array.from({ length: 25 }, (_, i) =>
        tweet(`2${i}`, { handle: `fan${i}`, replyTo: '10', replyToHandle: 'pen' })
      );
      const { gql } = api([tweet('10')], {
        conversation: [[own], ...replies.map(r => [r, tweet(`9${r.rest_id}`, { handle: 'pen' })])],
      });
      const out = await fetchTweetThread('https://x.com/pen/status/10', { gql, comments: 3 });
      expect(out.thread.map(p => p.id)).toEqual(['10', '11']);
      expect(out.comments.map(c => c.author.handle)).toEqual(['fan0', 'fan1', 'fan2']);
      expect(out.comments[0].replies[0]).toMatchObject({ depth: 1, author: { handle: 'pen' } });
      expect(out.truncated).toBe(true);
      const capped = await fetchTweetThread('https://x.com/pen/status/10', { gql, comments: 500 });
      expect(capped.comments).toHaveLength(20);
    }));
});
