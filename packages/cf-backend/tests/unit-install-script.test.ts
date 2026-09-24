/**
 * install.sh under `curl | bash` (stdin is the script, maybe no /dev/tty) must never freeze on the terminal, and the
 * launcher must run the Bun the installer verified: both inline one resolution (`src/cli/bun-runtime.ts`).
 */
import { scratchDir } from '../../test-utils/src/scratch';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { tolerate } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { handleCliRequest } from '../src/cli/routes';
import { staticRouteCliEnv } from './helpers/bindings';
import { buildCliInstallCommand } from '@kinu.run/core';
import { bunResolutionShell } from '@kinu.run/core';
import { CLI_DIST_PATHS, RELEASE_SIGNING_PUBLIC_KEY, generateReleaseSigningKey, signRelease } from '@kinu.run/core';

const ORIGIN = 'https://kinu.example.com';

interface InstallSandbox {
  home: string;
  stubBin: string;
  /** Every path a stub Bun was invoked through, one per line. */
  bunLog: string;
  /** Where the installer puts the Bun it installs itself. */
  managedBun: string;
}

interface SandboxOptions {
  /** Version the `bun` on PATH reports. `null` leaves the machine without one. */
  ambientBun?: string | null;
  /** Served at `<origin>/downloads/kinu`; defaults to a stub answering `--help` and `setup`. */
  launcher?: string;
}

const PtyResultSchema = v.object({
  output: v.string(),
  exitcode: v.nullable(v.number()),
  post: v.object({
    icanon: v.boolean(),
    echo: v.boolean(),
    isig: v.boolean(),
  }),
});

async function servedScript(path: string): Promise<string> {
  const response = await handleCliRequest(new Request(`${ORIGIN}${path}`), staticRouteCliEnv());

  if (!response) throw new Error(`${path} was not handled`);
  expect(response.status).toBe(200);

  return response.text();
}

/** Read from the rendered resolution, not imported: the served text is the contract both scripts ship. */
function approvedBun(): string {
  const match = /KINU_BUN_VERSION="([^"]+)"/.exec(bunResolutionShell());

  if (!match) throw new Error('rendered resolution names no KINU_BUN_VERSION');

  return match[1];
}

/** A Bun stand-in that logs the path it was invoked through, proving which binary ran. */
function bunStub(version: string, logPath: string): string {
  return [
    '#!/bin/sh',
    `printf '%s\\n' "$0" >> "${logPath}"`,
    `if [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi`,
    // The launcher's release-signature check runs for real on this suite's own Bun.
    `if [ "$1" = "-e" ]; then exec "${process.execPath}" "$@"; fi`,
    'if [ "$1" = "run" ]; then printf \'  setup   connect your account\\n\'; exit 0; fi',
    'exit 0',
    '',
  ].join('\n');
}

/** Minted once per process; launcher runs pin its public half through the environment. */
const signingKey = await generateReleaseSigningKey();

const RELEASE_ENV = { KINU_RELEASE_SIGNING_PUBLIC_KEY: signingKey.publicKeyHex };

/** Archives shaped like the published ones; the launcher verifies the signed manifest over both checksums first. */
async function makeDistTarballs(home: string): Promise<void> {
  const stage = join(home, 'stage');
  mkdirSync(join(stage, 'kinu'), { recursive: true });
  writeFileSync(join(stage, 'kinu/cli.js'), 'process.stdout.write("stub\\n");\n');
  mkdirSync(join(stage, 'runtime/kinu/node_modules/@nimbus-sh/runtime-cpython'), { recursive: true });
  writeFileSync(
    join(stage, 'runtime/kinu/node_modules/@nimbus-sh/runtime-cpython/manifest.json'),
    '{"name":"cpython","files":[]}\n',
  );

  for (const [name, from, member] of [
    ['cli.tar.gz', stage, 'kinu'],
    ['runtime.tar.gz', join(stage, 'runtime'), 'kinu'],
  ] as const) {
    const tarball = join(home, name);
    const tar = spawnSync('tar', ['-czf', tarball, '-C', from, member], { encoding: 'utf8' });

    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
    const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    writeFileSync(`${tarball}.sha256`, `${digest}  ${name}\n`);
  }

  const artifactOf = (name: string) => (name === 'cli.tar.gz' ? `/downloads/kinu-cli-${process.platform}-${process.arch}.tar.gz` : '/downloads/kinu-runtime-cpython.tar.gz');

  const checksums = Object.fromEntries(['cli.tar.gz', 'runtime.tar.gz'].map((name) => [
    artifactOf(name), readFileSync(join(home, `${name}.sha256`), 'utf-8').trim().split(/\s+/)[0] ?? '',
  ]));

  const signed = await signRelease('1.0.0+test', checksums, signingKey.privateKeyPkcs8Base64);
  writeFileSync(join(home, 'kinu-version.json'), `${JSON.stringify({ sha: 'test', builtAt: 'now', ...signed })}\n`);
}

