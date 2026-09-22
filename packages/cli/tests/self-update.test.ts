/**
 * Only the origin is faked: archives are real tar.gz files and the staged `cli.js` runs under this Bun.
 * Env-dependent paths (KINU_HOME) run in subprocesses.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server } from 'bun';
import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { scratchDir } from '@kinu.run/test-utils';
import { generateReleaseSigningKey, signRelease, type JsonObject } from '@kinu.run/core';

const repoRoot = resolve(__dirname, '../../..');

const NOW = 2_000_000_000_000;

const SERVED = '9.9.9+served';

const stubs: Server<unknown>[] = [];

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((server) => server.stop(true)));
});

const PLATFORM_ARTIFACT = `/downloads/kinu-cli-${process.platform}-${process.arch}.tar.gz`;

const RUNTIME_ARTIFACT = '/downloads/kinu-runtime-cpython.tar.gz';

function tarball(files: Record<string, string>): Uint8Array {
  const work = scratchDir('self-update-archive');
  mkdirSync(join(work, 'kinu', 'node_modules'), { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(work, 'kinu', name, '..'), { recursive: true });
    writeFileSync(join(work, 'kinu', name), content);
  }

  const archived = Bun.spawnSync({ cmd: ['tar', '-czf', join(work, 'a.tar.gz'), '-C', work, 'kinu'] });

  if (archived.exitCode !== 0) throw new Error(`tar failed: ${new TextDecoder().decode(archived.stderr)}`);

  return new Uint8Array(readFileSync(join(work, 'a.tar.gz')));
}

function cliSource(stamp: string): string {
  return `console.log(process.argv[2] === '--version' ? ${JSON.stringify(stamp)} : 'ran');\n`;
}

interface StubOrigin {
  origin: string;
  hits: string[];
}

/** Every child CLI pins the public half through the environment. */
const signingKey = generateReleaseSigningKey();

/** `signing` models the hostile deployment of SECURITY-devices C1. */
function startOrigin(opts: { platform: Uint8Array; runtime: Uint8Array; corrupt?: boolean; signing?: 'none' | 'foreign' }): StubOrigin {
  const hits: string[] = [];

  const files = { [PLATFORM_ARTIFACT]: opts.platform, [RUNTIME_ARTIFACT]: opts.runtime };
  const digestOf = (artifact: Uint8Array) => createHash('sha256').update(opts.corrupt ? new Uint8Array([1, 2, 3]) : artifact).digest('hex');
  const checksums = Object.fromEntries(Object.entries(files).map(([name, artifact]) => [name, digestOf(artifact)]));

  const manifest = (async () => {
    const stamp = { version: SERVED, sha: 'abc', builtAt: 'now' };

    if (opts.signing === 'none') return { ...stamp, checksums };
    const key = opts.signing === 'foreign' ? await generateReleaseSigningKey() : await signingKey;
    const signed = await signRelease(SERVED, checksums, key.privateKeyPkcs8Base64);

    return { ...stamp, checksums: signed.checksums, signature: signed.signature };
  })();

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      hits.push(pathname);

      if (pathname === '/downloads/kinu-version.json') return Response.json(await manifest);
      const artifact = Object.entries(files).find(([name]) => name === pathname.replace(/\.sha256$/, ''))?.[1];

      if (!artifact) return new Response('not found', { status: 404 });

      if (!pathname.endsWith('.sha256')) return new Response(Buffer.from(artifact));

      return new Response(`${digestOf(artifact)}  ${pathname.slice('/downloads/'.length, -'.sha256'.length)}\n`);
    },
  });

  stubs.push(server);

  return { origin: `http://localhost:${server.port}`, hits };
}

function installedHome(stamp: string, config: JsonObject = {}): string {
  const home = scratchDir('self-update-home');
  mkdirSync(join(home, 'cli', 'current'), { recursive: true });
  writeFileSync(join(home, 'cli', 'current', 'cli.js'), cliSource(stamp));
  writeFileSync(join(home, 'cli', 'current', 'package.json'), `${JSON.stringify({ version: stamp })}\n`);
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  return home;
}

async function runChild(home: string, script: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, '-e', script],
    cwd: repoRoot,
    env: { ...process.env, KINU_HOME: home, KINU_RELEASE_SIGNING_PUBLIC_KEY: (await signingKey).publicKeyHex },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function refresh(home: string, origin: string, served = SERVED): Promise<string | null> {
  const run = await runChild(home, `
    import { refreshCliTree } from './packages/cli/src/self-update.ts';
    try {
      await refreshCliTree(${JSON.stringify(origin)}, ${JSON.stringify(served)});
      console.log('ok');
    } catch (error) {
      console.log('failed: ' + (error instanceof Error ? error.message : String(error)));
    }
  `);

  if (run.exitCode !== 0) throw new Error(`child failed (${run.exitCode}): ${run.stderr}`);

  return run.stdout === 'ok' ? null : run.stdout;
}

