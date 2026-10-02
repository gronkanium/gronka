import { test, expect, describe } from 'bun:test';
import {
  isBlueskyContentUrl,
  normalizePost,
  fetchBlueskyThread,
} from '../../src/content/bluesky.js';

const DID = 'did:plc:pen';
const author = (handle = 'pen.bsky.social', did = DID) => ({
  did,
  handle,
  displayName: handle === 'pen.bsky.social' ? 'Penguin' : '',
});

const view = (rkey, fields = {}) => ({
  uri: `at://${fields.did ?? DID}/app.bsky.feed.post/${rkey}`,
  author: author(fields.handle, fields.did),
  record: {
    text: `post ${rkey}`,
    createdAt: '2026-10-01T12:00:00.000Z',
    langs: ['en'],
    ...fields.record,
  },
  embed: fields.embed,
  likeCount: 10,
  repostCount: 2,
  replyCount: 1,
  quoteCount: 3,
  labels: fields.labels ?? [],
});

const node = (rkey, { parent, replies, ...fields } = {}) => ({
  $type: 'app.bsky.feed.defs#threadViewPost',
  post: view(rkey, fields),
  parent,
  replies,
});

const fan = (rkey, n) => node(rkey, { handle: `fan${n}.bsky.social`, did: `did:plc:fan${n}` });

const fakeGet = thread => {
  const calls = [];
  const get = async (uri, params) => {
    calls.push({ uri, ...params });
    return { thread };
  };
  return { get, calls };
};

describe('isBlueskyContentUrl', () => {
  test('accepts post links by handle and by did', () => {
    for (const url of [
      'https://bsky.app/profile/pen.bsky.social/post/3kabc',
      'https://bsky.app/profile/did:plc:pen/post/3kabc',
      'https://www.bsky.app/profile/pen.bsky.social/post/3kabc/',
    ]) {
      expect(isBlueskyContentUrl(url)).toBe(true);
    }
  });

  test('rejects profiles, feeds and lookalike hosts', () => {
    for (const url of [
      'https://bsky.app/profile/pen.bsky.social',
      'https://bsky.app/profile/pen.bsky.social/feed/abc',
      'https://bsky.app.evil.example/profile/pen.bsky.social/post/3kabc',
      'https://notbsky.app/profile/pen.bsky.social/post/3kabc',
      'nope',
    ]) {
      expect(isBlueskyContentUrl(url)).toBe(false);
    }
  });
});