/** Sandbox HOME plus stub curl/bun/ln, so the script runs without network or system side effects. */
async function makeSandbox(options: SandboxOptions = {}): Promise<InstallSandbox> {
  const ambientBun = options.ambientBun === undefined ? approvedBun() : options.ambientBun;
  const home = scratchDir('install-test');
  const stubBin = join(home, 'stub-bin');
  mkdirSync(stubBin);
  const bunLog = join(home, 'bun-invocations.log');

  const stubShim = [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then printf "  setup   connect your account\\n"; exit 0; fi',
    'if [ "$1" = "setup" ]; then echo "STUB-SETUP-RAN"; exit 0; fi',
    'if [ "$1" = "connect" ]; then echo "STUB-CONNECT-RAN $*"; exit 0; fi',
    'exit 0',
  ].join('\n');

  writeFileSync(join(home, 'stub-shim.sh'), `${stubShim}\n`);
  writeFileSync(join(home, 'launcher'), options.launcher ?? `${stubShim}\n`);

  // Stand-in for https://bun.sh/install. Requires $BUN_INSTALL rather than defaulting to $HOME/.bun,
  // so it can never overwrite the developer's own Bun.
  writeFileSync(join(home, 'bun-stub-template'), bunStub('__BUN_VERSION__', bunLog));

  const bunInstaller = [
    '#!/bin/sh',
    'version="${1#bun-v}"',
    '[ -n "$version" ] || { echo "no bun version tag" >&2; exit 1; }',
    `dir="\${BUN_INSTALL:?the installer must target its own runtime dir}/bin"`,
    `case "$dir" in "${home}"/*) ;; *) echo "refusing to install outside $dir" >&2; exit 1 ;; esac`,
    'mkdir -p "$dir"',
    `sed "s/__BUN_VERSION__/$version/g" "${home}/bun-stub-template" > "$dir/bun"`,
    'chmod 755 "$dir/bun"',
  ].join('\n');

  writeFileSync(join(home, 'bun-installer.sh'), `${bunInstaller}\n`);

  await makeDistTarballs(home);

  const curl = [
    '#!/usr/bin/env bash',
    '# stub curl: `curl -fsSL <url> [-o <file>]`, routed by URL.',
    'out=""',
    'url=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -o) shift; out="$1" ;;',
    '    http*) url="$1" ;;',
    '  esac',
    '  shift',
    'done',
    'case "$url" in',
    `  *bun.sh/install*) cat "${home}/bun-installer.sh"; exit 0 ;;`,
    `  *kinu-version.json)`,
    '    [ -n "$out" ] || exit 1',
    `    cat "${home}/kinu-version.json" > "$out"; exit 0 ;;`,
    `  *kinu-runtime-cpython.tar.gz.sha256) cat "${home}/runtime.tar.gz.sha256"; exit 0 ;;`,
    '  *kinu-runtime-cpython.tar.gz)',
    '    [ -n "$out" ] || exit 1',
    `    cat "${home}/runtime.tar.gz" > "$out"; exit 0 ;;`,
    `  *kinu-cli-*.tar.gz.sha256) cat "${home}/cli.tar.gz.sha256"; exit 0 ;;`,
    '  *kinu-cli-*.tar.gz)',
    '    [ -n "$out" ] || exit 1',
    `    cat "${home}/cli.tar.gz" > "$out"; exit 0 ;;`,
    'esac',
    `if [ -n "$out" ]; then cat "${home}/launcher" > "$out"; exit 0; fi`,
    'cat "$HOME/install.sh"',
  ].join('\n');

  writeFileSync(join(stubBin, 'curl'), `${curl}\n`);
  chmodSync(join(stubBin, 'curl'), 0o755);

  if (ambientBun !== null) {
    writeFileSync(join(stubBin, 'bun'), bunStub(ambientBun, bunLog));
    chmodSync(join(stubBin, 'bun'), 0o755);
  }

  return { home, stubBin, bunLog, managedBun: join(home, '.kinu/runtime/bin/bun') };
}

