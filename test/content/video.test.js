import { test, expect, describe } from 'bun:test';
import {
  isVideoContentUrl,
  fetchVideoThread,
  pickTrack,
  parseJson3,
  VIDEO_LIMITS,
} from '../../src/content/video.js';
import { toPlainText } from '../../src/content/schema.js';

const info = (fields = {}) => ({
  id: 'abc',
  title: 'A video',
  description: 'see https://example.com/a, and more',
  uploader: 'Pen Channel',
  uploader_id: '@pen',
  uploader_url: 'https://www.youtube.com/@pen',
  timestamp: 1790000000,
  like_count: 5,
  comment_count: 40,
  view_count: 900,
  duration: 61,
  tags: Array.from({ length: 40 }, (_, i) => `t${i}`),
  categories: ['Music'],
  chapters: [{ title: 'Intro', start_time: 0, end_time: 10 }],
  thumbnails: [
    { url: 'https://i/small.jpg', width: 100, height: 50 },
    { url: 'https://i/big.jpg', width: 1280, height: 720 },
  ],
  webpage_url: 'https://www.youtube.com/watch?v=abc',
  ...fields,
});

const runnerOf =
  (data, calls = []) =>
  async args => {
    calls.push(args);
    return JSON.stringify(data);
  };

const failing = stderr => async () => {
  throw Object.assign(new Error('exit 1'), { stderr });
};

describe('isVideoContentUrl', () => {
  test('accepts yt-dlp sites', () => {
    for (const u of [
      'https://www.youtube.com/watch?v=abc',
      'https://youtu.be/abc',
      'https://soundcloud.com/a/b',
      'https://vimeo.com/123',
    ]) {
      expect(isVideoContentUrl(u)).toBe(true);
    }
  });

  test('rejects sources with their own reader and unknown hosts', () => {
    for (const u of [
      'https://www.reddit.com/r/a/comments/1/x/',
      'https://v.redd.it/abc',
      'https://x.com/a/status/1',
      'https://www.instagram.com/reel/abc/',
      'https://www.tiktok.com/@a/video/1',
      'https://example.com/video',
      'not a url',
    ]) {
      expect(isVideoContentUrl(u)).toBe(false);
    }
  });
});

describe('fetchVideoThread', () => {
  const url = 'https://www.youtube.com/watch?v=abc';

  test('normalizes the metadata', async () => {
    const { post } = await fetchVideoThread(url, { runner: runnerOf(info()) });
    expect(post.title).toBe('A video');
    expect(post.author).toEqual({
      handle: '@pen',
      name: 'Pen Channel',
      url: 'https://www.youtube.com/@pen',
    });
    expect(post.createdAt).toBe('2026-09-21T14:13:20.000Z');
    expect(post.stats).toMatchObject({ likes: 5, replies: 40, views: 900 });
    expect(post.media).toHaveLength(1);
    expect(post.media[0]).toMatchObject({ type: 'image', url: 'https://i/big.jpg', duration: 61 });
    expect(post.links).toEqual(['https://example.com/a']);
    expect(post.extra.site).toBe('YouTube');
    expect(post.extra.tags).toHaveLength(30);
    expect(post.extra.chapters).toEqual([{ title: 'Intro', start: 0 }]);
    expect(post.flags.nsfw).toBe(false);
  });

  test('falls back to upload_date and flags age-limited videos', async () => {
    const { post } = await fetchVideoThread(url, {
      runner: runnerOf(info({ timestamp: undefined, upload_date: '20260102', age_limit: 18 })),
    });
    expect(post.createdAt).toBe('2026-01-02T00:00:00.000Z');
    expect(post.flags.nsfw).toBe(true);
  });

  test('comments are off by default', async () => {
    const calls = [];
    const result = await fetchVideoThread(url, { runner: runnerOf(info(), calls) });
    expect(calls[0]).not.toContain('--write-comments');
    expect(result.comments).toEqual([]);
  });

  test('comments are capped and only top level', async () => {
    const calls = [];
    const comments = [
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `c${i}`,
        text: `hi ${i}`,
        author: 'a',
        author_id: '@a',
        parent: 'root',
        like_count: i,
      })),
      { id: 'r', text: 'reply', parent: 'c0' },
    ];
    const result = await fetchVideoThread(url, {
      comments: 100,
      runner: runnerOf(info({ comments }), calls),
    });
    const args = calls[0].join(' ');
    expect(args).toContain(`youtube:max_comments=${VIDEO_LIMITS.comments},all,0,0`);
    expect(result.comments).toHaveLength(VIDEO_LIMITS.comments);
    expect(result.comments[0]).toMatchObject({ id: 'c0', depth: 0, text: 'hi 0' });
    expect(result.truncated).toBe(true);
  });

  test('comments are ignored off YouTube', async () => {
    const calls = [];
    await fetchVideoThread('https://soundcloud.com/a/b', {
      comments: 5,
      runner: runnerOf(info(), calls),
    });
    expect(calls[0]).not.toContain('--write-comments');
  });

  test('removed videos are CONTENT_GONE', async () => {
    const error = await fetchVideoThread(url, {
      runner: failing('ERROR: [youtube] abc: Video unavailable'),
    }).catch(e => e);
    expect(error.code).toBe('CONTENT_GONE');
  });

  test('unsupported pages are a 400', async () => {
    const error = await fetchVideoThread(url, {
      runner: failing('ERROR: Unsupported URL: https://x'),
    }).catch(e => e);
    expect(error.code).toBe('BAD_URL');
    expect(error.statusCode).toBe(400);
  });

  test('other failures are curated', async () => {
    const error = await fetchVideoThread(url, { runner: failing('ERROR: boom') }).catch(e => e);
    expect(error.message).toBe('failed to read this video');
  });

  test('rejects links it does not read', async () => {
    const error = await fetchVideoThread('https://example.com/x', { runner: runnerOf({}) }).catch(
      e => e
    );
    expect(error.code).toBe('BAD_URL');
  });
});

