/**
 * Behavioral regression tests for the served install.sh: under `curl | bash`
 * stdin is the script stream, not the terminal, and a headless run has no
 * /dev/tty at all. The installer must never freeze on (or die opening) the
 * terminal — interactive steps run only when /dev/tty actually opens, and
 * otherwise it prints instructions and exits 0.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { handleCliRequest } from '../src/cli/routes.js';

const ORIGIN = 'https://proteus.example.com';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function installScript(): Promise<string> {
  const res = await handleCliRequest(new Request(`${ORIGIN}/install.sh`), {} as Env);
  expect(res?.status).toBe(200);
  return res!.text();
}

/** A sandbox HOME plus stub curl/bun/ln so the script runs without network
 *  or system side effects. The stub curl "downloads" a stub proteus shim. */
function makeSandbox(): { home: string; stubBin: string } {
  const home = mkdtempSync(join(tmpdir(), 'proteus-install-test-'));
  tempDirs.push(home);
  const stubBin = join(home, 'stub-bin');
  mkdirSync(stubBin);

  const stubShim = [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then printf "  setup   connect your account\\n"; exit 0; fi',
    'if [ "$1" = "setup" ]; then echo "STUB-SETUP-RAN"; exit 0; fi',
    'exit 0',
  ].join('\n');
  writeFileSync(join(home, 'stub-shim.sh'), `${stubShim}\n`);

  const curl = [
    '#!/usr/bin/env bash',
    '# stub curl: only supports `curl -fsSL <url> -o <file>`',
    'out=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "-o" ]; then shift; out="$1"; fi',
    '  shift',
    'done',
    '[ -n "$out" ] || exit 1',
    `cat "${home}/stub-shim.sh" > "$out"`,
  ].join('\n');
  writeFileSync(join(stubBin, 'curl'), `${curl}\n`);
  chmodSync(join(stubBin, 'curl'), 0o755);

  writeFileSync(join(stubBin, 'bun'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(stubBin, 'bun'), 0o755);

  // The /usr/local/bin symlink step must not touch the real system.
  writeFileSync(join(stubBin, 'ln'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(stubBin, 'ln'), 0o755);

  return { home, stubBin };
}

/** Runs the script exactly like `curl | bash` in a detached session: stdin is
 *  the script pipe and /dev/tty cannot be opened (no controlling terminal). */
function runHeadlessInstall(script: string, home: string, stubBin: string): Promise<{
  exitCode: number | null; output: string; timedOut: boolean;
}> {
  return new Promise((resolve) => {
    const child = spawn('bash', [], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        HOME: home,
        PROTEUS_HOME: join(home, '.proteus'),
        PATH: `${stubBin}:/usr/bin:/bin`,
        SHELL: '/bin/bash',
      },
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stdin.end(script);

    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
      resolve({ exitCode: null, output, timedOut: true });
    }, 20_000);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output, timedOut: false });
    });
  });
}

describe('install.sh terminal handling', () => {
  test('headless curl|bash prints setup instructions and exits 0 — never opens /dev/tty', async () => {
    const script = await installScript();
    const { home, stubBin } = makeSandbox();
    const result = await runHeadlessInstall(script, home, stubBin);

    expect(result.timedOut).toBe(false);
    expect(result.output).toContain('Proteus installed.');
    expect(result.output).toContain('Setup was not started because no interactive terminal is attached.');
    expect(result.output).toContain(`setup --origin ${ORIGIN}`);
    expect(result.output).toContain('Proteus CLI is ready.');
    expect(result.output).not.toContain('STUB-SETUP-RAN');
    expect(result.output).not.toContain('/dev/tty');
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test('interactive steps gate on actually opening /dev/tty and redirect stdin from it', async () => {
    const script = await installScript();
    // Permission probes ([ -r /dev/tty ]) pass without a controlling
    // terminal; only a real open proves the redirects below will work.
    expect(script).toContain('( exec </dev/tty >/dev/tty ) 2>/dev/null');
    expect(script).not.toContain('[ -r /dev/tty ]');
    expect(script).toContain('--account-only < /dev/tty');
    expect(script).toContain('--account-only --yes < /dev/tty');
    // Children that are not interactive must not inherit the script stream:
    // under curl|bash a stdin-reading child would eat unread script bytes.
    expect(script).toContain('"$BIN_PATH" --help </dev/null');
  });
});
