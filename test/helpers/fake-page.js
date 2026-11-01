import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns';

export async function fakePage() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gronka-page-'));
  const fixture = path.join(dir, 'fixture.json');
  const calls = path.join(dir, 'calls.jsonl');
  const pythonPath = process.env.PYTHONPATH;
  const lookup = dns.lookup;
  await fs.mkdir(path.join(dir, 'curl_cffi'));
  await fs.writeFile(
    path.join(dir, 'curl_cffi/__init__.py'),
    `import json
import time
from pathlib import Path

class CurlOpt:
    RESOLVE = 'resolve'
    PROXY = 'proxy'

class Session:
    def __init__(self, **options):
        self.options = options
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def get(self, url, **options):
        root = Path(__file__).parent.parent
        with (root / 'calls.jsonl').open('a') as log:
            log.write(json.dumps(dict(url=url, session=self.options,
                **{k: v for k, v in options.items() if k != 'content_callback'})) + '\\n')
        fixtures = json.loads((root / 'fixture.json').read_text())
        answer = fixtures.pop(0)
        (root / 'fixture.json').write_text(json.dumps(fixtures))
        time.sleep(answer.get('delay', 0))
        if 'error' in answer:
            error = RuntimeError(answer['error'])
            error.code = answer.get('code')
            raise error
        options['content_callback'](answer.get('data', '').encode())
        return type('Response', (), dict(status_code=answer.get('status', 200),
            headers=answer.get('headers', {})))()

class requests:
    Session = Session
`
  );
  process.env.PYTHONPATH = dir;
  dns.lookup = (hostname, options, callback) => {
    if (['rule34.xxx', 'www.rule34.xxx'].includes(hostname)) {
      callback(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1::1', family: 6 },
      ]);
    } else if (hostname === 'private.example') {
      callback(null, [{ address: '192.168.1.1', family: 4 }]);
    } else lookup(hostname, options, callback);
  };
  return {
    respond: (...answers) => fs.writeFile(fixture, JSON.stringify(answers)),
    calls: async () => {
      const text = await fs.readFile(calls, 'utf8').catch(() => '');
      return text.trim() ? text.trim().split('\n').map(JSON.parse) : [];
    },
    async close() {
      dns.lookup = lookup;
      if (pythonPath === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = pythonPath;
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
