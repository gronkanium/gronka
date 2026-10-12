import { test, describe, beforeAll, afterAll, mock } from 'bun:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mediaFromBytes } from '../helpers/media.js';
import { withJobDir } from '../../src/utils/media-file.js';

if (process.env.GRONKA_E2E !== 'true') {
  test('R2 transport tests run in the isolated e2e suite', () => {});
} else {
  let server;
  let uploadToR2;
  let stalled = false;
  let denied = false;
  const parts = [];
  const config = {
    accountId: 'test',
    accessKeyId: 'test',
    secretAccessKey: 'test',
    bucketName: 'test',
    publicDomain: 'cdn.test',
  };

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const url = new URL(request.url, 'http://localhost');
      request.resume();
      await once(request, 'end');
      if (denied) {
        response.writeHead(403, { 'content-type': 'application/xml' });
        response.end('<Error><Code>AccessDenied</Code><Message>upload denied</Message></Error>');
      } else if (request.method === 'POST' && url.searchParams.has('uploads')) {
        response.end(
          '<InitiateMultipartUploadResult><UploadId>test</UploadId></InitiateMultipartUploadResult>'
        );
      } else if (request.method === 'PUT') {
        const part = url.searchParams.get('partNumber');
        parts.push(part);
        if (part === '1' && !stalled) {
          stalled = true;
          return;
        }
        response.writeHead(200, { etag: '"test"' });
        response.end();
      } else if (request.method === 'POST') {
        response.end(
          '<CompleteMultipartUploadResult><ETag>"test"</ETag></CompleteMultipartUploadResult>'
        );
      } else {
        response.writeHead(204);
        response.end();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const real = await import('@aws-sdk/client-s3');
    const RealS3Client = real.S3Client;
    mock.module('@aws-sdk/client-s3', () => ({
      ...real,
      S3Client: class extends RealS3Client {
        constructor(options) {
          super({
            ...options,
            endpoint: `http://127.0.0.1:${server.address().port}`,
            forcePathStyle: true,
            requestHandler: {
              ...options.requestHandler,
              requestTimeout: options.requestHandler?.requestTimeout ? 30 : 0,
            },
          });
        }
      },
    }));
    ({ uploadToR2 } = await import('../../src/utils/r2-storage.js'));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    mock.restore();
  });

  describe('R2 upload recovery', () => {
    test('retries a stalled multipart request and finishes before the job expires', async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('upload never recovered')), 2000);
      try {
        await withJobDir(
          async () => {
            const file = await mediaFromBytes(Buffer.alloc(6 * 1024 * 1024, 1));
            assert.equal(
              await uploadToR2(file, 'video.mp4', 'video/mp4', config),
              'https://cdn.test/video.mp4'
            );
            assert.equal(parts.filter(part => part === '1').length, 2);
            assert.equal(parts.filter(part => part === '2').length, 1);
          },
          { signal: controller.signal }
        );
      } finally {
        clearTimeout(timer);
      }
    });

    test('a permanent upload failure keeps its cause behind a curated message', async () => {
      denied = true;
      try {
        await withJobDir(async () => {
          const file = await mediaFromBytes(Buffer.alloc(1024, 1));
          await assert.rejects(
            uploadToR2(file, 'denied.mp4', 'video/mp4', config),
            error =>
              error.name === 'NetworkError' &&
              error.message === 'could not upload this file right now, try again shortly.' &&
              error.cause?.$metadata?.httpStatusCode === 403
          );
        });
      } finally {
        denied = false;
      }
    });
  });
}
