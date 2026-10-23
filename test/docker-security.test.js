import { test, describe, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const root = path.join(import.meta.dir, '..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const compose = file => Bun.YAML.parse(read(file)).services;
const bot = compose('docker-compose.yml');
const web = compose('docker-compose.web.yml');
const everyService = [...Object.entries(bot), ...Object.entries(web)];

const bindsAllInterfaces = mapping => !/^(127\.0\.0\.1|localhost):/.test(String(mapping));

describe('compose security', () => {
  test('nothing mounts the docker socket', () => {
    const withSocket = everyService
      .filter(([, s]) => (s.volumes ?? []).some(v => String(v).includes('docker.sock')))
      .map(([name]) => name);
    expect(withSocket).toEqual([]);
  });

  test('no service runs privileged or shares a host namespace', () => {
    for (const [name, s] of everyService) {
      expect([name, s.privileged ?? false]).toEqual([name, false]);
      for (const key of ['network_mode', 'pid', 'ipc'])
        expect([name, key, s[key]]).not.toEqual([name, key, 'host']);
    }
  });

  test('capabilities are added only to the vpn and to the bot containers contain.sh drops', () => {
    const added = everyService.filter(([, s]) => s.cap_add?.length).map(([n, s]) => [n, s.cap_add]);
    const contain = ['NET_ADMIN', 'SETUID', 'SETGID', 'SETPCAP'];
    expect(added).toEqual([
      ['app', contain],
      ['worker', contain],
      ['vpn', ['NET_ADMIN']],
    ]);
  });

  test('bot containers fence egress, then run read-only with no capabilities', () => {
    for (const name of ['app', 'worker']) {
      const s = bot[name];
      expect([name, s.read_only, s.cap_drop]).toEqual([name, true, ['ALL']]);
      expect(s.security_opt).toContain('no-new-privileges:true');
      for (const volume of s.volumes.filter(v => /cookies/.test(v)))
        expect(volume).toEndWith(':ro');
    }
    expect(bot.worker.entrypoint[0]).toBe('contain.sh');
    expect(read('Dockerfile')).toContain('ENTRYPOINT ["contain.sh", "docker-entrypoint.sh"]');
    const contain = read('scripts/contain.sh');
    expect(contain).toContain('192.168.0.0/16');
    expect(contain).toMatch(/exec setpriv .*--bounding-set=-all.*--no-new-privs/);
  });

  test('no host system directory is bind mounted', () => {
    const system = /^\/(etc|root|home|usr|bin|sbin|sys|proc|boot)?(\/|$)/;
    for (const [name, s] of everyService) {
      for (const volume of s.volumes ?? []) {
        const source = String(volume).split(':')[0];
        if (source === '/var/run/docker.sock' || !source.startsWith('/')) continue;
        expect(`${name} ${source}`).not.toMatch(system);
      }
    }
  });

  test('every external image is pinned to a version', () => {
    for (const [name, s] of everyService) {
      if (!s.image || s.build || s.pull_policy === 'never') continue;
      expect(`${name} ${s.image}`).toMatch(/:[\w.-]+$/);
      expect(s.image).not.toMatch(/:latest$/);
    }
  });

  test('only the bot api and webui listen beyond localhost', () => {
    const open = everyService.flatMap(([name, s]) =>
      (s.ports ?? []).filter(bindsAllInterfaces).map(p => `${name} ${p}`)
    );
    expect(open).toEqual([
      'app ${SERVER_PORT:-3000}:${SERVER_PORT:-3000}',
      'app ${WEBUI_PORT:-3001}:${WEBUI_PORT:-3001}',
    ]);
  });

  test('gronka-web publishes no ports and keeps its database off the internet', () => {
    expect(Object.values(web).flatMap(s => s.ports ?? [])).toEqual([]);
    expect(Bun.YAML.parse(read('docker-compose.web.yml')).networks['web-db'].internal).toBe(true);
    expect(web.postgres.networks).toEqual(['web-db']);
  });

  test('web containers are read-only, drop every capability and run as non-root', () => {
    for (const name of ['gronka-web', 'cobalt-web', 'cloudflared']) {
      expect([name, web[name].read_only, web[name].cap_drop]).toEqual([name, true, ['ALL']]);
      expect(web[name].security_opt).toContain('no-new-privileges:true');
    }
    expect(web['gronka-web'].user).not.toMatch(/^(0|root)\b/);
    expect(web.cloudflared.user).not.toMatch(/^(0|root)\b/);
  });

  test('the app image drops root and the bot containers have memory caps', () => {
    const lastUser = read('Dockerfile')
      .match(/^USER\s+(\S+)/gm)
      ?.at(-1);
    expect(lastUser).toBe('USER bun');
    expect(bot.app.mem_limit).toBeTruthy();
    expect(bot.worker.mem_limit).toBeTruthy();
  });

  test('secrets come from the environment, never from the compose file', () => {
    const secret = /(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|PEPPER|ACCESS_KEY_ID)/;
    for (const [name, s] of everyService) {
      const env = Array.isArray(s.environment)
        ? s.environment.map(e => String(e).split(/=(.*)/s).slice(0, 2))
        : Object.entries(s.environment ?? {});
      for (const [key, value] of env) {
        if (!secret.test(key)) continue;
        expect(`${name} ${key}=${value}`).toMatch(/=\$\{[A-Z0-9_]+(:[-?][^}]*)?\}$/);
      }
    }
  });
});

describe('source never shells out', () => {
  const sources = readdirSync(path.join(root, 'src'), { recursive: true })
    .filter(f => f.endsWith('.js') && !f.startsWith('public'))
    .map(f => [f, read(path.join('src', f))]);

  test('nothing invokes the docker cli', () => {
    const offenders = sources.filter(([, c]) =>
      /spawn\(\s*['"]docker|exec(Sync)?\(\s*[`'"]docker /.test(c)
    );
    expect(offenders.map(([f]) => f)).toEqual([]);
  });

  test('no child process is started through a shell', () => {
    const offenders = sources.filter(
      ([, c]) =>
        /import\s*\{[^}]*\bexec(Sync)?\b[^}]*\}\s*from\s*['"](node:)?child_process/.test(c) ||
        /shell:\s*true/.test(c)
    );
    expect(offenders.map(([f]) => f)).toEqual([]);
  });
});
