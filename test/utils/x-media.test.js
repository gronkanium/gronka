import { test, expect } from 'bun:test';
import { downloadFromX } from '../../src/utils/x-media.js';

// A post with no media whose only link is elsewhere, the way 2009 tweets carried twitpic photos.
const gql = async () => ({
  data: {
    tweetResult: {
      result: {
        __typename: 'Tweet',
        rest_id: '1121915133',
        core: {
          user_results: { result: { core: { screen_name: 'jkrums', name: 'J' }, legacy: {} } },
        },
        legacy: {
          id_str: '1121915133',
          full_text: 'http://t.co/plane - There is a plane in the Hudson.',
          created_at: 'Thu Jan 15 20:36:00 +0000 2009',
          entities: {
            urls: [{ url: 'http://t.co/plane', expanded_url: 'http://twitpic.com/135xa' }],
            media: [],
          },
        },
      },
    },
  },
});

test('a post with no media says so and names where its link goes', async () => {
  await expect(
    downloadFromX('https://x.com/jkrums/status/1121915133', { gql })
  ).rejects.toMatchObject({
    code: 'NO_VIDEO',
    statusCode: 422,
    message: 'this post has no photo or video, only a link to twitpic.com.',
  });
});

test('a pre-t.co post with its link only in the text names it too', async () => {
  const plain = async () => {
    const out = await gql();
    out.data.tweetResult.result.legacy.full_text = 'http://twitpic.com/135xa - plane';
    out.data.tweetResult.result.legacy.entities.urls = [];
    return out;
  };
  await expect(
    downloadFromX('https://x.com/jkrums/status/1121915133', { gql: plain })
  ).rejects.toMatchObject({
    message: 'this post has no photo or video, only a link to twitpic.com.',
  });
});

test('a post with no media but a large link card hands back the card image', async () => {
  const carded = async () => {
    const out = await gql();
    out.data.tweetResult.result.card = {
      legacy: {
        binding_values: [
          {
            key: 'photo_image_full_size_original',
            value: { image_value: { url: 'http://127.0.0.1:1/card_img/1/a?format=jpg&name=orig' } },
          },
        ],
      },
    };
    return out;
  };
  // The card url is unreachable here, so reaching the download (not the no-media error) is the proof.
  await expect(
    downloadFromX('https://x.com/jkrums/status/1121915133', { gql: carded })
  ).rejects.not.toMatchObject({ code: 'NO_VIDEO' });
});
