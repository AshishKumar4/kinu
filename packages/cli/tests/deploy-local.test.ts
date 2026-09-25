/**
 * `kinu deploy local` end to end: workerd must accept the rendered config and serve the release;
 * the renderer's text is asserted in packages/core/tests/unit-deploy-flow.test.ts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { LocalConfigSchema } from '@kinu.run/core/deploy';
import { tolerate } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { runToExit } from '@kinu.run/test-utils';
import { scratchDir } from '../../test-utils/src/scratch';

const repoRoot = resolve(__dirname, '../../..');

const cliBin = join(repoRoot, 'packages/cli/bin/cli.ts');

/** The pinned workerd; the instance resolves `workerd` from PATH when `bin/workerd` is absent. */
const binDir = join(repoRoot, 'node_modules/.bin');

const VERSION = '0.4.0+local01';

/**
 * `/kv` answers 500 unless the disk service is bound with `kvNamespace` (a plain `service` binding
 * gives a Fetcher). `/api/health` is the supervisor's readiness signal.
 */
const WORKER = `export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/api/health') {
    return Response.json({ ok: true, build: { version: '${VERSION}', sha: 'local01', builtAt: '2026-09-18T00:00:00.000Z' } });
  }
  if (path === '/kv') {
    await env.AUTH_KV.put('session:probe', 'kv round trip');
    return new Response(await env.AUTH_KV.get('session:probe'));
  }
  return new Response('local probe');
} };
export class LocalProbe { constructor(state, env) { this.state = state; this.env = env; } }
`;

const INDEX_HTML = '<!doctype html><title>local probe</title>\n';

const started: { home: string; port: number }[] = [];

const servers: Server[] = [];

const strangers: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const instance of started.splice(0)) {
    const pid = readPid(instance.home);

    if (pid !== null) tolerate(() => process.kill(pid, 'SIGKILL'), 'esrch');
  }

  for (const stranger of strangers.splice(0)) stranger.kill('SIGKILL');

  for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
});

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifestOf(): string {
  return JSON.stringify({
    version: VERSION,
    sha: 'local01',
    builtAt: '2026-09-18T00:00:00.000Z',
    channelOrigin: 'https://kinu.run',
    worker: {
      name: 'kinu',
      mainModule: 'index.js',
      compatibilityDate: '2025-12-01',
      compatibilityFlags: ['nodejs_compat'],
      modules: ['index.js'],
      modulesPath: 'worker',
      assets: 'client',
      assetsBinding: 'ASSETS',
      crons: [],
    },
    bindings: [
      { binding: 'AUTH_KV', kind: 'kv', resource: 'kinu-auth-kv', required: true },
      { binding: 'LocalProbe', kind: 'durable-object', resource: 'LocalProbe', required: true },
      { binding: 'ASSETS', kind: 'assets', resource: '', required: true },
      { binding: 'BACKUP_BUCKET', kind: 'r2', resource: 'kinu-backups', required: false },
      { binding: 'MEMORY_VECTORS', kind: 'vectorize', resource: 'kinu-memory', required: false },
    ],
    vectorIndexes: [{ name: 'kinu-memory', dimensions: 384, metric: 'cosine' }],
    migrations: [{ tag: 'v1', newSqliteClasses: ['LocalProbe'] }],
    secrets: [],
    vars: [{ name: 'SANDBOX_TRANSPORT', policy: 'carried', value: 'rpc' }],
    files: [
      { path: 'worker/index.js', sha256: sha256(WORKER), size: Buffer.byteLength(WORKER), assetHash: null },
      {
        path: 'client/index.html',
        sha256: sha256(INDEX_HTML),
        size: Buffer.byteLength(INDEX_HTML),
        assetHash: sha256(INDEX_HTML).slice(0, 32),
      },
    ],
    seed: null,
  });
}

