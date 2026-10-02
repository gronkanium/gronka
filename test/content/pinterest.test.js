import { test, expect, describe } from 'bun:test';
import { isPinterestContentUrl, fetchPinterestThread } from '../../src/content/pinterest.js';

const ld = data => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

const imagePin = ld({
  '@type': 'SocialMediaPosting',
  author: { name: 'Henry', alternateName: 'henry1', url: 'https://www.pinterest.com/henry1' },
  headline: 'a title',
  articleBody: 'see https://example.com/recipe for more',
  image: 'https://i.pinimg.com/originals/a0/a4/a.jpg',
  datePublished: '2022-08-04T13:34:00.000Z',
  sharedContent: { '@type': 'WebPage', url: 'https://www.pinterest.com/pin/663/' },
  interactionStatistic: [
    {
      interactionType: { '@type': 'https://schema.org/LikeAction' },
      userInteractionCount: 2105,
    },
  ],
});

const videoPin =
  ld({
    '@type': 'SocialMediaPosting',
    author: { name: 'Vid', alternateName: 'vid', url: 'https://www.pinterest.com/vid' },
    headline: 'clip',
    datePublished: '2022-08-04T13:34:00.000Z',
  }) +
  ld({
    '@type': 'VideoObject',
    name: 'clip',
    contentUrl: 'https://v1.pinimg.com/videos/mc/720p/6e/b0.mp4',
    width: '720 px',
    height: '480 px',
    commentCount: 19,
    interactionStatistic: [
      { interactionType: { '@type': 'https://schema.org/WatchAction' }, userInteractionCount: 99 },
      { interactionType: { '@type': 'https://schema.org/LikeAction' }, userInteractionCount: 7 },
    ],
  });

const page = (html, url = 'https://www.pinterest.com/pin/663/') => ({
  fetchPage: async () => ({ html, url }),
});

describe('pinterest content links', () => {
  test('matches pin pages, regional hosts and pin.it', () => {
    for (const url of [
      'https://www.pinterest.com/pin/663225482638937262/',
      'https://it.pinterest.com/pin/1101411652644676940/',
      'https://pinterest.co.uk/pin/123/',
      'https://pin.it/3v9aYm5zT',
    ]) {
      expect(isPinterestContentUrl(url)).toBe(true);
    }
    expect(isPinterestContentUrl('https://www.pinterest.com/someone/board/')).toBe(false);
  });

  test('rejects other links with BAD_URL', async () => {
    const error = await fetchPinterestThread('https://example.com/pin/1', page('')).catch(e => e);
    expect(error.code).toBe('BAD_URL');
    expect(error.statusCode).toBe(400);
  });
});

describe('fetchPinterestThread', () => {
  test('image pin: title, text, author, original image, links, saves', async () => {
    const result = await fetchPinterestThread('https://www.pinterest.com/pin/663/', page(imagePin));
    const { post } = result;
    expect(result.source).toBe('pinterest');
    expect(result.thread).toEqual([]);
    expect(post.id).toBe('663');
    expect(post.title).toBe('a title');
    expect(post.text).toBe('see https://example.com/recipe for more');
    expect(post.author).toEqual({
      handle: 'henry1',
      name: 'Henry',
      url: 'https://www.pinterest.com/henry1',
    });
    expect(post.createdAt).toBe('2022-08-04T13:34:00.000Z');
    expect(post.media).toEqual([
      {
        type: 'image',
        url: 'https://i.pinimg.com/originals/a0/a4/a.jpg',
        alt: null,
        width: null,
        height: null,
      },
    ]);
    expect(post.links).toEqual(['https://example.com/recipe']);
    expect(post.stats.likes).toBe(2105);
  });

  test('video pin: mp4 with size, views and comment count', async () => {
    const { post } = await fetchPinterestThread(
      'https://www.pinterest.com/pin/663/',
      page(videoPin)
    );
    expect(post.media[0]).toEqual({
      type: 'video',
      url: 'https://v1.pinimg.com/videos/mc/720p/6e/b0.mp4',
      alt: null,
      width: 720,
      height: 480,
    });
    expect(post.stats.views).toBe(99);
    expect(post.stats.replies).toBe(19);
    expect(post.author.handle).toBe('vid');
  });

  test('pin.it links report the resolved pin url', async () => {
    const result = await fetchPinterestThread(
      'https://pin.it/abc',
      page(
        ld({ '@type': 'SocialMediaPosting', image: 'https://i.pinimg.com/originals/a.jpg' }),
        'https://www.pinterest.com/pin/77/'
      )
    );
    expect(result.url).toBe('https://www.pinterest.com/pin/77/');
    expect(result.post.id).toBe('77');
  });

  test('dead pins are CONTENT_GONE', async () => {
    const gone = [
      page('<html>nothing</html>'),
      page('', 'https://www.pinterest.com/?show_error=true'),
      {
        fetchPage: async () => {
          throw Object.assign(new Error('nope'), { response: { status: 404 } });
        },
      },
    ];
    for (const source of gone) {
      const error = await fetchPinterestThread('https://pin.it/abc', source).catch(e => e);
      expect(error.code).toBe('CONTENT_GONE');
    }
  });
});