/** Runs the script like `curl | bash` in a detached session: stdin is the pipe, /dev/tty cannot open. */
function runHeadlessInstall(
  script: string,
  home: string,
  stubBin: string,
  extraEnv: Record<string, string> = {},
): Promise<{
  exitCode: number | null; output: string; timedOut: boolean;
}> {
  const { promise, resolve } = Promise.withResolvers<{
    exitCode: number | null; output: string; timedOut: boolean;
  }>();

  const child = spawn('bash', [], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      HOME: home,
      KINU_HOME: join(home, '.kinu'),
      PATH: `${stubBin}:/usr/bin:/bin`,
      SHELL: '/bin/bash',
      ...RELEASE_ENV,
      ...extraEnv,
    },
  });

  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  child.stdin.end(script);

  const childPid = child.pid;

  if (childPid === undefined) {
    resolve({ exitCode: null, output, timedOut: true });

    return promise;
  }

  const timer = setTimeout(() => {
    tolerate(() => process.kill(-childPid, 'SIGKILL'), 'esrch');
    resolve({ exitCode: null, output, timedOut: true });
  }, 20_000);

  child.on('exit', (code) => {
    clearTimeout(timer);
    resolve({ exitCode: code, output, timedOut: false });
  });

  return promise;
}

describe('install.sh terminal handling', () => {
  test('headless curl|bash prints setup instructions and exits 0 — never opens /dev/tty', async () => {
    const script = await servedScript('/install.sh');
    const { home, stubBin } = await makeSandbox();
    const result = await runHeadlessInstall(script, home, stubBin);

    expect(result.timedOut).toBe(false);
    expect(result.output).toContain('Kinu installed.');
    expect(result.output).toContain('Setup was not started because no interactive terminal is attached.');
    expect(result.output).toContain(`setup --origin ${ORIGIN}`);
    expect(result.output).toContain('Kinu CLI is ready.');
    expect(result.output).not.toContain('STUB-SETUP-RAN');
    expect(result.output).not.toContain('/dev/tty');
    expect(result.exitCode).toBe(0);
  });

  test('the canonical install command is one pipeline, and kinu runs in the calling shell right after it', async () => {
    const script = await servedScript('/install.sh');
    const { home, stubBin } = await makeSandbox();
    writeFileSync(join(home, 'install.sh'), script);
    const install = buildCliInstallCommand({ origin: ORIGIN, setup: false });
    expect(install).toBe(`curl -fsSL '${ORIGIN}/install.sh' | bash -s -- --no-setup`);

    // The calling shell's PATH lists ~/.local/bin, as a Fedora login shell does always and an Ubuntu one does once
    // the directory exists. The installer is that shell's child, so a directory the caller searches is its only reach.
    const localBin = join(home, '.local/bin');

    const run = spawnSync('bash', ['-c', [
      install,
      'printf "RESOLVED=%s\\n" "$(command -v kinu)"',
      'kinu --help',
    ].join('\n')], {
      encoding: 'utf8',
      env: { HOME: home, KINU_HOME: join(home, '.kinu'), PATH: `${localBin}:${stubBin}:/usr/bin:/bin`, SHELL: '/bin/bash', ...RELEASE_ENV },
    });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`RESOLVED=${join(localBin, 'kinu')}\n`);
    expect(run.stdout).toContain('setup   connect your account');
    expect(run.stdout).not.toContain('To use kinu in this shell now');
  });

  test('with no linkable directory on the calling PATH, the script prints the export that activates it', async () => {
    const script = await servedScript('/install.sh');
    const { home, stubBin } = await makeSandbox();
    writeFileSync(join(home, 'install.sh'), script);
    const install = buildCliInstallCommand({ origin: ORIGIN, setup: false });
    const binDir = join(home, '.kinu/bin');

    const run = spawnSync('bash', ['-c', [
      install,
      'printf "BEFORE=%s\\n" "$(command -v kinu)"',
    ].join('\n')], {
      encoding: 'utf8',
      env: { HOME: home, KINU_HOME: join(home, '.kinu'), PATH: `${stubBin}:/usr/bin:/bin`, SHELL: '/bin/bash', ...RELEASE_ENV },
    });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('BEFORE=\n');
    expect(run.stdout).toContain('To use kinu in this shell now, run:');

    const hint = run.stdout.split('\n').map((line) => line.trim())
      .find((line) => line.startsWith('export PATH='));

    expect(hint).toBe(`export PATH="${binDir}:$PATH"`);

    const activated = spawnSync('bash', ['-c', [hint ?? '', 'command -v kinu', 'kinu --help'].join('\n')], {
      encoding: 'utf8',
      env: { HOME: home, KINU_HOME: join(home, '.kinu'), PATH: `${stubBin}:/usr/bin:/bin`, SHELL: '/bin/bash', ...RELEASE_ENV },
    });

    expect(activated.status, activated.stderr).toBe(0);
    expect(activated.stdout).toContain(join(home, '.kinu/bin/kinu'));
    expect(activated.stdout).toContain('setup   connect your account');
  });

  test('--connect pairs the machine from inside the installer, before the PATH hint', async () => {
    const script = await servedScript('/install.sh');
    const { home, stubBin } = await makeSandbox();

    const install = buildCliInstallCommand({
      origin: ORIGIN, setup: false, connect: true, label: "Ashish's Mac",
    });

    expect(install).toContain("--connect --label 'Ashish'\\''s Mac'");
    writeFileSync(join(home, 'install.sh'), script);

    const run = spawnSync('bash', ['-c', install], {
      encoding: 'utf8',
      env: { HOME: home, KINU_HOME: join(home, '.kinu'), PATH: `${stubBin}:/usr/bin:/bin`, SHELL: '/bin/bash', ...RELEASE_ENV },
    });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("STUB-CONNECT-RAN connect --label Ashish's Mac");
    expect(run.stdout).not.toContain('STUB-SETUP-RAN');
    expect(run.stdout.indexOf('STUB-CONNECT-RAN'))
      .toBeLessThan(run.stdout.indexOf('To use kinu in this shell now'));
  });

  test('interactive steps gate on actually opening /dev/tty and restore the terminal on failure', async () => {
    const script = await servedScript('/install.sh');
    // Permission probes ([ -r /dev/tty ]) pass without a controlling
    // terminal; only a real open proves the redirects below will work.
    expect(script).toContain('( exec </dev/tty >/dev/tty ) 2>/dev/null');
    expect(script).not.toContain('[ -r /dev/tty ]');
    expect(script).toContain('"$@" < /dev/tty');
    expect(script).toContain('stty sane < /dev/tty 2>/dev/null || true');
    expect(script).toContain('run_on_tty "$BIN_PATH" setup --origin "$KINU_ORIGIN" --account-only');
    expect(script).toContain('run_on_tty "$BIN_PATH" connect');
    // Under curl|bash a stdin-reading child would eat unread script bytes.
    expect(script).toContain('KINU_REFRESH_ONLY=1 "$BIN_PATH" </dev/null');
  });

  test('a CLI that dies in raw mode leaves the terminal sane after the served script exits', async () => {
    const python = Bun.which('python3');

    if (!python) return; // PTY harness needs python3
    const script = await servedScript('/install.sh');
    const { home, stubBin } = await makeSandbox();
    // Hostile stub: setup wrecks the terminal (raw, no echo) and fails.
    writeFileSync(join(home, 'launcher'), [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then printf "  setup   connect your account\\n"; exit 0; fi',
      'if [ "$1" = "setup" ]; then stty raw -echo isig 2>/dev/null; echo "STUB-SETUP-DIED"; exit 1; fi',
      'exit 0',
      '',
    ].join('\n'));

    const scriptPath = join(home, 'install.sh');
    writeFileSync(scriptPath, script);
    const harnessPath = join(home, 'pty-harness.py');
    writeFileSync(harnessPath, PTY_HARNESS);

    const run = spawnSync(python, [harnessPath, scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        KINU_HOME: join(home, '.kinu'),
        PATH: `${stubBin}:/usr/bin:/bin`,
        SHELL: '/bin/bash',
        // This runner inherits the ambient environment; an exported BUN_INSTALL must not reach the script.
        BUN_INSTALL: '',
      },
    });

    expect(run.status).toBe(0);
    const lastLine = run.stdout.trim().split('\n').at(-1);

    if (!lastLine) throw new Error('PTY harness emitted no result');
    const result = v.parse(PtyResultSchema, JSON.parse(lastLine));
    expect(result.output).toContain('STUB-SETUP-DIED');
    expect(result.exitcode).not.toBe(0);
    expect(result.post).toEqual({ icanon: true, echo: true, isig: true });
  });
});

