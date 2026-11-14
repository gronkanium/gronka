import { describe, test, expect } from 'bun:test';
import { fetchPageThread } from '../../src/content/page.js';
import { fetchListThread } from '../../src/content/list.js';
import { normalizeThreadsPost } from '../../src/content/threads.js';
import { toPlainText } from '../../src/content/schema.js';

const ARTICLE = `<!doctype html><html lang="en-GB"><head>
<title>Ignored &amp; title</title>
<link rel="canonical" href="/news/penguins">
<meta property="og:title" content="Penguins &amp; the sea">
<meta property="og:description" content="A short blurb.">
<meta property="og:image" content="/img/p.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:site_name" content="Bird News">
<meta property="og:video" content="https://player.example/embed/1">
<meta property="og:video:type" content="text/html">
<meta property="article:published_time" content="2026-11-01T10:00:00Z">
<meta property="article:tag" content="birds">
<script type="application/ld+json">{"@graph":[{"@type":"WebSite","name":"Bird News"},
{"@type":"NewsArticle","headline":"H","author":[{"@type":"Person","name":"Ana Ruiz","url":"https://birds.example/ana"}]}]}</script>
</head><body><nav><p>menu</p></nav><article><p>First &#8220;line&#8221; with <a href="https://src.example/a">a link</a>.</p>
<p>Second   line.</p></article></body></html>`;

const page =
  (html, type = 'text/html; charset=utf-8') =>
  async url => ({ url, type, html });

describe('page reader', () => {
  test('an article reads as its own title, author, date, body and picture', async () => {
    const { source, url, post } = await fetchPageThread(
      'https://birds.example/news/penguins?utm=x',
      {
        fetcher: page(ARTICLE),
      }
    );
    expect(source).toBe('page');
    expect(url).toBe('https://birds.example/news/penguins');
    expect(post.title).toBe('Penguins & the sea');
    expect(post.author).toEqual({
      handle: null,
      name: 'Ana Ruiz',
      url: 'https://birds.example/ana',
    });
    expect(post.createdAt).toBe('2026-11-01T10:00:00.000Z');
    expect(post.text).toBe('First “line” with a link.\n\nSecond line.');
    expect(post.media).toEqual([
      {
        type: 'image',
        url: 'https://birds.example/img/p.jpg',
        alt: null,
        width: 1200,
        height: null,
      },
    ]);
    expect(post.extra).toMatchObject({
      site: 'Bird News',
      language: 'en-GB',
      description: 'A short blurb.',
      tags: ['birds'],
    });
  });

  test('a page with no article falls back to its description, and nothing invents an image', async () => {
    const html = '<html><head><meta name="description" content="Just a blurb"></head></html>';
    const { post } = await fetchPageThread('https://plain.example/', { fetcher: page(html) });
    expect(post.text).toBe('Just a blurb');
    expect(post.media).toEqual([]);
    expect(post.extra.description).toBeNull();
  });

  test("a file link is a file, and a link that isn't html is refused", async () => {
    const file = await fetchPageThread('https://cdn.example/clip.mp4', {
      fetcher: () => {
        throw new Error('a file link is never fetched');
      },
    });
    expect(file.post.media[0]).toMatchObject({
      type: 'video',
      url: 'https://cdn.example/clip.mp4',
    });
    await expect(
      fetchPageThread('https://cdn.example/report', { fetcher: page('%PDF', 'application/pdf') })
    ).rejects.toMatchObject({ code: 'BAD_URL' });
  });
});

describe('list reader', () => {
  test('a list answers with its entries, capped, and says how many there were', async () => {
    const entries = Array.from({ length: 120 }, (_, i) => ({
      url: `https://open.spotify.com/track/${i}`,
      title: `Song ${i}`,
      artist: 'Band',
      duration: 61,
    }));
    const out = await fetchListThread('https://open.spotify.com/playlist/x', {
      readPage: async () =>
        fetchPageThread('https://open.spotify.com/playlist/x', {
          fetcher: page('<meta property="og:title" content="Page title">'),
        }),
      collection: { kind: 'audio', list: async () => ({ title: 'Mix', total: null, entries }) },
    });
    expect(out.source).toBe('list');
    expect(out.post.title).toBe('Mix');
    expect(out.post.extra).toMatchObject({ kind: 'audio', total: 120 });
    expect(out.post.extra.entries).toHaveLength(100);
    expect(out.truncated).toBe(true);
    expect(toPlainText(out)).toContain('1. Band - Song 0 (01:01) https://open.spotify.com/track/0');
  });
});

describe('threads reader', () => {
  test('a threads post links back to threads and counts its replies and reposts', () => {
    const out = normalizeThreadsPost(
      {
        pk: '1',
        code: 'Abc',
        caption: { text: 'hello' },
        user: { username: 'nasa', full_name: 'NASA' },
        taken_at: 1790000000,
        like_count: 5,
        text_post_app_info: { direct_reply_count: 3, repost_count: 2, quote_count: 1 },
      },
      'Abc'
    );
    expect(out.url).toBe('https://www.threads.com/@nasa/post/Abc');
    expect(out.author.url).toBe('https://www.threads.com/@nasa');
    expect(out.stats).toMatchObject({ likes: 5, replies: 3, reposts: 2 });
    expect(out.extra.quotes).toBe(1);
  });
});
