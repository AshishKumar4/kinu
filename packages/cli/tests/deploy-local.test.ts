/**
 * `kinu deploy local` end to end: a release channel this test publishes, the
 * real workerd binary, and the instance answering on its own port.
 *
 * WHY THE WHOLE COMMAND AND NOT THE RENDERER. What the renderer produces is
 * asserted as text in `packages/core/tests/unit-deploy-flow.test.ts`; the
 * question a person actually has is whether workerd ACCEPTS that text and
 * serves the release. So this row installs from a channel, starts the
 * supervisor, fetches the instance's own response, and stops it — the config
 * being valid is proved by the runtime rather than by our opinion of it.
 *
 * The port is a free one rather than 8787: this repository's default is
 * asserted in the core row, and a fixed port here would collide with whatever
 * else on the machine is serving one.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { LocalConfigSchema } from '@kinu.run/core/deploy';
import { tolerate } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { scratchDir } from '../../test-utils/src/scratch';

const repoRoot = resolve(__dirname, '../../..');

const cliBin = join(repoRoot, 'packages/cli/bin/cli.ts');

/** The workerd this repository already pins for the workerd test layer. The
 *  installed instance resolves `workerd` from PATH when `bin/workerd` is
 *  absent, which is what this puts there. */
const binDir = join(repoRoot, 'node_modules/.bin');

const VERSION = '0.4.0+local01';

const WORKER = `export default { fetch: () => new Response('local probe') };
export class LocalProbe { constructor(state, env) { this.state = state; this.env = env; } }
`;

const INDEX_HTML = '<!doctype html><title>local probe</title>\n';

const started: { home: string; port: number }[] = [];

const servers: Server[] = [];

afterEach(async () => {
  for (const instance of started.splice(0)) {
    const pid = readPid(instance.home);

    if (pid !== null) tolerate(() => process.kill(pid, 'SIGKILL'), 'esrch');
  }

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

/** The channel's tarball, built with the system `tar` so nothing here is a
 *  second implementation of the archive format core's reader accepts. */
async function artifact(): Promise<Uint8Array> {
  const stage = scratchDir('local-release');

  mkdirSync(join(stage, 'worker'), { recursive: true });
  mkdirSync(join(stage, 'client'), { recursive: true });
  writeFileSync(join(stage, 'release.json'), manifestOf());
  writeFileSync(join(stage, 'worker/index.js'), WORKER);
  writeFileSync(join(stage, 'client/index.html'), INDEX_HTML);

  const out = join(stage, 'release.tar.gz');

  const tar = Bun.spawnSync({
    cmd: ['tar', '--format=ustar', '-czf', out, '-C', stage, 'release.json', 'worker/index.js', 'client/index.html'],
  });

  if (tar.exitCode !== 0) throw new Error(`tar refused: ${tar.stderr.toString()}`);

  return new Uint8Array(readFileSync(out));
}

/** The channel, on a port of its own: `release.json`, the tarball, and the
 *  digest the installer verifies before it unpacks anything. */
async function channel(): Promise<string> {
  const archive = await artifact();
  const manifest = manifestOf();

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

/** A port nothing is on: taken and released, so the instance can have it. A
 *  free port rather than 8787 keeps this row off whatever else on the machine
 *  is serving one. */
async function freePort(): Promise<number> {
  const probe = createServer();

  await listening(probe);
  const port = boundPort(probe);

  await new Promise<void>((closed) => probe.close(() => closed()));

  return port;
}

function listening(server: Server): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();

  server.listen(0, '127.0.0.1', () => resolve());

  return promise;
}

/** The port the OS gave a listening server, read the way every other
 *  boundary here is read — parsed. A server answering with a pipe name or
 *  nothing at all never took a TCP port, and every caller here asked for one. */
function boundPort(server: Server): number {
  const bound = v.safeParse(v.object({ port: v.number() }), server.address());

  if (!bound.success) throw new Error('the server did not take a TCP port');

  return bound.output.port;
}

/**
 * One `kinu deploy local …` run.
 *
 * Spawned ASYNCHRONOUSLY, not with `spawnSync`: the release channel above is
 * an HTTP server in THIS process, and a synchronous spawn holds the event loop
 * while the child waits for a manifest that can never be served. That
 * deadlock is the whole reason this is async.
 */
async function runDeploy(home: string, args: readonly string[]) {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliBin, 'deploy', 'local', ...args],
    cwd: scratchDir('local-project'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, KINU_HOME: home, PATH: `${binDir}:${process.env.PATH ?? ''}` },
  });

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

  return { exitCode: await proc.exited, stdout, stderr };
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
    // A capability workerd has no implementation of is named, not silently
    // dropped.
    expect(installed.stdout).toContain('MEMORY_VECTORS');

    const layout = join(home, 'local');
    const config = v.parse(LocalConfigSchema, JSON.parse(readFileSync(join(layout, 'config.json'), 'utf8')));

    expect(config.version).toBe(VERSION);
    expect(config.port).toBe(port);
    expect(lstatSync(join(layout, 'current')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(layout, 'current'))).toBe(join(layout, 'releases', VERSION));
    expect(existsSync(join(layout, 'releases', VERSION, 'worker/index.js'))).toBe(true);
    expect(readFileSync(join(layout, 'workerd.capnp'), 'utf8'))
      .toContain(`(name = "http", address = "127.0.0.1:${String(port)}", http = (), service = "main"),`);

    // The instance itself answers: workerd parsed the rendered config, loaded
    // the release's module and bound the Durable Object class it names.
    const answer = await fetch(config.address);

    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe('local probe');

    const pid = readPid(home);

    expect(pid).not.toBeNull();
    expect((await runDeploy(home, ['status'])).stdout).toContain(`pid ${String(pid ?? 0)}`);

    const stopped = await runDeploy(home, ['stop']);

    expect(stopped.exitCode).toBe(0);
    expect(stopped.stdout).toContain(`pid ${String(pid ?? 0)}`);
    expect(tolerate(() => process.kill(pid ?? 0, 0), 'esrch')).toBeUndefined();
    expect((await runDeploy(home, ['stop'])).stdout).toContain('No local Kinu is running');
  });
});
