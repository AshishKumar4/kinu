import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A deployment that runs the device flow and approves it only for one secret. */
function deployment(secret: string) {
  const seen: string[] = [];
  let approved = false;
  let origin = '';

  const server = Bun.serve({
    port: 0,
    fetch: async (request): Promise<Response> => {
      const { pathname } = new URL(request.url);
      seen.push(`${request.method} ${pathname}`);

      if (pathname === '/api/cli/auth/start') {
        return Response.json({ deviceToken: 'dt', userCode: 'CODE', verificationUrl: '/cli/auth', expiresAt: '', intervalSeconds: 1 });
      }

      if (pathname === '/cli/auth' && request.headers.get('x-kinu-dev-identity') !== secret) {
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

        return new Response('', { status: approved ? 200 : 403 });
      }

      if (pathname === '/api/cli/auth/poll') {
        return Response.json(approved
          ? { status: 'approved', token: 'pta_minted', origin, user: { id: 'u', email: 'eval-service@kinu.run' } }
          : { status: 'pending' });
      }

      return new Response('', { status: 404 });
    },
  });

  origin = `http://127.0.0.1:${server.port}`;

  return { origin, seen, stop: () => server.stop(true) };
}

// Spawned asynchronously: the stub deployment lives in this process, and a
// synchronous spawn would block the loop it answers on.
async function mint(env: Record<string, string>, home: string) {
  const run = Bun.spawn(['bun', 'scripts/eval-session-mint.ts'], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, HOME: home, KINU_EVAL_TOKEN: '', ...env },
    stdout: 'pipe', stderr: 'pipe',
  });

  const [exitCode, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);

  return { exitCode, stderr };
}

describe('the eval-session mint', () => {
  const stops: Array<() => void> = [];
  const homes: string[] = [];
  afterEach(() => { for (const stop of stops.splice(0)) stop();

 for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

  test('approves the device flow as the eval identity and persists the bearer, mode 0600', async () => {
    const d = deployment('s3cret');
    stops.push(d.stop);
    const home = mkdtempSync(join(tmpdir(), 'kinu-mint-'));
    homes.push(home);
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
    const home = mkdtempSync(join(tmpdir(), 'kinu-mint-'));
    homes.push(home);
    const run = await mint({ KINU_EVAL_ORIGIN: d.origin, KINU_EVAL_WEB_IDENTITY: 'guess' }, home);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('refused the approval page (401)');
    expect(existsSync(join(home, '.config/kinu/eval-session/config.json'))).toBe(false);
  });

  test('a persisted session for another deployment is never overwritten', async () => {
    const d = deployment('s3cret');
    stops.push(d.stop);
    const home = mkdtempSync(join(tmpdir(), 'kinu-mint-'));
    homes.push(home);
    const path = join(home, '.config/kinu/eval-session/config.json');
    mkdirSync(join(home, '.config/kinu/eval-session'), { recursive: true });
    writeFileSync(path, JSON.stringify({ origin: 'http://127.0.0.1:9', accessToken: 'pta_other' }));
    const run = await mint({ KINU_EVAL_ORIGIN: d.origin, KINU_EVAL_WEB_IDENTITY: 's3cret' }, home);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('move it aside');
    expect(JSON.parse(readFileSync(path, 'utf8')).accessToken).toBe('pta_other');
    expect(d.seen).toEqual([]);
  });

  test('an origin outside the allowlist is refused before any request', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kinu-mint-'));
    homes.push(home);
    const run = await mint({ KINU_EVAL_ORIGIN: 'https://staging.kinu.run', KINU_EVAL_WEB_IDENTITY: 's3cret' }, home);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('REFUSED');
  });
});
