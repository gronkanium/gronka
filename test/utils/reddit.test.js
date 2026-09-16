import { describe, test } from 'bun:test';
import assert from 'node:assert';
import { isRedditPostUrl, commentIdFromUrl, selectRedditMedia } from '../../src/utils/reddit.js';

// Shapes taken from real .json?raw_json=1 responses.
const image = (id, mime = 'image/jpg') => ({
  status: 'valid',
  e: 'Image',
  m: mime,
  s: { u: `https://preview.redd.it/${id}.jpg?width=2429&format=pjpg&s=826b3b` },
});

const animated = id => ({
  status: 'valid',
  e: 'AnimatedImage',
  m: 'image/gif',
  s: {
    gif: `https://i.redd.it/${id}.gif`,
    mp4: `https://preview.redd.it/${id}.gif?format=mp4&s=f49d2f`,
  },
});

const listing = (post, comments = []) => [
  { data: { children: [{ kind: 't3', data: post }] } },
  { data: { children: comments.map(data => ({ kind: 't1', data })) } },
];

const POST_URL = 'https://www.reddit.com/r/pics/comments/1wgx7l1/dog_photo_shoot/';
const COMMENT_URL = `${POST_URL}pa1l75m/`;

describe('reddit utilities', () => {
  test('isRedditPostUrl accepts canonical and share permalinks', () => {
    assert.strictEqual(
      isRedditPostUrl('https://www.reddit.com/r/Cutemaxxing/comments/1wf293y/honest_rate/'),
      true
    );
    // the share sheet emits /s/<id>, which is what most users actually paste
    assert.strictEqual(isRedditPostUrl('https://reddit.com/r/AltFashion/s/9EjV8nKm1j'), true);
    assert.strictEqual(isRedditPostUrl('https://old.reddit.com/r/aww/comments/abc123/x/'), true);
  });

  test('isRedditPostUrl rejects subreddits, users, and lookalike hosts', () => {
    assert.strictEqual(isRedditPostUrl('https://www.reddit.com/r/aww/'), false);
    assert.strictEqual(isRedditPostUrl('https://www.reddit.com/user/someone'), false);
    assert.strictEqual(isRedditPostUrl('https://reddit.com.evil.com/r/a/comments/b/c/'), false);
    assert.strictEqual(isRedditPostUrl('not a url'), false);
  });

  test('commentIdFromUrl tells a comment permalink from a post link', () => {
    assert.strictEqual(commentIdFromUrl(COMMENT_URL), 'pa1l75m');
    // the shape reddit's own share button emits
    assert.strictEqual(
      commentIdFromUrl('https://www.reddit.com/r/pics/comments/1wgx7l1/comment/pa1l75m/'),
      'pa1l75m'
    );
    assert.strictEqual(commentIdFromUrl(POST_URL), null);
    assert.strictEqual(commentIdFromUrl('https://www.reddit.com/r/pics/comments/1wgx7l1/'), null);
  });

  test('a gallery yields one entry per slide, in the order the post declares', () => {
    const { images } = selectRedditMedia(
      listing({
        is_gallery: true,
        gallery_data: { items: [{ media_id: 'aaa' }, { media_id: 'bbb' }] },
        media_metadata: { bbb: image('bbb'), aaa: image('aaa') },
      }),
      POST_URL
    );
    assert.strictEqual(images.length, 2);
    // media_metadata is unordered, gallery_data is not
    assert.strictEqual(images[0][0], 'https://i.redd.it/aaa.jpg');
    assert.strictEqual(images[1][0], 'https://i.redd.it/bbb.jpg');
    assert.ok(images[0][1].includes('preview.redd.it'), 'signed preview kept as fallback');
  });

  test('a post link never picks up media from the comment tree', () => {
    const { images, external } = selectRedditMedia(
      listing({ url: 'https://i.redd.it/post.jpeg' }, [
        { id: 'c1', media_metadata: { drawing: image('drawing') } },
        { id: 'c2', media_metadata: { another: image('another') } },
      ]),
      POST_URL
    );
    assert.strictEqual(external, null);
    assert.deepStrictEqual(images, [['https://i.redd.it/post.jpeg']]);
  });

  test('a comment link resolves to that comment and nothing else', () => {
    const { images } = selectRedditMedia(
      listing({ url: 'https://i.redd.it/post.jpeg' }, [
        { id: 'pa1l75m', media_metadata: { drawing: image('drawing', 'image/png') } },
      ]),
      COMMENT_URL
    );
    assert.deepStrictEqual(images, [
      [
        'https://i.redd.it/drawing.png',
        'https://preview.redd.it/drawing.jpg?width=2429&format=pjpg&s=826b3b',
      ],
    ]);
  });

  test('a comment with no media falls back to the post', () => {
    const { images } = selectRedditMedia(
      listing({ url: 'https://i.redd.it/post.jpeg' }, [{ id: 'pa1l75m', body: 'nice dog' }]),
      COMMENT_URL
    );
    assert.deepStrictEqual(images, [['https://i.redd.it/post.jpeg']]);
  });

  test('a native comment gif prefers the unsigned gif over the preview mp4', () => {
    const { images } = selectRedditMedia(
      listing({ url: 'https://i.redd.it/post.jpeg' }, [
        { id: 'pa1l75m', media_metadata: { '85xj2izy2jph1': animated('85xj2izy2jph1') } },
      ]),
      COMMENT_URL
    );
    assert.strictEqual(images[0][0], 'https://i.redd.it/85xj2izy2jph1.gif');
    assert.ok(images[0][1].includes('format=mp4'));
  });

  test('a giphy comment gif rebuilds from the key reddit marks invalid', () => {
    // reddit hands back no url at all for these, only the key
    const { images } = selectRedditMedia(
      listing({ url: 'https://i.redd.it/post.jpeg' }, [
        { id: 'pa1l75m', media_metadata: { 'giphy|WO5Q7FsxJN2pjYc424': { status: 'invalid' } } },
      ]),
      COMMENT_URL
    );
    assert.deepStrictEqual(images, [['https://i.giphy.com/media/WO5Q7FsxJN2pjYc424/giphy.gif']]);
  });

  test('emotes and expired slides are skipped rather than guessed at', () => {
    const { images } = selectRedditMedia(
      listing({
        is_gallery: true,
        gallery_data: { items: [{ media_id: 'gone' }, { media_id: 'ok' }] },
        media_metadata: { gone: { status: 'failed' }, ok: image('ok') },
      }),
      POST_URL
    );
    assert.deepStrictEqual(images, [
      [
        'https://i.redd.it/ok.jpg',
        'https://preview.redd.it/ok.jpg?width=2429&format=pjpg&s=826b3b',
      ],
    ]);
  });

  test('a video post hands back the manifest for yt-dlp to mux', () => {
    const { external, images } = selectRedditMedia(
      listing({
        is_video: true,
        media: {
          reddit_video: {
            hls_url: 'https://v.redd.it/438iwqxidiph1/HLSPlaylist.m3u8?a=1792&v=1&f=sd',
            fallback_url: 'https://v.redd.it/438iwqxidiph1/CMAF_720.mp4?source=fallback',
          },
        },
      }),
      POST_URL
    );
    assert.ok(
      external.includes('HLSPlaylist.m3u8'),
      'hls carries the audio track, fallback does not'
    );
    assert.deepStrictEqual(images, []);
  });

  test('a link-aggregator post hands the offsite target back for routing', () => {
    const { external } = selectRedditMedia(
      listing({ url: 'https://redgifs.com/watch/digitalmysteriousanglerfish' }),
      POST_URL
    );
    assert.strictEqual(external, 'https://redgifs.com/watch/digitalmysteriousanglerfish');
  });

  test('offsite hosts the pipeline cannot route are left to cobalt', () => {
    const { external, images } = selectRedditMedia(
      listing({ url: 'https://example.com/thing' }),
      POST_URL
    );
    assert.strictEqual(external, null);
    assert.deepStrictEqual(images, []);
  });

  test('a crosspost reads the media off the post it quotes', () => {
    const { images } = selectRedditMedia(
      listing({
        url: 'https://www.reddit.com/r/pics/comments/1wgx7l1/dog_photo_shoot/',
        crosspost_parent_list: [{ url: 'https://i.redd.it/original.png' }],
      }),
      POST_URL
    );
    assert.deepStrictEqual(images, [['https://i.redd.it/original.png']]);
  });

  test('a removed post says so instead of falling through to a silent failure', () => {
    assert.throws(
      () =>
        selectRedditMedia(
          listing({ removed_by_category: 'deleted', author: '[deleted]', is_gallery: true }),
          POST_URL
        ),
      /removed/
    );
  });

  test('a removed post is marked gone so download.js does not fall back', () => {
    try {
      selectRedditMedia(listing({ removed_by_category: 'deleted', is_gallery: true }), POST_URL);
      assert.fail('expected a throw');
    } catch (error) {
      assert.strictEqual(error.code, 'CONTENT_GONE');
    }
  });

  test('a text post extracts nothing rather than guessing', () => {
    const { external, images } = selectRedditMedia(
      listing({ selftext: 'just words', url: POST_URL }),
      POST_URL
    );
    assert.strictEqual(external, null);
    assert.deepStrictEqual(images, []);
  });
});
