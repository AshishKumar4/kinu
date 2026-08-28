/**
 * Behavioral regression tests for the served install.sh: under `curl | bash`
 * stdin is the script stream, not the terminal, and a headless run has no
 * /dev/tty at all. The installer must never freeze on (or die opening) the
 * terminal — interactive steps run only when /dev/tty actually opens, and
 * otherwise it prints instructions and exits 0.
 *
 * And the runtime half: a fresh install printed "Kinu CLI is ready." and the
 * first `kinu` in the next shell answered "Bun is required", over the same Bun
 * on disk. The installer verified Bun through a PATH it exported into its own
 * process and never persisted; the launcher re-derived Bun from the user's
 * ambient PATH. Both sides now inline one resolution
 * (`src/cli/bun-runtime.ts`), so the launcher runs the binary the installer
 * verified — asserted here by making the only Bun on the machine a stub that
 * records every path it was invoked through.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { tolerate } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { handleCliRequest } from '../src/cli/routes';
import { buildCliInstallCommand } from '../src/cli/install-command';
import { KINU_BUN_VERSION, bunResolutionShell, bunVersionKey } from '../src/cli/bun-runtime';

const ORIGIN = 'https://kinu.example.com';
const tempDirs: string[] = [];

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
  /** Served at `<origin>/downloads/kinu`. Defaults to a stub that answers
   *  `--help` and `setup`; pass the real launcher to exercise it. */
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function installScript(): Promise<string> {
  const partialEnv: Partial<Env> = {};
  // SAFETY: handleCliRequest returns from its /install.sh branch before reading env, and this request fixes that pathname.
  const env = partialEnv as Env;
  const response = await handleCliRequest(new Request(`${ORIGIN}/install.sh`), env);
  if (!response) throw new Error('/install.sh was not handled');
  expect(response.status).toBe(200);
  return response.text();
}

async function launcherScript(): Promise<string> {
  const partialEnv: Partial<Env> = {};
  // SAFETY: handleCliRequest returns from its /downloads/kinu branch before reading env, and this request fixes that pathname.
  const env = partialEnv as Env;
  const response = await handleCliRequest(new Request(`${ORIGIN}/downloads/kinu`), env);
  if (!response) throw new Error('/downloads/kinu was not handled');
  expect(response.status).toBe(200);
  return response.text();
}

/** A Bun stand-in that records the path it was invoked through, answers
 *  `--version`, and prints the CLI help line for `run` — so a test can prove
 *  WHICH Bun binary ran, not merely that something did. */
function bunStub(version: string, logPath: string): string {
  return [
    '#!/bin/sh',
    `printf '%s\\n' "$0" >> "${logPath}"`,
    `if [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi`,
    'if [ "$1" = "run" ]; then printf \'  setup   connect your account\\n\'; exit 0; fi',
    'exit 0',
    '',
  ].join('\n');
}

/** A source archive shaped like the published one — one top-level directory
 *  carrying packages/cli/bin/cli.ts — plus the sha256 sidecar the launcher
 *  verifies against. */
