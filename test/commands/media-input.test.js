import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { Readable } from 'node:stream';
import { fetchInput } from '../../src/commands/shared/media-input.js';
import { withJobDir } from '../../src/utils/media-file.js';

const serve = (body, contentType) => async () => ({
  data: Readable.from([Buffer.from(body)]),
  headers: { 'content-type': contentType },
});

describe('fetchInput', () => {
  test('a link to a web page is refused as not a media file', async () => {
    const originalGet = axios.get;
    axios.get = serve('<!doctype html><title>screenshots</title>', 'text/html; charset=UTF-8');
    try {
      await withJobDir(() =>
        assert.rejects(
          () => fetchInput({ url: 'https://example.com/id/someone/screenshots' }),
          error => error.message === 'that link does not point to a video, image or audio file.'
        )
      );
    } finally {
      axios.get = originalGet;
    }
  });

  test('an attachment and a direct file link come back in the same shape', async () => {
    const originalGet = axios.get;
    axios.get = serve('GIF89a' + 'x'.repeat(64), 'image/gif');
    try {
      await withJobDir(async () => {
        const attachment = {
          url: 'https://cdn.discordapp.com/attachments/1/2/a.gif',
          name: 'a.gif',
          size: 70,
          contentType: 'image/gif',
        };
        const fromAttachment = await fetchInput({ attachment });
        const fromLink = await fetchInput({ url: 'https://example.com/b.gif' });
        for (const input of [fromAttachment, fromLink]) {
          assert.ok(input.file.path);
          assert.equal(input.file.contentType, 'image/gif');
          assert.ok(input.attachment.url);
        }
        assert.equal(fromAttachment.originalUrl, null);
        assert.equal(fromLink.originalUrl, 'https://example.com/b.gif');
      });
    } finally {
      axios.get = originalGet;
    }
  });
});
