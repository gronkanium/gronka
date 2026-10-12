import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  isJumpshareUrl,
  extractJumpshareUrl,
  resolveJumpshareUrl,
} from '../../src/utils/jumpshare.js';
import { AppError, rootCause } from '../../src/utils/errors.js';

const id = 'file123AbC';
const share = `https://jumpshare.com/s/${id}`;
const anchor = target =>
  `<a data-link='${target}' data-id='${id}' class='button download'>Download</a>`;

describe('Jumpshare file links', () => {
  test('accepts file shares and rejects other pages, protocols and lookalike hosts', () => {
    for (const url of [share, `https://www.jumpshare.com/share/${id}/?x=1`]) {
      assert.equal(isJumpshareUrl(url), true);
    }
    for (const url of [
      'https://jumpshare.com/',
      `https://jumpshare.com/s/${id}/extra`,
      `https://jumpshare.com.evil.example/s/${id}`,
      `ftp://jumpshare.com/s/${id}`,
      'invalid',
    ]) {
      assert.equal(isJumpshareUrl(url), false);
    }
  });

  test('selects the requested original file and decodes its signed URL', () => {
    const target = 'https://cdn.jumpshare.com/download/original?token=1&key=2';
    const html = `<video src="https://cdn.jumpshare.com/preview/low.mp4"></video>
      <a class="download" data-id="other" data-link="https://cdn.jumpshare.com/download/wrong">Download</a>
      ${anchor(target.replace('&', '&amp;'))}`;
    assert.equal(extractJumpshareUrl(html, id), target);
  });

  test('refuses forged download destinations and never picks previews', () => {
    for (const target of [
      'http://cdn.jumpshare.com/download/file',
      'https://cdn.jumpshare.com.evil.example/download/file',
      'https://127.0.0.1/download/file',
      'https://cdn.jumpshare.com:8888/download/file',
      'https://user:password@cdn.jumpshare.com/download/file',
      'https://cdn.jumpshare.com/preview/file.mp4',
      'javascript:alert(1)',
    ]) {
      assert.equal(extractJumpshareUrl(anchor(target), id), null);
    }
    assert.equal(
      extractJumpshareUrl('<video src="https://cdn.jumpshare.com/preview/file.mp4">', id),
      null
    );
  });

  test('missing files and upstream errors remain curated with their actual cause', async () => {
    const originalGet = axios.get;
    const gone = Object.assign(new Error('upstream 404'), { response: { status: 404 } });
    const unavailable = new Error('socket reset');
    try {
      for (const cause of [gone, unavailable]) {
        axios.get = async () => {
          throw cause;
        };
        await assert.rejects(
          () => resolveJumpshareUrl(share),
          error => {
            assert.ok(error instanceof AppError);
            assert.equal(rootCause(error), cause);
            if (cause === gone) assert.equal(error.code, 'CONTENT_GONE');
            return true;
          }
        );
      }
      axios.get = async () => ({ data: '<html>password protected</html>' });
      await assert.rejects(
        () => resolveJumpshareUrl(share),
        error => {
          assert.ok(error instanceof AppError);
          assert.match(rootCause(error).message, /no original download URL/);
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
    }
  });

  test('retries a transient page failure without retrying access denials', async () => {
    const originalGet = axios.get;
    const target = 'https://cdn.jumpshare.com/download/original';
    try {
      let calls = 0;
      axios.get = async () => {
        if (++calls === 1)
          throw Object.assign(new Error('upstream unavailable'), { response: { status: 503 } });
        return { data: anchor(target) };
      };
      assert.equal(await resolveJumpshareUrl(share), target);
      assert.equal(calls, 2);
      calls = 0;
      const forbidden = Object.assign(new Error('upstream denied'), { response: { status: 403 } });
      axios.get = async () => {
        calls++;
        throw forbidden;
      };
      await assert.rejects(
        () => resolveJumpshareUrl(share),
        error => rootCause(error) === forbidden
      );
      assert.equal(calls, 1);
    } finally {
      axios.get = originalGet;
    }
  });
});