function makeSourceTarball(home: string): void {
  const stage = join(home, 'stage');
  mkdirSync(join(stage, 'kinu/packages/cli/bin'), { recursive: true });
  writeFileSync(join(stage, 'kinu/packages/cli/bin/cli.ts'), '#!/usr/bin/env bun\n');
  const tarball = join(home, 'source.tar.gz');
  const tar = spawnSync('tar', ['-czf', tarball, '-C', stage, 'kinu'], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  writeFileSync(join(home, 'source.tar.gz.sha256'), `${digest}  kinu-source.tar.gz\n`);
}

/** A sandbox HOME plus stub curl/bun/ln so the script runs without network
 *  or system side effects. The stub curl "downloads" the launcher, the Bun
 *  installer, and the source archive. */
function makeSandbox(options: SandboxOptions = {}): InstallSandbox {
  const ambientBun = options.ambientBun === undefined ? KINU_BUN_VERSION : options.ambientBun;
  const home = mkdtempSync(join(tmpdir(), 'kinu-install-test-'));
  tempDirs.push(home);
  const stubBin = join(home, 'stub-bin');
  mkdirSync(stubBin);
  const bunLog = join(home, 'bun-invocations.log');

  const stubShim = [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then printf "  setup   connect your account\\n"; exit 0; fi',
    'if [ "$1" = "setup" ]; then echo "STUB-SETUP-RAN"; exit 0; fi',
    'exit 0',
  ].join('\n');
  writeFileSync(join(home, 'stub-shim.sh'), `${stubShim}\n`);
  writeFileSync(join(home, 'launcher'), options.launcher ?? `${stubShim}\n`);

  // Stands in for https://bun.sh/install: honours the `bun-vX.Y.Z` tag and
  // $BUN_INSTALL as the real one does. It REQUIRES $BUN_INSTALL rather than
  // defaulting to $HOME/.bun the way the real script does: the installer under
  // test always sets it, and a stub that silently falls back would overwrite
  // the developer's own Bun on any machine where BUN_INSTALL is exported.
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

  makeSourceTarball(home);

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
    `  *kinu-source.tar.gz.sha256) cat "${home}/source.tar.gz.sha256"; exit 0 ;;`,
    '  *kinu-source.tar.gz)',
    '    [ -n "$out" ] || exit 1',
    `    cat "${home}/source.tar.gz" > "$out"; exit 0 ;;`,
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

  // The /usr/local/bin symlink step must not touch the real system.
  writeFileSync(join(stubBin, 'ln'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(stubBin, 'ln'), 0o755);

  return { home, stubBin, bunLog, managedBun: join(home, '.kinu/runtime/bin/bun') };
}

/** Runs the script exactly like `curl | bash` in a detached session: stdin is
 *  the script pipe and /dev/tty cannot be opened (no controlling terminal). */
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
    const script = await installScript();
    const { home, stubBin } = makeSandbox();
    const result = await runHeadlessInstall(script, home, stubBin);

    expect(result.timedOut).toBe(false);
    expect(result.output).toContain('Kinu installed.');
    expect(result.output).toContain('Setup was not started because no interactive terminal is attached.');
    expect(result.output).toContain(`setup --origin ${ORIGIN}`);
    expect(result.output).toContain('Kinu CLI is ready.');
    expect(result.output).not.toContain('STUB-SETUP-RAN');
    expect(result.output).not.toContain('/dev/tty');
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test('the canonical install command activates kinu in its invoking shell', async () => {
    const script = await installScript();
    const { home, stubBin } = makeSandbox();
    writeFileSync(join(home, 'install.sh'), script);
    const install = buildCliInstallCommand({ origin: ORIGIN, setup: false });
    const run = spawnSync('bash', ['-c', [
      install,
      'printf "ACTIVE=%s\\n" "$(command -v kinu)"',
      'kinu --help',
    ].join('\n')], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        HOME: home,
        KINU_HOME: join(home, '.kinu'),
        PATH: `${stubBin}:/usr/bin:/bin`,
        SHELL: '/bin/bash',
      },
    });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`ACTIVE=${join(home, '.kinu/bin/kinu')}`);
    expect(run.stdout).toContain('setup   connect your account');
  }, 40_000);

  test('interactive steps gate on actually opening /dev/tty and restore the terminal on failure', async () => {
    const script = await installScript();
    // Permission probes ([ -r /dev/tty ]) pass without a controlling
    // terminal; only a real open proves the redirects below will work.
    expect(script).toContain('( exec </dev/tty >/dev/tty ) 2>/dev/null');
    expect(script).not.toContain('[ -r /dev/tty ]');
    // Interactive children run through run_on_tty: terminal on stdin, and a
    // best-effort `stty sane` when the child dies mid-prompt.
    expect(script).toContain('"$@" < /dev/tty');
    expect(script).toContain('stty sane < /dev/tty 2>/dev/null || true');
    expect(script).toContain('run_on_tty "$BIN_PATH" setup --origin "$KINU_ORIGIN" --account-only');
    expect(script).toContain('run_on_tty "$BIN_PATH" connect');
    // Children that are not interactive must not inherit the script stream:
    // under curl|bash a stdin-reading child would eat unread script bytes.
    expect(script).toContain('"$BIN_PATH" --help </dev/null');
  });

  test('a CLI that dies in raw mode leaves the terminal sane after the served script exits', async () => {
    const python = Bun.which('python3');
    if (!python) return; // PTY harness needs python3
    const script = await installScript();
    const { home, stubBin } = makeSandbox();
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
      timeout: 40_000,
      env: {
        ...process.env,
        HOME: home,
        KINU_HOME: join(home, '.kinu'),
        PATH: `${stubBin}:/usr/bin:/bin`,
        SHELL: '/bin/bash',
        // This is the one runner that inherits the ambient environment (the PTY
        // harness needs python's own). An exported BUN_INSTALL must not reach
        // the script: only the installer's own value may say where Bun lands.
        BUN_INSTALL: '',
      },
    });
    expect(run.status).toBe(0);
    const lastLine = run.stdout.trim().split('\n').at(-1);
    if (!lastLine) throw new Error('PTY harness emitted no result');
    const result = v.parse(PtyResultSchema, JSON.parse(lastLine));
    expect(result.output).toContain('STUB-SETUP-DIED');
    expect(result.exitcode).not.toBe(0); // setup failure still surfaces
    expect(result.post).toEqual({ icanon: true, echo: true, isig: true });
  }, 45_000);
});

