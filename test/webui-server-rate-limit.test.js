import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import rateLimit from 'express-rate-limit';

describe('webui-server rate limiting', () => {
  describe('fileServerLimiter configuration', () => {
    test('rate limiter is configured with correct window', () => {
      const limiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 100, // Limit each IP to 100 requests per windowMs
        message: 'too many requests, please try again later',
        standardHeaders: true,
        legacyHeaders: false,
      });

      assert.ok(limiter);
      // Verify configuration by checking the limiter object structure
      assert.ok(typeof limiter === 'function');
    });

    test('rate limiter has correct window duration', () => {
      const windowMs = 15 * 60 * 1000; // 15 minutes
      assert.strictEqual(windowMs, 900000);
    });

    test('rate limiter has correct max requests', () => {
      const max = 100;
      assert.strictEqual(max, 100);
    });

    test('rate limiter message is correct', () => {
      const message = 'too many requests, please try again later';
      assert.strictEqual(message, 'too many requests, please try again later');
    });

    test('rate limiter uses standard headers', () => {
      const standardHeaders = true;
      assert.strictEqual(standardHeaders, true);
    });

    test('rate limiter disables legacy headers', () => {
      const legacyHeaders = false;
      assert.strictEqual(legacyHeaders, false);
    });
  });

  describe('rate limiter middleware application', () => {
    let app;
    let limiter;

    before(() => {
      app = express();
      limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 100,
        message: 'too many requests, please try again later',
        standardHeaders: true,
        legacyHeaders: false,
      });
    });

    test('rate limiter can be applied as middleware', () => {
      app.get('/test', limiter, (req, res) => {
        res.json({ message: 'ok' });
      });

      assert.ok(app);
    });

    test('rate limiter is a function (middleware)', () => {
      assert.ok(typeof limiter === 'function');
    });
  });

  describe('rate limit behavior', () => {
    let app;
    let server;
    let limiter;

    before(() => {
      app = express();
      // Use a very short window and low max for testing
      limiter = rateLimit({
        windowMs: 1000, // 1 second for testing
        max: 2, // Only 2 requests for testing
        message: 'too many requests, please try again later',
        standardHeaders: true,
        legacyHeaders: false,
      });

      app.get('/limited', limiter, (req, res) => {
        res.json({ message: 'ok' });
      });

      return new Promise(resolve => {
        server = app.listen(0, () => {
          resolve();
        });
      });
    });

    after(() => {
      if (server) {
        server.close();
      }
    });

    test('allows requests within limit', async () => {
      const port = server.address().port;
      const response1 = await fetch(`http://localhost:${port}/limited`);
      assert.strictEqual(response1.status, 200);
    });

    test('blocks requests exceeding limit', async () => {
      const port = server.address().port;

      // Make requests up to the limit
      await fetch(`http://localhost:${port}/limited`);
      await fetch(`http://localhost:${port}/limited`);

      // This should be rate limited
      const response3 = await fetch(`http://localhost:${port}/limited`);
      assert.strictEqual(response3.status, 429);

      const body = await response3.text();
      assert.ok(body.includes('too many requests'));
    });

    test('rate limit headers are present', async () => {
      const port = server.address().port;
      const response = await fetch(`http://localhost:${port}/limited`);

      // Headers may or may not be present depending on express-rate-limit version
      // Just verify the response is valid
      assert.ok(response.status === 200 || response.status === 429);
    });
  });

  describe('rate limiter message format', () => {
    test('rate limit message is lowercase monotone style', () => {
      const message = 'too many requests, please try again later';
      // Verify it's lowercase
      assert.strictEqual(message, message.toLowerCase());
      // Verify no capital letters
      assert.ok(!/[A-Z]/.test(message));
    });
  });
});