/** Built with the system `tar`, so nothing here reimplements the archive format. */
async function artifact(): Promise<Uint8Array> {
  const stage = scratchDir('local-release');

  mkdirSync(join(stage, 'worker'), { recursive: true });
  mkdirSync(join(stage, 'client'), { recursive: true });
  writeFileSync(join(stage, 'release.json'), manifestOf());
  writeFileSync(join(stage, 'worker/index.js'), WORKER);
  writeFileSync(join(stage, 'client/index.html'), INDEX_HTML);

  const out = join(stage, 'release.tar.gz');

  const tar = await runToExit(['tar', '--format=ustar', '-czf', out, '-C', stage, 'release.json', 'worker/index.js', 'client/index.html']);

  if (tar.exitCode !== 0) throw new Error(`tar refused: ${tar.stderr}`);

  return new Uint8Array(readFileSync(out));
}

async function channel(manifest: string = manifestOf()): Promise<string> {
  const archive = await artifact();

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (path === '/downloads/release.json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(manifest);

      return;
    }

    if (path === `/downloads/kinu-worker-${VERSION}.tar.gz`) {
      response.writeHead(200, { 'content-type': 'application/gzip' }).end(Buffer.from(archive));

      return;
    }

    if (path === `/downloads/kinu-worker-${VERSION}.tar.gz.sha256`) {
      response.writeHead(200).end(`${sha256(archive)}  kinu-worker-${VERSION}.tar.gz\n`);

      return;
    }

    response.writeHead(404).end('no such release object');
  });

  servers.push(server);
  await listening(server);

  return `http://127.0.0.1:${String(boundPort(server))}`;
}

/** A free port, not 8787, so this row stays off whatever else the machine is serving. */
async function freePort(): Promise<number> {
  const probe = createServer();

  await listening(probe);
  const port = boundPort(probe);

  await new Promise<void>((closed) => probe.close(() => closed()));

  return port;
}

function listening(server: Server): Promise<void> {
  const { promise, resolve: listened } = Promise.withResolvers<void>();

  server.listen(0, '127.0.0.1', () => listened());

  return promise;
}

function boundPort(server: Server): number {
  const bound = v.safeParse(v.object({ port: v.number() }), server.address());

  if (!bound.success) throw new Error('the server did not take a TCP port');

  return bound.output.port;
}

function runDeploy(home: string, args: readonly string[]) {
  return runToExit([process.execPath, cliBin, 'deploy', 'local', ...args], {
    cwd: scratchDir('local-project'),
    env: { ...process.env, KINU_HOME: home, PATH: `${binDir}:${process.env.PATH ?? ''}` },
  });
}

