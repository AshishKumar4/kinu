import { scratchDir } from '../packages/test-utils/src/scratch';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import { DEV_IDENTITY_ACCOUNT_HEADER, DEV_IDENTITY_HEADER } from '@kinu.run/core';

/** A deployment that runs the device flow and approves it only for one secret. `honorsAccount`: it resolves a
 *  named eval account to its plus-addressed user, as every build since the account header does; without it, it
 *  answers as the eval service itself, as older builds do. */
function deployment(secret: string, { honorsAccount = false } = {}) {
  const seen: string[] = [];
  let approved = false;
  let approvedAs = 'eval-service@kinu.run';
  let origin = '';

  const server = Bun.serve({
    port: 0,
    fetch: async (request): Promise<Response> => {
      const { pathname } = new URL(request.url);
      seen.push(`${request.method} ${pathname}`);

      if (pathname === '/api/cli/auth/start') {
        return Response.json({ deviceToken: 'dt', userCode: 'CODE', verificationUrl: '/cli/auth', expiresAt: '', intervalSeconds: 1 });
      }

      if (pathname === '/cli/auth' && request.headers.get(DEV_IDENTITY_HEADER) !== secret) {
        return new Response('who?', { status: 401 });
      }

      if (pathname === '/cli/auth' && request.method === 'GET') {
        return new Response('<form><input name="csrf" value="tok" /></form>', {
          headers: { 'set-cookie': 'kinu_cli_csrf=tok; Path=/cli/auth; SameSite=Strict' },
        });
      }

      if (pathname === '/cli/auth') {
        const form = await request.formData();
        const sameOrigin = request.headers.get('origin') === origin;
        const csrfMatches = form.get('csrf') === 'tok' && request.headers.get('cookie') === 'kinu_cli_csrf=tok';
        approved = sameOrigin && csrfMatches && form.get('userCode') === 'CODE';
        const account = request.headers.get(DEV_IDENTITY_ACCOUNT_HEADER);

        if (honorsAccount && account !== null) approvedAs = `eval-service+${account}@kinu.run`;

        return new Response('', { status: approved ? 200 : 403 });
      }

      if (pathname === '/api/cli/auth/poll') {
        return Response.json(approved
          ? { status: 'approved', token: 'pta_minted', origin, user: { id: 'u', email: approvedAs } }
          : { status: 'pending' });
      }

      if (pathname === '/api/user/onboarding/complete' && request.headers.get(DEV_IDENTITY_HEADER) === secret) {
        return Response.json({ onboardedAt: 1 });
      }

      return new Response('', { status: 404 });
    },
  });

  origin = `http://127.0.0.1:${server.port}`;

  return { origin, seen, stop: () => server.stop(true) };
}

// Spawned asynchronously: the stub deployment lives in this process, and a
// synchronous spawn would block the loop it answers on.
async function runScript(script: string, env: Record<string, string>, home: string) {
  const run = Bun.spawn(['bun', script], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, HOME: home, KINU_EVAL_TOKEN: '', ...env },
    stdout: 'pipe', stderr: 'pipe',
  });

  const [exitCode, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);

  return { exitCode, stdout, stderr };
}

const mint = async (env: Record<string, string>, home: string) => runScript('scripts/eval-session-mint.ts', env, home);

/** The `devices` eval account's bearer, as a mint that did not check its user kept it. */
function keptDevicesBearer(home: string, origin: string, email: string): string {
  const dir = join(home, '.config/kinu/eval-session/devices');
  const path = join(dir, 'config.json');

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ origin, accessToken: 'pta_shared', user: { id: 'u', email } }), { mode: 0o600 });

  return path;
}

