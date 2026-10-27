import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  medalClipId,
  isMedalUrl,
  pickMedalVideo,
  downloadFromMedal,
} from '../../src/utils/medal.js';

const cdn = 'https://cdn.medal.tv/mediac/abc.mp4?auth=x';

describe('medal', () => {
  test('reads the clip id from every share shape', () => {
    for (const url of [
      'https://medal.tv/games/roblox-studio/clips/nJTQxdciaB7h8wwtq?invite=cr-1',
      'https://medal.tv/games/valorant/clips/nJTQxdciaB7h8wwtq/some-title',
      'https://medal.tv/clips/nJTQxdciaB7h8wwtq',
      'https://www.medal.tv/games/x/clip/nJTQxdciaB7h8wwtq',
      'https://medal.tv/?contentId=nJTQxdciaB7h8wwtq',
    ]) {
      assert.equal(medalClipId(url), 'nJTQxdciaB7h8wwtq', url);
    }
    assert.equal(isMedalUrl('https://medal.tv/games/valorant'), false);
    assert.equal(isMedalUrl('https://medal.tv.evil.example/clips/abc'), false);
  });

  test('takes only a cdn.medal.tv video url', () => {
    assert.equal(pickMedalVideo({ contentUrl: cdn }), cdn);
    assert.equal(pickMedalVideo({ contentUrl: '', socialMediaVideo: cdn }), cdn);
    assert.equal(pickMedalVideo({ contentUrl: 'https://evil.example/a.mp4' }), null);
    assert.equal(pickMedalVideo({ contentUrl: 'http://cdn.medal.tv/a.mp4' }), null);
  });

  test('a 403 that outlasts every retry means the clip is still being published', async () => {
    const originalGet = axios.get;
    let calls = 0;
    axios.get = async () => {
      calls++;
      throw Object.assign(new Error('forbidden'), { response: { status: 403 } });
    };
    try {
      await assert.rejects(
        () => downloadFromMedal('https://medal.tv/clips/abc', Infinity, [0, 0]),
        error => error.code === 'CLIP_NOT_PUBLISHED'
      );
      assert.equal(calls, 3);
    } finally {
      axios.get = originalGet;
    }
  });

  test('waits for a clip that publishes a moment after the link is shared', async () => {
    const originalGet = axios.get;
    const responses = [
      () => {
        throw Object.assign(new Error('forbidden'), { response: { status: 403 } });
      },
      () => ({ data: { processed: 0, publishedAt: null } }),
      () => ({ data: { contentUrl: cdn, publishedAt: 1, processed: 1, videoLengthSeconds: 4000 } }),
    ];
    axios.get = async () => responses.shift()();
    try {
      await assert.rejects(
        () => downloadFromMedal('https://medal.tv/clips/abc', 3600, [0, 0]),
        error => error.code === 'VALIDATION_ERROR'
      );
      assert.equal(responses.length, 0);
    } finally {
      axios.get = originalGet;
    }
  });

  test('a clip over the length cap is refused before downloading', async () => {
    const originalGet = axios.get;
    axios.get = async () => ({
      data: { contentUrl: cdn, publishedAt: 1, processed: 1, videoLengthSeconds: 4000 },
    });
    try {
      await assert.rejects(
        () => downloadFromMedal('https://medal.tv/clips/abc', 3600),
        error => error.code === 'VALIDATION_ERROR'
      );
    } finally {
      axios.get = originalGet;
    }
  });
});