/** Built at deploy time. A source install measured cold 2026-09-01: 13.35 s of a 16.08 s install, 950 packages, 1.9 GB. */
describe('the CLI installs as a prebuilt artifact', () => {
  test('the launcher unpacks published builds and runs no package manager', async () => {
    const launcher = await servedScript('/downloads/kinu');
    expect(launcher).toContain('/downloads/kinu-cli-${KINU_OS}-${KINU_ARCH}.tar.gz');
    expect(launcher).toContain('RUNTIME_URL="${KINU_ORIGIN}/downloads/kinu-runtime-cpython.tar.gz"');
    expect(launcher).toContain(`KINU_ORIGIN="\${KINU_ORIGIN:-${ORIGIN}}"`);
    expect(launcher).not.toContain('bun install');
    expect(launcher).not.toContain('--frozen-lockfile');
    expect(launcher).not.toContain('node_modules');
    // Staging tree beside the install; the swap keeps prev until the proven tree is in place
    // (unit-cli-launcher-swap drives those states).
    expect(launcher).toContain('mv "$tmp/extract/kinu" "$next"');
    expect(launcher).toContain('"$KINU_BUN" run "$next/cli.js" --version');
    expect(launcher).toContain('mv "$CLI_DIR" "$CLI_ROOT/prev"');
    expect(launcher).toContain('adopt_tree "$next"');
    expect(launcher).toContain('mv "$proven" "$CLI_DIR"');
    expect(launcher.split('rm -rf "$CLI_DIR"').length - 1).toBe(3);
  });

  test('every platform the launcher can name has a published artifact', async () => {
    const launcher = await servedScript('/downloads/kinu');
    // A pair the launcher accepts but the deploy never publishes would unpack a 404 body as a tarball.
    const named = new Set<string>();

    for (const [unameS, os] of [['Darwin', 'darwin'], ['Linux', 'linux']] as const) {
      expect(launcher).toContain(`${unameS}) KINU_OS=${os} ;;`);

      for (const arch of ['arm64', 'x64']) named.add(`${os}-${arch}`);
    }

    expect(launcher).toContain('arm64|aarch64) KINU_ARCH=arm64 ;;');
    expect(launcher).toContain('x86_64|amd64) KINU_ARCH=x64 ;;');

    // Read off the paths production serves, not a private list.
    const published = CLI_DIST_PATHS.flatMap((path) => {
      const match = /\/downloads\/kinu-cli-([a-z0-9-]+)\.tar\.gz$/.exec(path);

      return match ? [match[1]] : [];
    });

    expect([...named].sort()).toEqual([...published].sort());
    expect(launcher).toContain('Kinu supports macOS and Linux.');
    expect(launcher).toContain('Kinu supports arm64 and x86_64.');
  });

  test('every download is checksum-verified against the SIGNED release, with no way to skip it', async () => {
    const launcher = await servedScript('/downloads/kinu');
    // Signature against the pinned key before any fetch; artifacts against the signed checksums, never the origin's .sha256 (C1).
    expect(launcher).toContain('verify_release "$tmp/kinu-version.json"');
    expect(launcher).toContain('fetch_verified "$TARBALL_URL" "$tmp/cli.tar.gz" "$tmp/kinu-version.json"');
    expect(launcher).toContain('fetch_verified "$RUNTIME_URL" "$tmp/runtime.tar.gz" "$tmp/kinu-version.json"');
    expect(launcher).toContain(`RELEASE_SIGNING_PUBLIC_KEY="\${KINU_RELEASE_SIGNING_PUBLIC_KEY:-${RELEASE_SIGNING_PUBLIC_KEY}}"`);
    expect(launcher).not.toContain('curl -fsSL "$url.sha256"');
    expect(launcher).toContain('[ "$actual" = "$expected" ] || die "Checksum mismatch for $url."');
    // No environment variable can turn verification off.
    expect(launcher).not.toContain('KINU_SOURCE_SHA256');
    expect(launcher).not.toContain('KINU_CLI_SHA256');
  });

  test('a release the pinned key did not sign is refused before any artifact lands (C1)', async () => {
    const script = await servedScript('/install.sh');
    const launcher = await servedScript('/downloads/kinu');
    const { home, stubBin } = await makeSandbox({ ambientBun: null, launcher });
    // Same artifacts and checksums, manifest without Kinu's signature.
    const manifest = v.parse(v.looseObject({ signature: v.string() }), JSON.parse(readFileSync(join(home, 'kinu-version.json'), 'utf-8')));
    const { signature: _signature, ...unsigned } = manifest;
    writeFileSync(join(home, 'kinu-version.json'), `${JSON.stringify(unsigned)}\n`);

    const result = await runHeadlessInstall(script, home, stubBin);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('not one this launcher trusts');
    expect(existsSync(join(home, '.kinu/cli/current/cli.js'))).toBe(false);
  });

  test('a fresh install downloads a build and never runs an installer on the machine', async () => {
    const script = await servedScript('/install.sh');
    const launcher = await servedScript('/downloads/kinu');
    const { home, stubBin } = await makeSandbox({ ambientBun: null, launcher });
    const result = await runHeadlessInstall(script, home, stubBin);

    expect(result.timedOut).toBe(false);
    expect(result.output).toContain('Downloading Kinu CLI...');
    expect(result.output).not.toContain('Preparing Kinu CLI...');
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, '.kinu/cli/current/cli.js'))).toBe(true);
    expect(existsSync(
      join(home, '.kinu/cli/current/node_modules/@nimbus-sh/runtime-cpython/manifest.json'),
    )).toBe(true);
    expect(existsSync(join(home, '.kinu/source'))).toBe(false);
  });
});

