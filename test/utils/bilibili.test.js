import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { Readable } from 'stream';
import { withJobDir } from '../../src/utils/media-file.js';
import { getDirectMediaHeaders } from '../../src/utils/file-downloader.js';
import {
  bilibiliVideo,
  isBilibiliUrl,
  wbiKey,
  signWbi,
  pickBilibiliFile,
  downloadFromBilibili,
} from '../../src/utils/bilibili.js';

const NAV = {
  code: -101,
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
};

async function withApi(answers, run) {
  const originalGet = axios.get;
  const seen = [];
  axios.get = async url => {
    seen.push(url);
    const path = new URL(url).pathname;
    const entry = answers[path];
    const answer = typeof entry === 'function' ? entry(url) : { data: entry };
    if (answer instanceof Error) throw answer;
    if (answer.data instanceof Error) throw answer.data;
    return answer;
  };
  try {
    return await run(seen);
  } finally {
    axios.get = originalGet;
  }
}

describe('bilibili', () => {
  test('reads the video id and part from every link shape', () => {
    assert.deepEqual(bilibiliVideo('https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=x'), {
      id: { bvid: 'BV1xx411c7mD' },
      page: 1,
    });
    assert.deepEqual(bilibiliVideo('https://m.bilibili.com/video/av170001?p=3'), {
      id: { aid: '170001' },
      page: 3,
    });
    assert.equal(isBilibiliUrl('https://www.bilibili.com/bangumi/play/ep1'), false);
    assert.equal(isBilibiliUrl('https://bilibili.com.evil.example/video/BV1xx411c7mD'), false);
  });

  test('signs requests the way the web player does', () => {
    const key = wbiKey(NAV.data.wbi_img.img_url, NAV.data.wbi_img.sub_url);
    assert.equal(key, 'ea1db124af3c7062474693fa704f4ff8');
    assert.equal(
      signWbi({ foo: '114', bar: '514', zab: 1919810 }, key, 1702204169000),
      'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4'
    );
  });

  test('takes one file and its mirrors, only on a bilibili video host', () => {
    const main = 'https://upos-sz-mirrorcos.bilivideo.com/a.mp4?x=1';
    const backup = 'https://upos-sz-mirrorali.bilivideo.com/a.mp4?x=1';
    assert.deepEqual(
      pickBilibiliFile({
        durl: [{ url: main, backup_url: [backup, 'https://evil.example/a.mp4'], size: 10 }],
      }),
      { urls: [main, backup], size: 10 }
    );
    assert.equal(pickBilibiliFile({ durl: [{ url: main }, { url: main }] }), null);
    assert.equal(pickBilibiliFile({ durl: [{ url: 'https://evil.example/a.mp4' }] }), null);
  });

  test('its video hosts are fetched with a bilibili referer', () => {
    for (const url of [
      'https://upos-sz-mirrorcos.bilivideo.com/a.mp4',
      'https://upos-hz-mirrorakam.akamaized.net/a.mp4',
    ]) {
      assert.equal(getDirectMediaHeaders(url).Referer, 'https://www.bilibili.com/', url);
    }
    assert.deepEqual(getDirectMediaHeaders('https://someone.akamaized.net/a.mp4'), {});
  });

  test('a mirror that refuses the file is skipped for the next one', async () => {
    const main = 'https://upos-sz-mirrorcos.bilivideo.com/a.mp4';
    const backup = 'https://upos-sz-mirrorali.bilivideo.com/a.mp4';
    await withApi(
      {
        '/x/web-interface/nav': NAV,
        '/x/web-interface/wbi/view': { code: 0, data: { cid: 1, duration: 5 } },
        '/x/player/wbi/playurl': {
          code: 0,
          data: { durl: [{ url: main, backup_url: [backup], size: 4096 }] },
        },
        '/a.mp4': url =>
          url.startsWith(main)
            ? Object.assign(new Error('Request failed with status code 403'), {
                response: { status: 403 },
              })
            : {
                data: Readable.from([Buffer.alloc(4096, 1)]),
                headers: { 'content-type': 'video/mp4', 'content-length': '4096' },
              },
      },
      async () => {
        const file = await withJobDir(async () => {
          const result = await downloadFromBilibili('https://www.bilibili.com/video/BV1xx411c7mD');
          return { size: result.size, contentType: result.contentType };
        });
        assert.deepEqual(file, { size: 4096, contentType: 'video/mp4' });
      }
    );
  });

  test('a deleted video is reported as gone', async () => {
    await withApi(
      {
        '/x/web-interface/nav': NAV,
        '/x/web-interface/wbi/view': { code: -404, message: '啥都木有' },
      },
      async () => {
        const error = await downloadFromBilibili(
          'https://www.bilibili.com/video/BV1xx411c7mD'
        ).catch(e => e);
        assert.equal(error.code, 'CONTENT_GONE');
      }
    );
  });

  test('a part longer than the limit is refused before the play request', async () => {
    await withApi(
      {
        '/x/web-interface/nav': NAV,
        '/x/web-interface/wbi/view': {
          code: 0,
          data: {
            cid: 1,
            duration: 10,
            pages: [
              { cid: 1, duration: 10 },
              { cid: 2, duration: 9000 },
            ],
          },
        },
      },
      async seen => {
        const error = await downloadFromBilibili(
          'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
          {
            maxDuration: 3600,
          }
        ).catch(e => e);
        assert.equal(error.name, 'ValidationError');
        assert.ok(!seen.some(u => u.includes('playurl')));
      }
    );
  });

  test('a 412 block says bilibili is blocking, and keeps the cause', async () => {
    const blocked = Object.assign(new Error('Request failed with status code 412'), {
      response: { status: 412 },
    });
    await withApi({ '/x/web-interface/nav': blocked }, async () => {
      const error = await downloadFromBilibili('https://www.bilibili.com/video/BV1xx411c7mD').catch(
        e => e
      );
      assert.match(error.message, /blocking/);
      assert.equal(error.cause, blocked);
    });
  });
});