function readPid(home: string): number | null {
  const text = tolerate(() => readFileSync(join(home, 'local/workerd.pid'), 'utf8'), 'enoent');

  if (text === undefined) return null;
  const pid = Number.parseInt(text.trim(), 10);

  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

describe('kinu deploy local', () => {
  test('installs the release, serves it on its port, and stops when told to', async () => {
    const home = scratchDir(`local-home-${randomUUID().slice(0, 8)}`);
    const origin = await channel();
    const port = await freePort();

    started.push({ home, port });

    const installed = await runDeploy(home, [`--origin=${origin}`, `--port=${String(port)}`]);

    expect(installed.exitCode).toBe(0);
    expect(installed.stdout).toContain(VERSION);
    expect(installed.stdout).toContain(`http://127.0.0.1:${String(port)}`);
    // Unsupported capabilities are named, not dropped; `r2Bucket` over a disk service cannot work.
    expect(installed.stdout).toContain('MEMORY_VECTORS');
    expect(installed.stdout).toContain('BACKUP_BUCKET');

    const layout = join(home, 'local');
    const config = v.parse(LocalConfigSchema, JSON.parse(readFileSync(join(layout, 'config.json'), 'utf8')));

    expect(config.version).toBe(VERSION);
    expect(config.port).toBe(port);
    expect(lstatSync(join(layout, 'current')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(layout, 'current'))).toBe(join(layout, 'releases', VERSION));
    expect(existsSync(join(layout, 'releases', VERSION, 'worker/index.js'))).toBe(true);
    expect(readFileSync(join(layout, 'workerd.capnp'), 'utf8'))
      .toContain(`(name = "http", address = "127.0.0.1:${String(port)}", http = (), service = "main"),`);

    const answer = await fetch(config.address);

    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe('local probe');

    const roundTrip = await fetch(new URL('/kv', config.address));

    expect(roundTrip.status).toBe(200);
    expect(await roundTrip.text()).toBe('kv round trip');
    expect(readFileSync(join(layout, 'state/kv/kinu-auth-kv/session:probe'), 'utf8')).toBe('kv round trip');

    const pid = readPid(home);

    expect(pid).not.toBeNull();
    expect((await runDeploy(home, ['status'])).stdout).toContain(`pid ${String(pid ?? 0)}`);

    const stopped = await runDeploy(home, ['stop']);

    expect(stopped.exitCode).toBe(0);
    expect(stopped.stdout).toContain(`pid ${String(pid ?? 0)}`);
    expect(tolerate(() => process.kill(pid ?? 0, 0), 'esrch')).toBeUndefined();
    expect((await runDeploy(home, ['stop'])).stdout).toContain('No local Kinu is running');
  });

  /** A pidfile outlives its process and pids are reused; `stop` must refuse a stranger's pid. */
  test('refuses a pidfile that names a live process which is not its workerd', async () => {
    const home = scratchDir(`local-home-${randomUUID().slice(0, 8)}`);
    const origin = await channel();
    const port = await freePort();

    started.push({ home, port });
    expect((await runDeploy(home, [`--origin=${origin}`, `--port=${String(port)}`])).exitCode).toBe(0);
    expect((await runDeploy(home, ['stop'])).exitCode).toBe(0);

    const stranger = Bun.spawn({ cmd: ['sleep', '120'], stdout: 'ignore', stderr: 'ignore' });

    strangers.push(stranger);
    writeFileSync(join(home, 'local/workerd.pid'), `${String(stranger.pid)}\n`);

    const refused = await runDeploy(home, ['stop']);

    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain(`Not stopping pid ${String(stranger.pid)}`);

    expect(stranger.exitCode).toBeNull();
    expect(stranger.signalCode).toBeNull();
    expect(existsSync(join(home, 'local/workerd.pid'))).toBe(false);
    expect((await runDeploy(home, ['stop'])).stdout).toContain('No local Kinu is running');
  });

  /** With the port taken, workerd dies on EADDRINUSE while connects still succeed. */
  test('reports the failure when workerd exits and another process holds the port', async () => {
    const home = scratchDir(`local-home-${randomUUID().slice(0, 8)}`);
    const origin = await channel();

    const squatter = createServer((_request, response) => {
      response.writeHead(404).end('not kinu');
    });

    servers.push(squatter);
    await listening(squatter);
    const port = boundPort(squatter);

    started.push({ home, port });

    const attempt = await runDeploy(home, [`--origin=${origin}`, `--port=${String(port)}`]);

    expect(attempt.exitCode).not.toBe(0);
    expect(attempt.stderr).toContain('exited while starting');
    expect(attempt.stderr).toContain('answered by another process');
    expect(attempt.stdout).not.toContain('Local Kinu on');
    expect(readPid(home)).toBeNull();
  });

  /** A manifest path escaping the release directory is refused before anything is created. */
  test('refuses a release whose manifest names a path outside its release', async () => {
    const home = scratchDir(`local-home-${randomUUID().slice(0, 8)}`);
    const escaping = manifestOf().replace('"worker/index.js"', '"worker/../../../../escape.js"');

    expect(escaping).toContain('worker/../../../../escape.js');

    const origin = await channel(escaping);
    const refused = await runDeploy(home, [`--origin=${origin}`, `--port=${String(await freePort())}`]);

    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain('a release file path must stay inside its release');

    expect(existsSync(join(home, 'local'))).toBe(false);
    expect(existsSync(join(home, 'escape.js'))).toBe(false);
  });
});
