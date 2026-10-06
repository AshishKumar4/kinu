import { scratchDir } from '../packages/test-utils/src/scratch';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { dirname, join } from 'node:path';
import { DEV_IDENTITY_ACCOUNT_HEADER, DEV_IDENTITY_HEADER } from '@kinu.run/core';
import { EVAL_DEPLOYMENT_ORIGIN, EVAL_SERVICE_EMAIL } from '../packages/test-utils/src/eval-identity';

/** A deployment that runs the device flow and approves it only for one secret. `honorsAccount`: it resolves a
 *  named eval account to its plus-addressed user, as every build since the account header does; without it, it
 *  answers as the eval service itself, as older builds do. */
function deployment(secret: string, { honorsAccount = false } = {}) {
  const seen: string[] = [];
  let approved = false;
  let approvedAs = EVAL_SERVICE_EMAIL;
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

/** Where the mint keeps `origin`'s bearer for `account` under `home`. */
const sessionPath = (home: string, origin: string, account?: string): string =>
  join(home, '.config/kinu/eval-session', new URL(origin).host, ...(account === undefined ? [] : [account]), 'config.json');

/** The `devices` eval account's bearer, as a mint that did not check its user kept it. */
function keptDevicesBearer(home: string, origin: string, email: string): string {
  const path = sessionPath(home, origin, 'devices');
  const dir = dirname(path);

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ origin, accessToken: 'pta_shared', user: { id: 'u', email } }), { mode: 0o600 });

  return path;
}

describe('the eval-session mint', () => {
  const stops: Array<() => Promise<void> | void> = [];
  afterEach(async () => { await Promise.all(stops.splice(0).map(async (stop) => stop())); });

  test.each(['', '   '])('a blank origin %j cannot mint or borrow the default deployment bearer', async (origin) => {
    const home = scratchDir('mint-blank-origin');
    const path = sessionPath(home, EVAL_DEPLOYMENT_ORIGIN);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ origin: EVAL_DEPLOYMENT_ORIGIN, accessToken: 'pta_default' }), { mode: 0o600 });

    for (const script of ['scripts/eval-session-mint.ts', 'scripts/eval-credentials.ts']) {
      const run = await runScript(script, { KINU_EVAL_ORIGIN: origin, KINU_EVAL_WEB_IDENTITY: 'secret' }, home);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toMatch(/REFUSED.*KINU_EVAL_ORIGIN.*empty value/);
      expect(run.stdout).not.toContain('pta_default');
    }
  });

  test('approves the device flow as the eval identity and persists the bearer, mode 0600', async () => {
    const d = deployment('s3cret');
    stops.push(d.stop);
    const home = scratchDir('mint');
    const run = await mint({ KINU_EVAL_ORIGIN: d.origin, KINU_EVAL_WEB_IDENTITY: 's3cret' }, home);
    expect(run.exitCode).toBe(0);
    const path = sessionPath(home, d.origin);
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
    expect(existsSync(sessionPath(home, d.origin))).toBe(false);
  });

  test('each deployment keeps its own session: minting a second leaves the first\'s in place', async () => {
    // A staging deployment beside production: with one file for both, the second mint was refused.
    const [first, second] = [deployment('s3cret'), deployment('s3cret')];
    stops.push(first.stop, second.stop);
    const home = scratchDir('mint');

    for (const d of [first, second]) {
      expect((await mint({ KINU_EVAL_ORIGIN: d.origin, KINU_EVAL_WEB_IDENTITY: 's3cret' }, home)).exitCode).toBe(0);
    }

    for (const d of [first, second]) {
      expect((await runScript('scripts/eval-credentials.ts', { KINU_EVAL_ORIGIN: d.origin }, home)).stdout)
        .toBe(`${d.origin}\npta_minted\n`);
    }
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
    expect(existsSync(sessionPath(home, d.origin, 'devices'))).toBe(false);
    expect(d.seen).not.toContain('POST /api/user/onboarding/complete');
  });

  test('a named account approved as itself is stamped and kept beside the eval service\'s own', async () => {
    const d = deployment('s3cret', { honorsAccount: true });
    stops.push(d.stop);
    const home = scratchDir('mint');
    const run = await mint({ KINU_EVAL_ORIGIN: d.origin, KINU_EVAL_WEB_IDENTITY: 's3cret', KINU_EVAL_ACCOUNT: 'devices' }, home);

    expect(run.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(sessionPath(home, d.origin, 'devices'), 'utf8')))
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
