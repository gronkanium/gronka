import { describe, test, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { Readable } from 'node:stream';
import { fakePage } from '../helpers/fake-page.js';
import { fetchPage, MAX_PAGE_BYTES } from '../../src/utils/ssrf-guard.js';
import { downloadFromRule34 } from '../../src/utils/rule34.js';
import { withJobDir } from '../../src/utils/media-file.js';
import { AppError, rootCause, describeCause } from '../../src/utils/errors.js';

const post = 'https://rule34.xxx/index.php?page=post&s=view&id=123';
const media = 'https://wimg.rule34.xxx/images/42/original.png?123';
const html = `<a href="${media}">Original image</a>`;
let upstream;
let originalGet;

beforeEach(async () => {
  originalGet = axios.get;
  upstream = await fakePage();
});

afterEach(async () => {
  axios.get = originalGet;
  await upstream.close();
});

describe('impersonated page fetch', () => {
  test('pins the guarded address, disables proxies and caps the real Python response', async () => {
    await upstream.respond({ data: html });
    assert.equal((await fetchPage(post, { impersonate: true })).data, html);
    const [call] = await upstream.calls();
    assert.equal(call.session.trust_env, false);
    assert.equal(call.session.curl_options.resolve[0], 'rule34.xxx:443:93.184.216.34');
    assert.equal(call.session.curl_options.proxy, '');
    assert.equal(call.impersonate, 'chrome');
    assert.equal(call.allow_redirects, false);
    assert.equal(call.timeout, 20);
    await upstream.respond({ data: 'x'.repeat(MAX_PAGE_BYTES + 1) });
    await assert.rejects(
      () => fetchPage(post, { impersonate: true, failMessage: 'could not read the post.' }),
      error =>
        error.message === 'could not read the post.' && /size limit/.test(error.cause.message)
    );
  });

  test('guards every redirect and refuses private names before fetching them', async () => {
    await upstream.respond(
      { status: 302, headers: { location: '/index.php?page=post&s=view&id=456' } },
      { data: 'ok' }
    );
    assert.equal((await fetchPage(post, { impersonate: true })).data, 'ok');
    assert.equal((await upstream.calls()).at(-1).url, post.replace('123', '456'));
    for (const target of [
      'http://127.0.0.1/admin',
      'http://localhost/admin',
      'https://private.example/admin',
    ]) {
      const before = (await upstream.calls()).length;
      await upstream.respond({ status: 302, headers: { location: target } });
      await assert.rejects(
        () => fetchPage(post, { impersonate: true }),
        error => rootCause(error).code === 'ESSRFBLOCKED'
      );
      assert.equal((await upstream.calls()).length, before + 1);
    }
  });

  test('does not forward headers to a different origin', async () => {
    await upstream.respond(
      { status: 302, headers: { location: 'https://www.rule34.xxx/index.php' } },
      { data: 'ok' }
    );
    await fetchPage(post, {
      impersonate: true,
      headers: { Cookie: 'session=test', Authorization: 'Bearer test' },
    });
    const calls = await upstream.calls();
    assert.equal(calls[0].headers.Cookie, 'session=test');
    assert.deepEqual(calls[1].headers, {});
  });

  test('limits redirect chains and preserves HTTP error endpoints', async () => {
    await upstream.respond(
      ...Array.from({ length: 6 }, () => ({ status: 302, headers: { location: post } }))
    );
    await assert.rejects(
      () => fetchPage(post, { impersonate: true }),
      error => /redirect limit/.test(error.cause.message)
    );
    assert.equal((await upstream.calls()).length, 6);
    await upstream.respond({ status: 503 });
    await assert.rejects(
      () => fetchPage(post, { impersonate: true, failMessage: 'unavailable' }),
      error =>
        error instanceof AppError &&
        describeCause(error.cause) === 'GET rule34.xxx/index.php HTTP 503'
    );
  });

  test('cancelling a job stops the page subprocess', async () => {
    await upstream.respond({ data: html, delay: 10 });
    const controller = new AbortController();
    await assert.rejects(
      () =>
        withJobDir(
          async () => {
            const timer = setTimeout(() => controller.abort(), 100);
            try {
              await fetchPage(post, { impersonate: true });
            } finally {
              clearTimeout(timer);
            }
          },
          { signal: controller.signal }
        ),
      error => rootCause(error).name === 'AbortError'
    );
  });
});

describe('Rule34 acquisition', () => {
  test('canonicalizes a post and downloads its original through the guarded media path', async () => {
    await upstream.respond({ data: html });
    const calls = [];
    const bytes = Buffer.from('\x89PNG\r\n\x1a\n' + 'x'.repeat(64), 'latin1');
    axios.get = async (url, options) => {
      calls.push({ url, options });
      return { data: Readable.from(bytes), headers: { 'content-type': 'image/png' }, status: 200 };
    };
    await withJobDir(async () => {
      const file = await downloadFromRule34(`${post}&tags=example+`);
      assert.equal(file.size, bytes.length);
      assert.equal(file.contentType, 'image/png');
    });
    assert.equal((await upstream.calls())[0].url, post);
    assert.equal(calls[0].url, media);
    assert.equal(calls[0].options.headers.Referer, 'https://rule34.xxx/');
    assert.equal(typeof calls[0].options.lookup, 'function');
    assert.equal(typeof calls[0].options.beforeRedirect, 'function');
  });

  test('retries transient page failures once and keeps the final upstream reason', async () => {
    for (const failure of [
      { status: 503 },
      { error: 'connection reset', code: 56 },
      { error: 'timed out', code: 'ETIMEDOUT' },
    ]) {
      const before = (await upstream.calls()).length;
      await upstream.respond(failure, { status: 404 });
      await assert.rejects(
        () => downloadFromRule34(post),
        error => error.code === 'CONTENT_GONE'
      );
      assert.equal((await upstream.calls()).length, before + 2);
    }
    await upstream.respond({ status: 503 }, { status: 503 });
    await assert.rejects(
      () => downloadFromRule34(post),
      error => describeCause(rootCause(error)).includes('HTTP 503')
    );
  });

  test('curates missing posts, denials, challenges and changed markup without retrying', async () => {
    for (const [answer, message, code] of [
      [{ status: 404 }, /deleted or private/, 'CONTENT_GONE'],
      [{ status: 410 }, /deleted or private/, 'CONTENT_GONE'],
      [{ status: 403 }, /blocking downloads/, 'NETWORK_ERROR'],
      [{ status: 429 }, /blocking downloads/, 'NETWORK_ERROR'],
      [{ data: '<title>Rule34.xxx CAPTCHA</title>' }, /blocking downloads/, 'NETWORK_ERROR'],
      [{ data: '<html>different layout</html>' }, /could not read/, 'NETWORK_ERROR'],
      [{ data: 'This post was deleted' }, /deleted or private/, 'CONTENT_GONE'],
    ]) {
      const before = (await upstream.calls()).length;
      await upstream.respond(answer);
      await assert.rejects(
        () => downloadFromRule34(post),
        error => {
          assert.ok(error instanceof AppError);
          assert.match(error.message, message);
          assert.equal(error.code, code);
          assert.ok(error.cause);
          return true;
        }
      );
      assert.equal((await upstream.calls()).length, before + 1);
    }
    await assert.rejects(() => downloadFromRule34('https://rule34.xxx/'), /invalid rule34/);
  });
});