const track = (name, url) => ({
  [name]: [
    { ext: 'vtt', url: 'v' },
    { ext: 'json3', url },
  ],
});

describe('transcripts', () => {
  test('prefers uploaded captions, then the untranslated auto track', () => {
    const auto = { ...track('en', 'auto-en'), ...track('en-orig', 'orig') };
    expect(pickTrack({ language: 'en', automatic_captions: auto })).toEqual({
      language: 'en-orig',
      url: 'orig',
      generated: true,
    });
    expect(
      pickTrack({ language: 'en', subtitles: track('en-US', 'up'), automatic_captions: auto })
    ).toEqual({ language: 'en-US', url: 'up', generated: false });
    expect(pickTrack({ subtitles: track('live_chat', 'chat') }, 'en')).toBeNull();
    expect(pickTrack({ language: 'de', subtitles: track('en', 'up') })).toBeNull();
  });

  test('parses json3 into timed lines and skips empty events', () => {
    expect(
      parseJson3({
        events: [
          { tStartMs: 0, dDurationMs: 500 },
          { tStartMs: 1500, dDurationMs: 2000, segs: [{ utf8: 'hello ' }, { utf8: '\nthere' }] },
          { tStartMs: 4000, segs: [{ utf8: '\n' }] },
        ],
      })
    ).toEqual([{ start: 1.5, end: 3.5, text: 'hello there' }]);
  });

  test('adds the transcript to youtube posts only when asked', async () => {
    const data = info({ language: 'en', automatic_captions: track('en-orig', 'cap') });
    const fetched = [];
    const fetcher = async u => {
      fetched.push(u);
      return { events: [{ tStartMs: 61000, dDurationMs: 1000, segs: [{ utf8: 'penguins' }] }] };
    };
    const plain = await fetchVideoThread('https://youtu.be/abc', {
      runner: runnerOf(data),
      fetcher,
    });
    expect(plain.post.extra.transcript).toBeUndefined();
    const result = await fetchVideoThread('https://youtu.be/abc', {
      transcript: true,
      runner: runnerOf(data),
      fetcher,
    });
    expect(fetched).toEqual(['cap']);
    expect(result.post.extra.transcript).toEqual({
      language: 'en-orig',
      generated: true,
      segments: [{ start: 61, end: 62, text: 'penguins' }],
    });
    expect(toPlainText(result)).toContain('[01:01] penguins');
    const none = await fetchVideoThread('https://youtu.be/abc', {
      transcript: true,
      runner: runnerOf(info()),
      fetcher,
    });
    expect(none.post.extra.transcript).toBeNull();
  });
});