const currentCli = (home: string) => readFileSync(join(home, 'cli', 'current', 'cli.js'), 'utf-8');

const cliEntries = (home: string) => readdirSync(join(home, 'cli')).sort();

describe('refreshCliTree stages, verifies and swaps', () => {
  const runtime = tarball({ 'node_modules/@nimbus-sh/runtime-cpython/manifest.json': '{}' });

  test('a good build lands with the rename pair: current is the new tree, prev the old one', async () => {
    const stub = startOrigin({ platform: tarball({ 'cli.js': cliSource(SERVED), 'package.json': '{}' }), runtime });
    const home = installedHome('1.0.0+old');
    const before = currentCli(home);

    expect(await refresh(home, stub.origin)).toBeNull();
    expect(currentCli(home)).toBe(cliSource(SERVED));
    expect(existsSync(join(home, 'cli', 'current', 'node_modules', '@nimbus-sh', 'runtime-cpython', 'manifest.json'))).toBe(true);
    expect(readFileSync(join(home, 'cli', 'prev', 'cli.js'), 'utf-8')).toBe(before);
    expect(cliEntries(home)).toEqual(['current', 'prev']);
    // Verified against the signed checksums, so the origin's .sha256 files are never fetched.
    expect(stub.hits).toEqual(['/downloads/kinu-version.json', PLATFORM_ARTIFACT, RUNTIME_ARTIFACT]);
  });

  test('a refresh for a build already installed adopts nothing and downloads nothing', async () => {
    // Two commands inside one probe window both spawn a refresh; the second must find the first's work under
    // the lock and stop, or it replaces prev with the fresh build.
    const stub = startOrigin({ platform: tarball({ 'cli.js': cliSource(SERVED), 'package.json': '{}' }), runtime });
    const home = installedHome('1.0.0+old');
    const before = currentCli(home);

    expect(await refresh(home, stub.origin)).toBeNull();
    const downloads = stub.hits.length;
    expect(await refresh(home, stub.origin)).toBeNull();

    expect(currentCli(home)).toBe(cliSource(SERVED));
    expect(readFileSync(join(home, 'cli', 'prev', 'cli.js'), 'utf-8')).toBe(before);
    expect(stub.hits).toHaveLength(downloads);
  });

  test('two refreshes at once take one lock: current is never absent and the build lands once', async () => {
    const stub = startOrigin({ platform: tarball({ 'cli.js': cliSource(SERVED), 'package.json': '{}' }), runtime });
    const home = installedHome('1.0.0+old');
    const before = currentCli(home);

    const [a, b] = await Promise.all([refresh(home, stub.origin), refresh(home, stub.origin)]);

    expect([a, b]).toEqual([null, null]);
    expect(currentCli(home)).toBe(cliSource(SERVED));
    expect(readFileSync(join(home, 'cli', 'prev', 'cli.js'), 'utf-8')).toBe(before);
    expect(cliEntries(home)).toEqual(['current', 'prev']);
    expect(stub.hits.filter((hit) => hit === PLATFORM_ARTIFACT)).toHaveLength(1);
  });

  test('an unsigned manifest, or one signed by another key, downloads nothing (C1)', async () => {
    // Without Kinu's signature over the checksums the refresh fetches no artifact.
    for (const signing of ['none', 'foreign'] as const) {
      const stub = startOrigin({ platform: tarball({ 'cli.js': cliSource(SERVED), 'package.json': '{}' }), runtime, signing });
      const home = installedHome('1.0.0+old');
      const before = currentCli(home);

      expect(await refresh(home, stub.origin)).toMatch(/^failed: .*(carries no signature|does not verify)/);
      expect(currentCli(home)).toBe(before);
      expect(cliEntries(home)).toEqual(['current']);
      expect(stub.hits.filter((hit) => hit.startsWith('/downloads/') && hit !== '/downloads/kinu-version.json')).toEqual([]);
    }
  });

  test('a corrupt tarball (checksum mismatch) leaves current byte-identical and nothing staged', async () => {
    const stub = startOrigin({ platform: tarball({ 'cli.js': cliSource(SERVED) }), runtime, corrupt: true });
    const home = installedHome('1.0.0+old');
    const before = currentCli(home);

    expect(await refresh(home, stub.origin)).toContain(`checksum mismatch for ${PLATFORM_ARTIFACT}`);
    expect(currentCli(home)).toBe(before);
    expect(cliEntries(home)).toEqual(['current']);
  });

  test('a staged build whose --version is not the served stamp is refused; current untouched', async () => {
    const stub = startOrigin({ platform: tarball({ 'cli.js': cliSource('9.9.9+other') }), runtime });
    const home = installedHome('1.0.0+old');
    const before = currentCli(home);

    expect(await refresh(home, stub.origin)).toContain('reports 9.9.9+other, not the served 9.9.9+served');
    expect(currentCli(home)).toBe(before);
    expect(cliEntries(home)).toEqual(['current']);
  });

  test('an archive without cli.js is refused before anything moves', async () => {
    const stub = startOrigin({ platform: tarball({ 'README': 'no cli here' }), runtime });
    const home = installedHome('1.0.0+old');
    const before = currentCli(home);

    expect(await refresh(home, stub.origin)).toContain('carries no cli.js');
    expect(currentCli(home)).toBe(before);
    expect(cliEntries(home)).toEqual(['current']);
  });

  test('a tree staged earlier for the served stamp is adopted without a download', async () => {
    const stub = startOrigin({ platform: tarball({ 'cli.js': cliSource(SERVED) }), runtime });
    const home = installedHome('1.0.0+old');
    const staged = join(home, 'cli', 'next-9.9.9-served');
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, 'cli.js'), cliSource(SERVED));

    expect(await refresh(home, stub.origin)).toBeNull();
    expect(currentCli(home)).toBe(cliSource(SERVED));
    expect(stub.hits).toEqual([]);
    expect(cliEntries(home)).toEqual(['current', 'prev']);
  });
});

