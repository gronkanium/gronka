import { describe, test, afterEach, spyOn } from 'bun:test';
import assert from 'node:assert';
import net from 'net';
import axios from 'axios';
import { exitRelay, relayForwarder } from '../../src/utils/geo-exit.js';
import { classifyYtdlpFailure, googleNode } from '../../src/utils/ytdlp.js';

const RELAYS = [
  { country_code: 'id', country_name: 'Indonesia', active: true, socks_name: 'id-1-socks' },
  { country_code: 'cz', country_name: 'Czech Republic', active: true, socks_name: 'cz-1-socks' },
  { country_code: 'my', country_name: 'Malaysia', active: false, socks_name: 'my-1-socks' },
  { country_code: 'jp', country_name: 'Japan', active: true, socks_name: null },
];

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

describe('geo exit', () => {
  let spy;
  afterEach(() => spy?.mockRestore());

  test("yt-dlp's country list is read off a region block", () => {
    const error = classifyYtdlpFailure(
      'ERROR: [youtube] x: The uploader has not made this video available in your country This video is available in Indonesia, Czechia.',
      'https://youtu.be/x'
    );
    assert.strictEqual(error.code, 'GEO_BLOCKED');
    assert.deepStrictEqual(error.countries, ['Indonesia', 'Czechia']);
  });

  test('a relay is picked only in a country the video allows, by either spelling', async () => {
    spy = spyOn(axios, 'get').mockResolvedValue({ data: RELAYS });
    assert.strictEqual((await exitRelay(['Indonesia'])).host, 'id-1-socks');
    assert.strictEqual((await exitRelay(['Czechia'])).host, 'cz-1-socks');
    assert.strictEqual(await exitRelay(['Malaysia']), null);
    assert.strictEqual(await exitRelay(['Japan']), null);
  });

  test('the forwarder tunnels through the http proxy to the relay', async () => {
    let connectLine = '';
    const proxy = net.createServer(socket =>
      socket.once('data', head => {
        connectLine = head.toString().split('\r\n')[0];
        socket.write('HTTP/1.1 200 OK\r\n\r\nhello ');
        socket.on('data', chunk => socket.write(chunk));
      })
    );
    await listen(proxy);
    const exit = await relayForwarder(
      { host: 'id-1-socks', port: 1080 },
      `http://127.0.0.1:${proxy.address().port}`
    );
    try {
      const reply = await new Promise((resolve, reject) => {
        const client = net.connect(Number(exit.url.split(':').pop()), '127.0.0.1');
        let got = '';
        client.write('world');
        client.on('data', chunk => {
          got += chunk;
          if (got === 'hello world') client.end(() => resolve(got));
        });
        client.on('error', reject);
      });
      assert.strictEqual(connectLine, 'CONNECT id-1-socks:1080 HTTP/1.1');
      assert.strictEqual(reply, 'hello world');
      assert.ok(exit.url.startsWith('socks5h://127.0.0.1:'));
    } finally {
      exit.close();
      proxy.close();
    }
  });

  test("a media URL moves off the ISP cache to Google's own node", () => {
    const media =
      'https://rr2---sn-poqvn5u-jb36.googlevideo.com/videoplayback?itag=140&mn=sn-poqvn5u-jb36%2Csn-2o30a5-53';
    assert.strictEqual(new URL(googleNode(media)).hostname, 'rr2---sn-2o30a5-53.googlevideo.com');
    const single = 'https://rr2---sn-a.googlevideo.com/videoplayback?mn=sn-a';
    assert.strictEqual(googleNode(single), single);
    assert.strictEqual(googleNode('https://example.com/x?mn=a,b'), 'https://example.com/x?mn=a,b');
  });
});
