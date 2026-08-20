/**
 * Behavioral regression tests for the served install.sh: under `curl | bash`
 * stdin is the script stream, not the terminal, and a headless run has no
 * /dev/tty at all. The installer must never freeze on (or die opening) the
 * terminal — interactive steps run only when /dev/tty actually opens, and
 * otherwise it prints instructions and exits 0.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { tolerate } from '@kinu/core/obs';
import * as v from 'valibot';
import { handleCliRequest } from '../src/cli/routes';

const ORIGIN = 'https://proteus.example.com';
const tempDirs: string[] = [];

interface InstallSandbox {
  home: string;
  stubBin: string;
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

/** A sandbox HOME plus stub curl/bun/ln so the script runs without network
 *  or system side effects. The stub curl "downloads" a stub kinu shim. */
function makeSandbox(): InstallSandbox {
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

    const childPid = child.pid;
    if (childPid === undefined) {
      resolve({ exitCode: null, output, timedOut: true });
      return;
    }

    const timer = setTimeout(() => {
      tolerate(() => process.kill(-childPid, 'SIGKILL'), 'esrch');
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
    expect(result.output).toContain('Kinu installed.');
    expect(result.output).toContain('Setup was not started because no interactive terminal is attached.');
    expect(result.output).toContain(`setup --origin ${ORIGIN}`);
    expect(result.output).toContain('Kinu CLI is ready.');
    expect(result.output).not.toContain('STUB-SETUP-RAN');
    expect(result.output).not.toContain('/dev/tty');
    expect(result.exitCode).toBe(0);
  }, 30_000);

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
    expect(script).toContain('run_on_tty "$BIN_PATH" setup --origin "$PROTEUS_ORIGIN" --account-only');
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
    writeFileSync(join(home, 'stub-shim.sh'), [
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
        PROTEUS_HOME: join(home, '.proteus'),
        PATH: `${stubBin}:/usr/bin:/bin`,
        SHELL: '/bin/bash',
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