/** Pins: installer said "Kinu CLI is ready.", next `kinu` said "Bun is required." because the scripts resolved Bun independently. */
describe('Bun runtime resolution is one source of truth', () => {
  test('the approved Bun is the version this repository itself pins', () => {
    const manifest = readFileSync(join(import.meta.dir, '../../../package.json'), 'utf8');
    const pin = v.parse(v.object({ packageManager: v.string() }), JSON.parse(manifest)).packageManager;
    expect(pin).toBe(`bun@${approvedBun()}`);
    const minKey = /KINU_BUN_MIN_KEY=(\d+)/.exec(bunResolutionShell())?.[1];
    expect(Number(minKey)).toBeGreaterThan(0);
  });

  test('only the launcher resolves and provides Bun; the installer never probes it', async () => {
    const shared = bunResolutionShell();
    const install = await servedScript('/install.sh');
    const launcher = await servedScript('/downloads/kinu');

    expect(launcher).toContain(shared);
    // A second probe is the defect: two answers to one question.
    expect(launcher.split('command -v bun').length - 1).toBe(shared.split('command -v bun').length - 1);
    expect(install).not.toContain('command -v bun');
    expect(install).not.toContain('bun.sh/install');
    expect(launcher).toContain('exec "$KINU_BUN" run "$CLI_DIR/cli.js" "$@"');
  });

  /**
   * Built as a TS template literal, shipped as bash. A stray `\$` renders identically (the linter owns that class);
   * this guards a double escape `\\$`, which ships a literal dollar and silently breaks every candidate.
   */
  test('the emitted resolution expands shell variables, and escapes none of them', async () => {
    const shared = bunResolutionShell();
    expect(shared).not.toContain('\\$');
    expect(await servedScript('/downloads/kinu')).not.toContain('\\$');
    // install.sh's one legitimate escape is the PROFILE line's literal `$PATH`; a stray one anywhere else fails here.
    const escaped = (await servedScript('/install.sh')).split('\n').filter((line) => line.includes('\\$'));
    expect(escaped.length).toBeGreaterThan(0);
    expect(escaped.filter((line) => !line.includes('PATH'))).toEqual([]);

    for (const expansion of [
      '"$KINU_MANAGED_BUN"',
      '"$(command -v bun 2>/dev/null || true)"',
      '"$HOME/.bun/bin/bun"',
      '"${1%%.*}"',
      '"${kb_rest#*.}"',
      '"$(( kb_major * 1000000 + kb_minor * 1000 + kb_patch ))"',
      '[ "$kc_key" -ge "$KINU_BUN_MIN_KEY" ]',
    ]) {
      expect(shared).toContain(expansion);
    }
  });

  test('the emitted parameter expansions compute a real version key', () => {
    // Behavioural: a mis-escaped expansion would hand the arithmetic literal text instead of digits.
    const script = `${bunResolutionShell()}\nkinu_bun_key "$1"\n`;

    for (const [version, key] of [
      ['1.4.0', '1004000'],
      ['1.9.2', '1009002'],
      ['1.4.0-canary.20260101', '1004000'],
      ['2.0.13', '2000013'],
    ]) {
      const run = spawnSync('bash', ['-c', script, 'kinu', version], { encoding: 'utf8' });
      expect(run.status, `${version}: ${run.stderr}`).toBe(0);
      expect(run.stdout.trim()).toBe(key);
    }

    for (const bad of ['1.4', 'not-a-version', '']) {
      const run = spawnSync('bash', ['-c', script, 'kinu', bad], { encoding: 'utf8' });
      expect(run.status, `${bad} should not be comparable`).toBe(1);
      expect(run.stdout.trim()).toBe('');
    }
  });

  test('a candidate that is not an absolute path is refused', () => {
    // `command -v` answers a bare word for functions/builtins, and a bare word resolves against the cwd:
    // a `bun` file in the user's directory must never become the runtime.
    const cwd = scratchDir('bun-cwd');

    const decoy = join(cwd, 'bun');
    writeFileSync(decoy, `#!/bin/sh\nprintf '%s\\n' '${approvedBun()}'\n`);
    chmodSync(decoy, 0o755);

    const probe = spawnSync('bash', ['-c', [
      'set -eu',
      'KINU_HOME="$PWD/.kinu"',
      bunResolutionShell(),
      'if kinu_bun_compatible bun; then echo TOOK-RELATIVE; else echo REFUSED; fi',
      'if kinu_bun_compatible "$PWD/bun"; then echo TOOK-ABSOLUTE; else echo REFUSED-ABSOLUTE; fi',
    ].join('\n')], { cwd, encoding: 'utf8' });

    expect(probe.stdout).toContain('REFUSED');
    expect(probe.stdout).not.toContain('TOOK-RELATIVE');
    expect(probe.stdout).toContain('TOOK-ABSOLUTE');
  });

  test('an existing compatible Bun is used as it is, and nothing is downloaded', async () => {
    const script = await servedScript('/install.sh');
    const launcher = await servedScript('/downloads/kinu');
    const { home, stubBin, managedBun } = await makeSandbox({ ambientBun: '1.9.2', launcher });
    const result = await runHeadlessInstall(script, home, stubBin);

    expect(result.timedOut).toBe(false);
    expect(result.output).toContain(`Using Bun 1.9.2 at ${join(stubBin, 'bun')}.`);
    expect(result.output).not.toContain('Installing Bun');
    expect(existsSync(managedBun)).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  test('a Bun older than the approved one is not accepted, and the approved one is installed once', async () => {
    const script = await servedScript('/install.sh');
    const launcher = await servedScript('/downloads/kinu');
    const { home, stubBin, managedBun } = await makeSandbox({ ambientBun: '1.1.45', launcher });
    const result = await runHeadlessInstall(script, home, stubBin);

    expect(result.timedOut).toBe(false);
    expect(result.output).toContain(`Installing Bun ${approvedBun()}...`);
    expect(result.output).toContain(`Using Bun ${approvedBun()} at ${managedBun}.`);
    expect(existsSync(managedBun)).toBe(true);
    expect(result.output.split(`Installing Bun ${approvedBun()}...`).length - 1).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  test('KINU_INSTALL_BUN=0 names the version it needs instead of installing one', async () => {
    const script = await servedScript('/install.sh');
    const launcher = await servedScript('/downloads/kinu');
    const { home, stubBin, managedBun } = await makeSandbox({ ambientBun: null, launcher });
    const result = await runHeadlessInstall(script, home, stubBin, { KINU_INSTALL_BUN: '0' });

    expect(result.output).toContain(`Bun ${approvedBun()} or newer is required.`);
    expect(existsSync(managedBun)).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  test('the launcher runs the Bun the installer verified, in a later shell with no bun on PATH', async () => {
    const script = await servedScript('/install.sh');
    const launcher = await servedScript('/downloads/kinu');
    const { home, stubBin, bunLog, managedBun } = await makeSandbox({ ambientBun: null, launcher });
    const install = await runHeadlessInstall(script, home, stubBin);

    expect(install.timedOut).toBe(false);
    expect(install.output).toContain(`Installing Bun ${approvedBun()}...`);
    expect(install.output).toContain('Kinu CLI is ready.');
    expect(install.exitCode).toBe(0);

    // A fresh shell with no bun on PATH: a PATH-resolved Bun would say "Bun is required."
    const later = spawnSync(join(home, '.kinu/bin/kinu'), ['--help'], {
      encoding: 'utf8',
      env: {
        HOME: home,
        KINU_HOME: join(home, '.kinu'),
        PATH: `${stubBin}:/usr/bin:/bin`,
        SHELL: '/bin/bash',
        ...RELEASE_ENV,
      },
    });

    expect(`${later.stdout}${later.stderr}`).not.toContain('Bun is required');
    expect(later.status, later.stderr).toBe(0);
    expect(later.stdout).toContain('setup   connect your account');
    const invocations = readFileSync(bunLog, 'utf8').trim().split('\n');
    expect(invocations.length).toBeGreaterThan(1);
    expect(invocations.filter((path) => path !== managedBun)).toEqual([]);
  });
});

/** Runs `bash < install.sh` with a PTY controlling terminal and stdin on a pipe (the `curl | bash` topology), then reports termios. */
const PTY_HARNESS = `
import json, os, pty, sys, time, fcntl, termios, signal, select

script = open(sys.argv[1], "rb").read()
master, slave = pty.openpty()
pipe_r, pipe_w = os.pipe()
pid = os.fork()
if pid == 0:
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(pipe_r, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(master)
    os.close(pipe_w)
    os.execvp("bash", ["bash"])
os.close(slave)
os.close(pipe_r)
os.write(pipe_w, script)
os.close(pipe_w)

output = b""
exitcode = None
deadline = time.time() + 30
while time.time() < deadline:
    ready, _, _ = select.select([master], [], [], 0.2)
    if ready:
        try:
            chunk = os.read(master, 4096)
            if chunk:
                output += chunk
        except OSError:
            pass
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        exitcode = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
        break
if exitcode is None:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)

flag = termios.tcgetattr(master)[3]
print(json.dumps({
    "output": output.decode(errors="replace"),
    "exitcode": exitcode,
    "post": {
        "icanon": bool(flag & termios.ICANON),
        "echo": bool(flag & termios.ECHO),
        "isig": bool(flag & termios.ISIG),
    },
}))
`;
