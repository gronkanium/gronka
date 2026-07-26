import { test, describe } from 'bun:test';
import assert from 'node:assert';
import http from 'node:http';
import axios from 'axios';
import {
  SSRF_BLOCKED_CODE,
  guardedBeforeRedirect,
  guardedLookup,
  isSsrfBlockedError,
  ssrfGuardedRequest,
} from '../../src/utils/ssrf-guard.js';

const listen = server =>
  new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

describe('ssrf guard', () => {
  describe('guardedLookup', () => {
    test('refuses a hostname that resolves to loopback', done => {
      guardedLookup('localhost', {}, error => {
        assert.ok(error, 'expected a refusal');
        assert.strictEqual(error.code, SSRF_BLOCKED_CODE);
        done();
      });
    });

    // dns.lookup short-circuits IP literals, so these two need no network
    test('passes a public address through in callback form', done => {
      guardedLookup('8.8.8.8', {}, (error, address, family) => {
        assert.ifError(error);
        assert.strictEqual(address, '8.8.8.8');
        assert.strictEqual(family, 4);
        done();
      });
    });

    test('passes a public address through in all form', done => {
      guardedLookup('8.8.8.8', { all: true }, (error, addresses) => {
        assert.ifError(error);
        assert.deepStrictEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
        done();
      });
    });

    test('refuses a private address literal the agent hands it', done => {
      guardedLookup('192.168.1.1', {}, error => {
        assert.ok(error, 'expected a refusal');
        assert.strictEqual(error.code, SSRF_BLOCKED_CODE);
        done();
      });
    });
  });

  describe('guardedBeforeRedirect', () => {
    test('throws on a hop into the private network', () => {
      assert.throws(
        () => guardedBeforeRedirect({ href: 'http://192.168.1.1/admin' }),
        error => {
          assert.strictEqual(error.code, SSRF_BLOCKED_CODE);
          return true;
        }
      );
    });

    test('throws on a hop to IPv6 loopback', () => {
      assert.throws(
        () => guardedBeforeRedirect({ href: 'http://[::1]:3001/api/settings' }),
        error => {
          assert.strictEqual(error.code, SSRF_BLOCKED_CODE);
          return true;
        }
      );
    });

    test('allows a hop to a public host', () => {
      assert.doesNotThrow(() => guardedBeforeRedirect({ href: 'https://media.tenor.com/x.gif' }));
    });

    test('reconstructs the target when href is absent', () => {
      assert.throws(() =>
        guardedBeforeRedirect({ protocol: 'http:', hostname: '127.0.0.1', path: '/' })
      );
    });
  });

  describe('isSsrfBlockedError', () => {
    test('sees through the wrapper chain', () => {
      const inner = new Error('refused');
      inner.code = SSRF_BLOCKED_CODE;
      const wrapped = new Error('Redirected request failed');
      wrapped.cause = inner;
      const outer = new Error('axios');
      outer.cause = wrapped;

      assert.strictEqual(isSsrfBlockedError(outer), true);
      assert.strictEqual(isSsrfBlockedError(new Error('plain failure')), false);
      assert.strictEqual(isSsrfBlockedError(undefined), false);
    });
  });

  describe('guarded requests', () => {
    test('blocks a redirect from an allowed host into loopback', async () => {
      const victim = http.createServer((req, res) => res.end('INTERNAL-SECRET'));
      const victimPort = await listen(victim);
      const redirector = http.createServer((req, res) => {
        res.writeHead(302, { Location: `http://127.0.0.1:${victimPort}/` });
        res.end();
      });
      const redirectorPort = await listen(redirector);

      try {
        await assert.rejects(
          axios.get(`http://127.0.0.1:${redirectorPort}/`, {
            ...ssrfGuardedRequest(),
            maxRedirects: 5,
          }),
          error => {
            assert.strictEqual(isSsrfBlockedError(error), true);
            return true;
          }
        );
      } finally {
        victim.close();
        redirector.close();
      }
    });

    test('blocks a loopback hostname before any bytes are exchanged', async () => {
      const victim = http.createServer((req, res) => res.end('INTERNAL-SECRET'));
      const victimPort = await listen(victim);

      try {
        await assert.rejects(
          axios.get(`http://localhost:${victimPort}/`, ssrfGuardedRequest()),
          error => {
            assert.strictEqual(isSsrfBlockedError(error), true);
            return true;
          }
        );
      } finally {
        victim.close();
      }
    });
  });
});