describe('normalizePost', () => {
  test('maps text, links, author, stats, media, the quoted post and nsfw', () => {
    const quoted = {
      $type: 'app.bsky.embed.record#viewRecord',
      uri: 'at://did:plc:gull/app.bsky.feed.post/3kq',
      author: author('gull.bsky.social', 'did:plc:gull'),
      value: { text: 'quoted words', createdAt: '2026-10-01T11:00:00.000Z' },
      embeds: [],
    };
    const out = normalizePost(
      view('3kp', {
        record: {
          text: 'look example.com/page',
          facets: [
            {
              features: [
                { $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/page' },
              ],
            },
            { features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:x' }] },
          ],
          reply: { parent: { uri: 'at://did:plc:gull/app.bsky.feed.post/3kq' } },
        },
        labels: [{ val: 'porn' }],
        embed: {
          $type: 'app.bsky.embed.recordWithMedia#view',
          record: { record: quoted },
          media: {
            $type: 'app.bsky.embed.images#view',
            images: [
              {
                fullsize: 'https://cdn.bsky.app/img/a.jpg',
                alt: 'a penguin',
                aspectRatio: { width: 800, height: 600 },
              },
            ],
          },
        },
      })
    );
    expect(out.id).toBe('3kp');
    expect(out.url).toBe('https://bsky.app/profile/pen.bsky.social/post/3kp');
    expect(out.text).toBe('look example.com/page');
    expect(out.links).toEqual(['https://example.com/page']);
    expect(out.author).toEqual({
      handle: 'pen.bsky.social',
      name: 'Penguin',
      url: 'https://bsky.app/profile/pen.bsky.social',
    });
    expect(out.createdAt).toBe('2026-10-01T12:00:00.000Z');
    expect(out.stats).toMatchObject({ likes: 10, reposts: 2, replies: 1 });
    expect(out.extra).toEqual({ lang: 'en', quotes: 3 });
    expect(out.flags.nsfw).toBe(true);
    expect(out.media).toEqual([
      {
        type: 'image',
        url: 'https://cdn.bsky.app/img/a.jpg',
        alt: 'a penguin',
        width: 800,
        height: 600,
      },
    ]);
    expect(out.quoted).toMatchObject({
      id: '3kq',
      text: 'quoted words',
      author: { handle: 'gull.bsky.social', name: null },
    });
    expect(out.parent).toMatchObject({ id: '3kq' });
  });

  test('video uses the playlist, an external card becomes a link, unknown shapes are null', () => {
    const video = normalizePost(
      view('v', {
        embed: {
          $type: 'app.bsky.embed.video#view',
          playlist: 'https://video.bsky.app/watch/v/playlist.m3u8',
          aspectRatio: { width: 16, height: 9 },
        },
      })
    );
    expect(video.media).toMatchObject([
      { type: 'video', url: 'https://video.bsky.app/watch/v/playlist.m3u8', width: 16, height: 9 },
    ]);
    const card = normalizePost(
      view('e', {
        embed: {
          $type: 'app.bsky.embed.external#view',
          external: { uri: 'https://example.com/article' },
        },
      })
    );
    expect(card.links).toEqual(['https://example.com/article']);
    expect(card.flags.nsfw).toBe(false);
    expect(normalizePost({ $type: 'app.bsky.feed.defs#notFoundPost' })).toBeNull();
  });
});

describe('fetchBlueskyThread', () => {
  const url = 'https://bsky.app/profile/pen.bsky.social/post/3k2';

  test('walks up while the author matches and appends the author following up below', async () => {
    const root = node('3k0');
    const middle = node('3k1', { parent: root });
    const other = node('3kx', { handle: 'gull.bsky.social', did: 'did:plc:gull', parent: middle });
    const subject = node('3k2', {
      parent: other,
      replies: [fan('f1', 1), node('3k3', { replies: [node('3k4')] })],
    });
    const { get, calls } = fakeGet(subject);
    const out = await fetchBlueskyThread(url, { get });
    expect(out.thread.map(p => p.id)).toEqual(['3k2', '3k3', '3k4']);
    expect(calls[0].uri).toBe('at://pen.bsky.social/app.bsky.feed.post/3k2');

    const chain = node('3k2', { parent: node('3k1', { parent: node('3k0') }) });
    const walked = await fetchBlueskyThread(url, { get: fakeGet(chain).get });
    expect(walked.thread.map(p => p.id)).toEqual(['3k0', '3k1', '3k2']);
    expect(walked.truncated).toBe(false);
  });

  test('thread:false asks for no parents and a lone post has an empty thread', async () => {
    const { get, calls } = fakeGet(node('3k2'));
    const out = await fetchBlueskyThread(url, { get, thread: false });
    expect(calls[0].parentHeight).toBe(0);
    expect(out.thread).toEqual([]);
    expect(out.post.id).toBe('3k2');
  });

  test('a chain longer than the parent window is marked truncated', async () => {
    const top = node('3k1');
    top.post.record.reply = { parent: { uri: `at://${DID}/app.bsky.feed.post/3k0` } };
    const out = await fetchBlueskyThread(url, { get: fakeGet(node('3k2', { parent: top })).get });
    expect(out.thread.map(p => p.id)).toEqual(['3k1', '3k2']);
    expect(out.truncated).toBe(true);
  });

  test('replies are off by default, then capped at 20 with their own replies at depth 1', async () => {
    const replies = Array.from({ length: 25 }, (_, i) => ({
      ...fan(`r${i}`, i),
      replies: [node(`s${i}`, { handle: 'gull.bsky.social', did: 'did:plc:gull' })],
    }));
    const subject = node('3k2', { replies: [node('3k3'), ...replies] });
    const off = await fetchBlueskyThread(url, { get: fakeGet(subject).get });
    expect(off.comments).toEqual([]);
    expect(off.truncated).toBe(false);

    const few = await fetchBlueskyThread(url, { get: fakeGet(subject).get, comments: 3 });
    expect(few.comments.map(c => c.id)).toEqual(['r0', 'r1', 'r2']);
    expect(few.comments[0]).toMatchObject({ depth: 0 });
    expect(few.comments[0].replies[0]).toMatchObject({ depth: 1, id: 's0' });
    expect(few.truncated).toBe(true);

    const capped = await fetchBlueskyThread(url, { get: fakeGet(subject).get, comments: 500 });
    expect(capped.comments).toHaveLength(20);
  });

  test('a missing post is CONTENT_GONE and a non-post link is BAD_URL', async () => {
    for (const thread of [undefined, { $type: 'app.bsky.feed.defs#notFoundPost' }]) {
      await expect(fetchBlueskyThread(url, { get: fakeGet(thread).get })).rejects.toMatchObject({
        code: 'CONTENT_GONE',
      });
    }
    await expect(
      fetchBlueskyThread('https://bsky.app/profile/pen.bsky.social', { get: fakeGet().get })
    ).rejects.toMatchObject({ code: 'BAD_URL', statusCode: 400 });
  });
});
