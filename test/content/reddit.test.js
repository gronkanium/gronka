import { test, expect, describe } from 'bun:test';
import { normalizeRedditListing, normalizeRedditPost } from '../../src/content/reddit.js';
import { toPlainText } from '../../src/content/schema.js';

// Shapes taken from real .json?raw_json=1 responses, trimmed to the fields that matter.
const POST_URL = 'https://www.reddit.com/r/pics/comments/1wgx7l1/dog_photo_shoot/';

const reply = (id, body, replies = [], extra = {}) => ({
  kind: 't1',
  data: {
    id,
    author: `user_${id}`,
    body,
    score: 3,
    ups: 3,
    created_utc: 1_760_000_000,
    permalink: `/r/pics/comments/1wgx7l1/dog_photo_shoot/${id}/`,
    parent_id: 't3_1wgx7l1',
    replies: replies.length ? { kind: 'Listing', data: { children: replies } } : '',
    ...extra,
  },
});

const more = count => ({ kind: 'more', data: { count, children: [] } });

const post = (fields = {}) => ({
  id: '1wgx7l1',
  author: 'photographer',
  title: 'dog photo shoot',
  selftext: 'took these yesterday, more at https://example.com/album',
  is_self: true,
  score: 120,
  ups: 130,
  num_comments: 4,
  upvote_ratio: 0.97,
  created_utc: 1_759_990_000,
  permalink: '/r/pics/comments/1wgx7l1/dog_photo_shoot/',
  subreddit: 'pics',
  url: 'https://www.reddit.com/r/pics/comments/1wgx7l1/dog_photo_shoot/',
  over_18: false,
  edited: 1_759_995_000,
  ...fields,
});

const listing = (postData, comments = []) => [
  { data: { children: [{ kind: 't3', data: postData }] } },
  { data: { children: comments } },
];

describe('normalizeRedditPost', () => {
  test('a self post keeps its markdown, finds links, and reports its subreddit', () => {
    const out = normalizeRedditPost(post());
    expect(out).toMatchObject({
      id: '1wgx7l1',
      url: POST_URL,
      author: { handle: 'photographer', url: 'https://www.reddit.com/user/photographer' },
      createdAt: '2025-10-09T06:06:40.000Z',
      title: 'dog photo shoot',
      text: 'took these yesterday, more at https://example.com/album',
      links: ['https://example.com/album'],
      stats: { score: 120, likes: 130, replies: 4, reposts: null, views: null },
      flags: { nsfw: false, spoiler: false, edited: true },
      extra: { subreddit: 'pics', upvoteRatio: 0.97 },
    });
    expect(out.quoted).toBeNull();
    expect(out.media).toEqual([]);
  });

  test('a link post lists its target as a link, an image post as media', () => {
    const link = normalizeRedditPost(
      post({ is_self: false, selftext: '', url: 'https://youtube.com/watch?v=abc' })
    );
    expect(link.links).toEqual(['https://youtube.com/watch?v=abc']);
    const image = normalizeRedditPost(
      post({ is_self: false, selftext: '', url: 'https://i.redd.it/post.jpeg' })
    );
    expect(image.links).toEqual([]);
    expect(image.media).toEqual([
      { type: 'image', url: 'https://i.redd.it/post.jpeg', alt: null, width: null, height: null },
    ]);
  });

  test('galleries keep the declared order and a video post reports its stream', () => {
    const gallery = normalizeRedditPost(
      post({
        gallery_data: { items: [{ media_id: 'bbb' }, { media_id: 'aaa' }] },
        media_metadata: {
          aaa: {
            status: 'valid',
            e: 'Image',
            m: 'image/jpg',
            s: { u: 'https://i.redd.it/aaa.jpg', x: 10, y: 20 },
          },
          bbb: {
            status: 'valid',
            e: 'AnimatedImage',
            m: 'image/gif',
            s: { gif: 'https://i.redd.it/bbb.gif' },
          },
          ccc: { status: 'failed' },
        },
      })
    );
    expect(gallery.media.map(item => item.url)).toEqual([
      'https://i.redd.it/bbb.gif',
      'https://i.redd.it/aaa.jpg',
    ]);
    expect(gallery.media[0].type).toBe('gif');
    expect(gallery.media[1]).toMatchObject({ width: 10, height: 20 });

    const video = normalizeRedditPost(
      post({
        media: {
          reddit_video: {
            fallback_url: 'https://v.redd.it/x/DASH_720.mp4',
            width: 1280,
            height: 720,
            is_gif: false,
          },
        },
      })
    );
    expect(video.media).toEqual([
      {
        type: 'video',
        url: 'https://v.redd.it/x/DASH_720.mp4',
        alt: null,
        width: 1280,
        height: 720,
      },
    ]);
  });

  test('a crosspost carries the original as quoted, one level deep', () => {
    const out = normalizeRedditPost(
      post({
        crosspost_parent_list: [
          post({
            id: 'orig',
            subreddit: 'aww',
            permalink: '/r/aww/comments/orig/x/',
            crosspost_parent_list: [post({ id: 'deeper' })],
          }),
        ],
      })
    );
    expect(out.quoted.id).toBe('orig');
    expect(out.quoted.extra.subreddit).toBe('aww');
    expect(out.quoted.quoted).toBeNull();
  });

  test('deleted authors become null rather than the placeholder', () => {
    expect(normalizeRedditPost(post({ author: '[deleted]' })).author).toEqual({
      handle: null,
      name: null,
      url: null,
    });
  });
});