/** The refresh spawn is a counter: whether a refresh starts is the observable. */
async function startupCheck(home: string, opts: { isTTY: boolean; origin: string }) {
  const run = await runChild(home, `
    import { runStartupUpdateCheck } from './packages/cli/src/version-check.ts';
    const lines = [];
    let spawned = 0;
    const outcome = await runStartupUpdateCheck({
      log: (line) => lines.push(line),
      isTTY: ${opts.isTTY},
      now: ${NOW},
      spawnRefresh: () => { spawned += 1; },
    });
    console.log(JSON.stringify({ lines, outcome, spawned }));
  `);

  if (run.exitCode !== 0) throw new Error(`child failed (${run.exitCode}): ${run.stderr}`);

  return v.parse(v.object({ lines: v.array(v.string()), outcome: v.nullable(v.string()), spawned: v.number() }), JSON.parse(run.stdout));
}

describe('the startup check starts a refresh only when every gate opens', () => {
  const runtime = tarball({ 'node_modules/.keep': '' });

  const newerOrigin = () => startOrigin({ platform: tarball({ 'cli.js': cliSource(SERVED) }), runtime });

  test('a newer served build on a TTY starts one refresh and prints the one line', async () => {
    const stub = newerOrigin();
    const home = installedHome('1.0.0+old', { origin: stub.origin, accessToken: 'ptc_test', updateCheckedAt: 0 });

    const { lines, outcome, spawned } = await startupCheck(home, { isTTY: true, origin: stub.origin });
    expect(spawned).toBe(1);
    expect(outcome).toBe(`Installing Kinu ${SERVED} in the background; it applies on the next launch.`);
    expect(lines).toEqual([`Installing Kinu ${SERVED} in the background; it applies on the next launch.`]);
    expect(stub.hits).toEqual(['/downloads/kinu-version.json']);
  });

  test('non-TTY: no probe, no refresh', async () => {
    const stub = newerOrigin();
    const home = installedHome('1.0.0+old', { origin: stub.origin, accessToken: 'ptc_test', updateCheckedAt: 0 });

    expect(await startupCheck(home, { isTTY: false, origin: stub.origin })).toEqual({ lines: [], outcome: null, spawned: 0 });
    expect(stub.hits).toEqual([]);
  });

  test('updateCheck: false: no probe, no refresh', async () => {
    const stub = newerOrigin();
    const home = installedHome('1.0.0+old', { origin: stub.origin, accessToken: 'ptc_test', updateCheckedAt: 0, updateCheck: false });

    expect(await startupCheck(home, { isTTY: true, origin: stub.origin })).toEqual({ lines: [], outcome: null, spawned: 0 });
    expect(stub.hits).toEqual([]);
  });

  test('inside the 24h throttle window: no probe, no refresh', async () => {
    const stub = newerOrigin();
    const home = installedHome('1.0.0+old', { origin: stub.origin, accessToken: 'ptc_test', updateCheckedAt: NOW - 60_000 });

    expect(await startupCheck(home, { isTTY: true, origin: stub.origin })).toEqual({ lines: [], outcome: null, spawned: 0 });
    expect(stub.hits).toEqual([]);
  });

  test('the installed build being the served one: a probe, and no refresh', async () => {
    const home = installedHome('1.0.0+old', { origin: 'https://example.test', accessToken: 'ptc_test', updateCheckedAt: 0 });

    const run = await runChild(home, `
      import { runStartupUpdateCheck } from './packages/cli/src/version-check.ts';
      import { VERSION } from './packages/cli/src/display.ts';
      let spawned = 0;
      const outcome = await runStartupUpdateCheck({
        log: () => {},
        isTTY: true,
        now: ${NOW},
        fetchImpl: async () => Response.json({ version: VERSION }),
        spawnRefresh: () => { spawned += 1; },
      });
      console.log(JSON.stringify({ outcome, spawned }));
    `);

    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ outcome: null, spawned: 0 });
  });
});
