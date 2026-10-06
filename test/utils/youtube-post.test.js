import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { youtubePostId, extractYoutubePost } from '../../src/utils/youtube-post.js';

const ID = 'Ugkxjp06ZZMf5PHDNGiDRbPUAqOTUTbx77ch';
const image = name => ({
  backstageImageRenderer: {
    image: {
      thumbnails: [
        { url: `https://yt3.ggpht.com/${name}=s288-c-fcrop64=1,0-nd-v1` },
        { url: `https://yt3.ggpht.com/${name}=s1080-c-fcrop64=1,0-nd-v1` },
      ],
    },
  },
});
const page = posts =>
  `<script>var ytInitialData = ${JSON.stringify({
    contents: posts.map(post => ({
      backstagePostThreadRenderer: { post: { backstagePostRenderer: post } },
    })),
  })};</script>`;

describe('youtube posts', () => {
  test('recognises post links in every shape, nothing else', () => {
    assert.strictEqual(youtubePostId(`http://youtube.com/post/${ID}?surface=shorts`), ID);
    assert.strictEqual(youtubePostId(`https://m.youtube.com/post/${ID}`), ID);
    assert.strictEqual(youtubePostId(`https://www.youtube.com/@mkbhd/community?lb=${ID}`), ID);
    assert.strictEqual(youtubePostId(`https://www.youtube.com/channel/UCx/posts?lb=${ID}`), ID);
    assert.strictEqual(youtubePostId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
    assert.strictEqual(youtubePostId(`https://example.com/post/${ID}`), null);
  });

  test('takes the original of every image of the linked post', () => {
    const html = page([
      { postId: 'UgkxOtherPost123', backstageAttachment: image('other') },
      {
        postId: ID,
        backstageAttachment: { postMultiImageRenderer: { images: [image('a'), image('b')] } },
      },
    ]);
    assert.deepStrictEqual(extractYoutubePost(html, ID), {
      images: ['https://yt3.ggpht.com/a=s0', 'https://yt3.ggpht.com/b=s0'],
      videoId: null,
    });
  });

  test('a single image, a linked video, a poll', () => {
    assert.deepStrictEqual(
      extractYoutubePost(page([{ postId: ID, backstageAttachment: image('x') }]), ID).images,
      ['https://yt3.ggpht.com/x=s0']
    );
    const video = page([
      { postId: ID, backstageAttachment: { videoRenderer: { videoId: 'as_kxJn4Xwc' } } },
    ]);
    assert.strictEqual(extractYoutubePost(video, ID).videoId, 'as_kxJn4Xwc');
    const poll = extractYoutubePost(
      page([{ postId: ID, backstageAttachment: { pollRenderer: {} } }]),
      ID
    );
    assert.deepStrictEqual(poll, { images: [], videoId: null });
  });

  test('null when the page does not carry the post', () => {
    assert.strictEqual(extractYoutubePost(page([{ postId: 'UgkxOtherPost123' }]), ID), null);
    assert.strictEqual(extractYoutubePost('<html></html>', ID), null);
  });
});