describe('the eval-session mint', () => {
  const stops: Array<() => void> = [];
  afterEach(() => { for (const stop of stops.splice(0)) stop();

  });

  test('approves the device flow as the eval identity and persists the bearer, mode 0600', async () => {
    const d = deployment('s3cret');
    stops.push(d.stop);
    const home = scratchDir('mint');
    const run = await mint({ KINU_EVAL_ORIGIN: d.origin, KINU_EVAL_WEB_IDENTITY: 's3cret' }, home);
    expect(run.exitCode).toBe(0);
    const path = join(home, '.config/kinu/eval-session/config.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ origin: d.origin, accessToken: 'pta_minted' });
    expect(d.seen).toEqual(['POST /api/cli/auth/start', 'GET /cli/auth', 'POST /cli/auth', 'POST /api/cli/auth/poll']);
  });

  test('a wrong web identity is refused by the deployment and nothing is written', async () => {
    const d = deployment('s3cret');
    stops.push(d.stop);
    const home = scratchDir('mint');
    const run = await mint({ KINU_EVAL_ORIGIN: d.origin, KINU_EVAL_WEB_IDENTITY: 'guess' }, home);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('refused the approval page (401)');
    expect(existsSync(join(home, '.config/kinu/eval-session/config.json'))).toBe(false);
  });

  test('a persisted session for another deployment is never overwritten', async () => {
    const d = deployment('s3cret');
    stops.push(d.stop);
    const home = scratchDir('mint');
    const path = join(home, '.config/kinu/eval-session/config.json');
    mkdirSync(join(home, '.config/kinu/eval-session'), { recursive: true });
    writeFileSync(path, JSON.stringify({ origin: 'http://127.0.0.1:9', accessToken: 'pta_other' }));
    const run = await mint({ KINU_EVAL_ORIGIN: d.origin, KINU_EVAL_WEB_IDENTITY: 's3cret' }, home);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('move it aside');
    expect(JSON.parse(readFileSync(path, 'utf8')).accessToken).toBe('pta_other');
    expect(d.seen).toEqual([]);
  });

  // 2026-09-24: a build older than the account header resolves the devices account's secret to the eval service
  // itself, and a bearer kept for it would put the fleet's machines back on the account every tier's agent runs on.
  test('a named account approved as the eval service itself is refused, and nothing is kept or stamped', async () => {
    const d = deployment('s3cret');
    stops.push(d.stop);
    const home = scratchDir('mint');
    const run = await mint({ KINU_EVAL_ORIGIN: d.origin, KINU_EVAL_WEB_IDENTITY: 's3cret', KINU_EVAL_ACCOUNT: 'devices' }, home);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("eval-service@kinu.run's, not the devices eval account's");
    expect(existsSync(join(home, '.config/kinu/eval-session/devices/config.json'))).toBe(false);
    expect(d.seen).not.toContain('POST /api/user/onboarding/complete');
  });

  test('a named account approved as itself is stamped and kept beside the eval service\'s own', async () => {
    const d = deployment('s3cret', { honorsAccount: true });
    stops.push(d.stop);
    const home = scratchDir('mint');
    const run = await mint({ KINU_EVAL_ORIGIN: d.origin, KINU_EVAL_WEB_IDENTITY: 's3cret', KINU_EVAL_ACCOUNT: 'devices' }, home);

    expect(run.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(home, '.config/kinu/eval-session/devices/config.json'), 'utf8')))
      .toMatchObject({ accessToken: 'pta_minted', user: { email: 'eval-service+devices@kinu.run' } });
    expect(d.seen).toContain('POST /api/user/onboarding/complete');
  });

  test('a kept named-account bearer that is the eval service\'s own is neither accepted nor handed out', async () => {
    const d = deployment('s3cret', { honorsAccount: true });
    stops.push(d.stop);
    const home = scratchDir('mint');
    keptDevicesBearer(home, d.origin, 'eval-service@kinu.run');
    const env = { KINU_EVAL_ORIGIN: d.origin, KINU_EVAL_WEB_IDENTITY: 's3cret', KINU_EVAL_ACCOUNT: 'devices' };
    const minted = await mint(env, home);
    const handed = await runScript('scripts/eval-credentials.ts', env, home);

    expect(minted.exitCode).toBe(1);
    expect(minted.stderr).toContain("eval-service@kinu.run's, not the devices eval account's");
    expect(handed.exitCode).toBe(1);
    expect(handed.stdout).not.toContain('pta_shared');
  });

  test('an origin outside the allowlist is refused before any request', async () => {
    const home = scratchDir('mint');
    const run = await mint({ KINU_EVAL_ORIGIN: 'https://preview.kinu.run', KINU_EVAL_WEB_IDENTITY: 's3cret' }, home);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('REFUSED');
  });
});