/**
 * The reported transition, in one file: the installer says "Kinu CLI is ready."
 * and the next `kinu` says "Bun is required." It happened because the two
 * scripts resolved Bun independently — the installer through a PATH it exported
 * into its own process, the launcher through the user's ambient PATH.
 */
describe('Bun runtime resolution is one source of truth', () => {
  test('the approved Bun is the version this repository itself pins', () => {
    const manifest = readFileSync(join(import.meta.dir, '../../../package.json'), 'utf8');
    const pin = v.parse(v.object({ packageManager: v.string() }), JSON.parse(manifest)).packageManager;
    expect(pin).toBe(`bun@${KINU_BUN_VERSION}`);
    expect(bunVersionKey(KINU_BUN_VERSION)).toBeGreaterThan(0);
  });

  test('both served scripts carry the same resolution and neither probes Bun on its own', async () => {
    const shared = bunResolutionShell();
    const install = await installScript();
    const launcher = await launcherScript();
    for (const script of [install, launcher]) {
      expect(script).toContain(shared);
      // One `command -v bun`, and it is the shared one. A second probe beside
      // it is the defect: two answers to one question.
      expect(script.split('command -v bun').length - 1)
        .toBe(shared.split('command -v bun').length - 1);
      expect(script).toContain('kinu_resolve_bun');
    }
    // The launcher never installs a runtime, and it runs exactly one — the Bun
    // it just resolved. The CLI imports bun:sqlite; there is no Node path.
    expect(launcher).not.toContain('bun.sh/install');
    expect(launcher).toContain('exec "$KINU_BUN" run packages/cli/bin/cli.ts "$@"');
  });

  /**
   * The resolution is BUILT as a TypeScript template literal and SHIPPED as
   * bash, and the two disagree about backslash. `\${` in the source is required
   * — a bare `${` would interpolate at build time — while `\$` before anything
   * else is a useless escape, and 19 of those were written here.
   *
   * WHAT THIS TEST CANNOT DO, stated because the alternative is a test that
   * looks like it covers the 19 and does not. A stray `\$` has NO runtime
   * observable: in a template literal `\$X` and `$X` render byte-identically
   * and the output carries no backslash at all. Measured, not assumed — the
   * two forms compare equal and `.includes("\\")` is false on both. So that
   * defect class is structurally invisible to any behavioural test and belongs
   * to the linter, which is where it was in fact caught.
   *
   * WHAT IT DOES DO is the neighbouring class, which is observable and worse: a
   * DOUBLE escape (`\\$`) reaching the emitted text ships bash in which `\$` is
   * a LITERAL dollar, so `"\$KINU_HOME"` would compare against the seven
   * characters `$KINU_HOME` instead of reading the variable and every candidate
   * would silently fail to resolve. That has a red direction and the second
   * test below has a live one: removing one required `\${` makes it fail.
   */
  test('the emitted resolution expands shell variables, and escapes none of them', async () => {
    const shared = bunResolutionShell();
    expect(shared).not.toContain('\\$');
    expect(await launcherScript()).not.toContain('\\$');
    // install.sh has exactly one legitimate escaped dollar, and it is the
    // opposite case: the PROFILE line it appends must reach the user's rc file
    // carrying a literal `$PATH`, expanded when that shell starts rather than
    // when the installer runs. So every escape in install.sh must sit on a PATH
    // line, and a stray one anywhere else still fails here.
    const escaped = (await installScript()).split('\n').filter((line) => line.includes('\\$'));
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
    // Behavioural rather than textual: runs the emitted shell and reads back
    // what its `${1%%.*}` / `${kb_rest#*.}` chain actually produced. A
    // mis-escaped expansion cannot pass this, because bash would hand the
    // arithmetic the literal text instead of the digits.
    const script = `${bunResolutionShell()}\nkinu_bun_key "$1"\n`;
    for (const [version, key] of [
      ['1.4.0', '1004000'],
      ['1.9.2', '1009002'],
      ['1.4.0-canary.20260101', '1004000'],
      ['2.0.13', '2000013'],
    ]) {
      const run = spawnSync('bash', ['-c', script, 'kinu', version!], { encoding: 'utf8', timeout: 20_000 });
      expect(run.status, `${version}: ${run.stderr}`).toBe(0);
      expect(run.stdout.trim()).toBe(key);
    }
    // A version it must refuse to score rather than guess at.
    for (const bad of ['1.4', 'not-a-version', '']) {
      const run = spawnSync('bash', ['-c', script, 'kinu', bad], { encoding: 'utf8', timeout: 20_000 });
      expect(run.status, `${bad} should not be comparable`).toBe(1);
      expect(run.stdout.trim()).toBe('');
    }
  }, 30_000);

  test('a candidate that is not an absolute path is refused', () => {
    // `command -v bun` answers with a path for anything on PATH, but a shell
    // function or builtin answers with the bare word — and an executable test
    // on a bare word resolves against the WORKING DIRECTORY. A file named
    // `bun` in whatever directory the user ran the installer from must never
    // become the runtime this CLI executes.
    const cwd = mkdtempSync(join(tmpdir(), 'kinu-bun-cwd-'));
    try {
      const decoy = join(cwd, 'bun');
      writeFileSync(decoy, `#!/bin/sh\nprintf '%s\\n' '${KINU_BUN_VERSION}'\n`);
      chmodSync(decoy, 0o755);
      const probe = spawnSync('bash', ['-c', [
        'set -eu',
        'KINU_HOME="$PWD/.kinu"',
        bunResolutionShell(),
        'if kinu_bun_compatible bun; then echo TOOK-RELATIVE; else echo REFUSED; fi',
        'if kinu_bun_compatible "$PWD/bun"; then echo TOOK-ABSOLUTE; else echo REFUSED-ABSOLUTE; fi',
      ].join('\n')], { cwd, encoding: 'utf8', timeout: 20_000 });

      expect(probe.stdout).toContain('REFUSED');
      expect(probe.stdout).not.toContain('TOOK-RELATIVE');
      // The same file BY ABSOLUTE PATH still qualifies: the rule is about how a
      // candidate is named, not about distrusting the user's own binaries.
      expect(probe.stdout).toContain('TOOK-ABSOLUTE');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test('an existing compatible Bun is used as it is, and nothing is downloaded', async () => {
    const script = await installScript();
    const { home, stubBin, managedBun } = makeSandbox({ ambientBun: '1.9.2' });
    const result = await runHeadlessInstall(script, home, stubBin);

    expect(result.timedOut).toBe(false);
    expect(result.output).toContain(`Using Bun 1.9.2 at ${join(stubBin, 'bun')}.`);
    expect(result.output).not.toContain('Installing Bun');
    expect(existsSync(managedBun)).toBe(false);
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test('a Bun older than the approved one is not accepted, and the approved one is installed once', async () => {
    const script = await installScript();
    const { home, stubBin, managedBun } = makeSandbox({ ambientBun: '1.1.45' });
    const result = await runHeadlessInstall(script, home, stubBin);

    expect(result.timedOut).toBe(false);
    expect(result.output).toContain(`Installing Bun ${KINU_BUN_VERSION}...`);
    expect(result.output).toContain(`Using Bun ${KINU_BUN_VERSION} at ${managedBun}.`);
    expect(existsSync(managedBun)).toBe(true);
    // Once. A second install path is how the two sides drifted apart before.
    expect(result.output.split(`Installing Bun ${KINU_BUN_VERSION}...`).length - 1).toBe(1);
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test('KINU_INSTALL_BUN=0 names the version it needs instead of installing one', async () => {
    const script = await installScript();
    const { home, stubBin, managedBun } = makeSandbox({ ambientBun: null });
    const result = await runHeadlessInstall(script, home, stubBin, { KINU_INSTALL_BUN: '0' });

    expect(result.output).toContain(`Bun ${KINU_BUN_VERSION} or newer is required.`);
    expect(existsSync(managedBun)).toBe(false);
    expect(result.exitCode).toBe(1);
  }, 30_000);

  test('the launcher runs the Bun the installer verified, in a later shell with no bun on PATH', async () => {
    const script = await installScript();
    const launcher = await launcherScript();
    // A machine with no Bun at all, and the real launcher installed — not a stub.
    const { home, stubBin, bunLog, managedBun } = makeSandbox({ ambientBun: null, launcher });
    const install = await runHeadlessInstall(script, home, stubBin);

    expect(install.timedOut).toBe(false);
    expect(install.output).toContain(`Installing Bun ${KINU_BUN_VERSION}...`);
    expect(install.output).toContain('Kinu CLI is ready.');
    expect(install.exitCode).toBe(0);

    // A brand-new shell. Nothing sourced a profile, and no bun is on PATH —
    // exactly the shell that used to be told "Bun is required."
    const later = spawnSync(join(home, '.kinu/bin/kinu'), ['--help'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        HOME: home,
        KINU_HOME: join(home, '.kinu'),
        PATH: `${stubBin}:/usr/bin:/bin`,
        SHELL: '/bin/bash',
      },
    });

    expect(`${later.stdout}${later.stderr}`).not.toContain('Bun is required');
    expect(later.status, later.stderr).toBe(0);
    expect(later.stdout).toContain('setup   connect your account');
    // Every Bun the installer and the launcher ran is the one binary the
    // installer put on disk. Nothing resolved through PATH or a shell profile.
    const invocations = readFileSync(bunLog, 'utf8').trim().split('\n');
    expect(invocations.length).toBeGreaterThan(1);
    expect(invocations.filter((path) => path !== managedBun)).toEqual([]);
  }, 60_000);
});

/** Runs `bash < install.sh` in its own session with a PTY controlling
 *  terminal and stdin on a pipe — the exact `curl | bash` topology — then
 *  reports the PTY's termios state after the script exits. */
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