describe('normalizeRedditListing', () => {
  const tree = [
    reply(
      'c1',
      'good dog',
      [reply('c1a', 'the best', [reply('c1a1', 'agreed')]), reply('c1b', 'ok')],
      {
        is_submitter: false,
        distinguished: 'moderator',
      }
    ),
    reply('c2', 'second', [], { author: 'photographer', is_submitter: true }),
  ];

  test('builds the comment tree with depth, op and parent ids', () => {
    const out = normalizeRedditListing(listing(post(), tree), POST_URL, { comments: 20 });
    expect(out.source).toBe('reddit');
    expect(out.url).toBe(POST_URL);
    expect(out.thread).toEqual([]);
    expect(out.truncated).toBe(false);
    expect(out.comments).toHaveLength(2);
    expect(out.comments[0]).toMatchObject({
      id: 'c1',
      depth: 0,
      text: 'good dog',
      parent: { id: '1wgx7l1' },
      extra: { op: false, distinguished: 'moderator' },
    });
    expect(out.comments[0].replies.map(item => item.id)).toEqual(['c1a', 'c1b']);
    expect(out.comments[0].replies[0].replies[0]).toMatchObject({ id: 'c1a1', depth: 2 });
    expect(out.comments[1].extra.op).toBe(true);
  });

  test('depth and comments caps mark the result truncated', () => {
    const shallow = normalizeRedditListing(listing(post(), tree), POST_URL, {
      depth: 1,
      comments: 20,
    });
    expect(shallow.comments.map(item => item.id)).toEqual(['c1', 'c2']);
    expect(shallow.comments[0].replies).toEqual([]);
    expect(shallow.truncated).toBe(true);

    const none = normalizeRedditListing(listing(post(), tree), POST_URL, {
      depth: 0,
      comments: 20,
    });
    expect(none.comments).toEqual([]);
    expect(none.truncated).toBe(true);

    const few = normalizeRedditListing(listing(post(), tree), POST_URL, { comments: 2 });
    expect(few.comments).toHaveLength(1);
    expect(few.comments[0].replies).toHaveLength(1);
    expect(few.truncated).toBe(true);

    const stub = normalizeRedditListing(listing(post(), [reply('c1', 'x'), more(40)]), POST_URL, {
      comments: 20,
    });
    expect(stub.comments).toHaveLength(1);
    expect(stub.truncated).toBe(true);
  });

  test('a comment permalink makes that comment the subject and its replies the tree', () => {
    const out = normalizeRedditListing(listing(post(), [tree[0]]), `${POST_URL}c1/`, {
      comments: 20,
    });
    expect(out.post).toMatchObject({ id: 'c1', text: 'good dog', title: null });
    expect(out.post.depth).toBeUndefined();
    expect(out.comments.map(item => item.id)).toEqual(['c1a', 'c1b']);
    expect(out.comments[0]).toMatchObject({ depth: 1 });
  });

  test('a removed or missing post is CONTENT_GONE', () => {
    expect(() => normalizeRedditListing([{ data: { children: [] } }], POST_URL)).toThrow(
      /unavailable/
    );
  });

  test('plain text puts the post first and indents the comments', () => {
    const text = toPlainText(
      normalizeRedditListing(listing(post(), tree), POST_URL, { comments: 20 })
    );
    expect(text.startsWith(`reddit: ${POST_URL}\n\n# dog photo shoot\n@photographer`)).toBe(true);
    expect(text).toContain('--- comments ---');
    expect(text).toContain('\n@user_c1 · 2025-10-09 08:53\ngood dog\n');
    expect(text).toContain('\n    @user_c1a · 2025-10-09 08:53\n    the best\n');
    expect(text).toContain('\n        @user_c1a1 · 2025-10-09 08:53\n        agreed\n');
  });
});
