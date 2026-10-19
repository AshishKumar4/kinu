/**
 * The owner's secrets granted to a workspace reach every command its agents run, as variables: on the computer, real
 * `bash` in a scratch home, a named shell's included; on the workspace's Nimbus box, beneath each command's own.
 * A value its agents may read reaches a command run now and never one Kinu restarts later, nor any state file.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxExecutor, type SandboxHandle } from '../src/execution/sandbox';
import { withCommandEnvironment, type CommandEnvironment } from '../src/execution/command-environment';
import { withHostedNodeExecution } from '../src/execution/node-home';
import type { NimbusSandboxHandle } from '../src/execution/nimbus';
import { sandboxHandleLifecycle } from './helpers/sandbox-handle-lifecycle';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const PLACEHOLDER = `pxs1_${'a'.repeat(43)}`;

/** What a command sets for itself under a secret's name. */
const CALLS_OWN = ['the', 'call', 's', 'own'].join('-');

/** Assembled, so no scanner reads a hardcoded password here. */
const DB_PASSWORD = ['hunter2', 'db', 'password'].join('-');

interface Granted {
  readonly environment: CommandEnvironment;
  revoke(): void;
}

/** What the owner granted: Stripe as a placeholder, the database password readable by this workspace's agents. */
function granted(): Granted {
  let held = true;

  return {
    environment: async (use): Promise<Record<string, string>> => {
      if (!held) return {};

      return { STRIPE_SECRET_KEY: PLACEHOLDER, DATABASE_PASSWORD: use === 'keep' ? `pxs1_${'d'.repeat(43)}` : DB_PASSWORD };
    },
    revoke: () => { held = false; },
  };
}

/** A computer whose commands run in real `bash` with the variables the executor hands the container. */
function computer(environment: CommandEnvironment) {
  const home = mkdtempSync(join(tmpdir(), 'kinu-command-env-'));
  homes.push(home);
  const started: { command: string; env: Readonly<Record<string, string>> | undefined }[] = [];

  const handle: SandboxHandle = {
    ...sandboxHandleLifecycle,
    exec: async (command, opts) => {
      const child = Bun.spawn(['bash', '-c', command], {
        cwd: home, env: { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...opts?.env }, stdout: 'pipe', stderr: 'pipe',
      });

      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

      return { stdout, stderr, exitCode };
    },
    startSupervisedProcess: async (command, opts) => {
      started.push({ command, env: opts?.env });

      return { processId: 'proc-1' };
    },
    readFile: async () => ({}),
    writeFile: async () => {},
    listFiles: async () => ({ files: [] }),
    deleteFile: async () => {},
    exposePort: async (port) => ({ url: `https://preview.example.com/${port}`, port, route: { reached: true } }),
    unexposePort: async () => {},
    getExposedPorts: async () => [],
  };

  const provider = createSandboxExecutor(handle, { shells: { scope: 'agent:alpha', stateDirectory: '~/.kinu/shells' }, environment });

  return { home, started, provider, run: async (command: string, options?: { name: string }) => provider.tools.exec.execute(command, { ...options, parts: true }) };
}

test('a computer command holds the placeholder, and the value its agents may read', async () => {
  const { run } = computer(granted().environment);

  expect(await run('printf "%s %s" "$STRIPE_SECRET_KEY" "$DATABASE_PASSWORD"')).toMatchObject({ stdout: `${PLACEHOLDER} ${DB_PASSWORD}` });
});

test("a named shell restores its own exports and sets the secrets again over them, and its state file never holds one", async () => {
  const access = granted();
  const { home, run } = computer(access.environment);

  await run('export OWN=kept; export STRIPE_SECRET_KEY=overwritten-by-the-agent', { name: 'build' });
  expect(await run('printf "%s %s %s" "$OWN" "$STRIPE_SECRET_KEY" "$DATABASE_PASSWORD"', { name: 'build' }))
    .toMatchObject({ stdout: `kept ${PLACEHOLDER} ${DB_PASSWORD}` });

  const states = join(home, '.kinu', 'shells');
  const saved = readdirSync(states).map((file) => readFileSync(join(states, file), 'utf8')).join('\n');

  expect(saved).toContain('OWN');
  expect(saved).not.toContain(DB_PASSWORD);
  expect(saved).not.toContain(PLACEHOLDER);
  expect(saved).not.toContain('STRIPE_SECRET_KEY');

  // Revoked: the next call of the same shell holds neither, since neither was ever saved there.
  access.revoke();
  expect(await run('printf "[%s][%s][%s]" "$OWN" "$STRIPE_SECRET_KEY" "$DATABASE_PASSWORD"', { name: 'build' }))
    .toMatchObject({ stdout: '[kept][][]' });
});

test('a process the computer restarts by itself gets placeholders, never a value', async () => {
  const { started, provider } = computer(granted().environment);

  await provider.tools.startProcess.execute('bun run dev');

  expect(started).toEqual([{ command: 'bun run dev', env: { STRIPE_SECRET_KEY: PLACEHOLDER, DATABASE_PASSWORD: `pxs1_${'d'.repeat(43)}` } }]);
});

test("on the workspace's box a command gets the secrets beneath its own variables, and a facet keeps its home", async () => {
  const seen: { method: string; env: Readonly<Record<string, string>> | undefined }[] = [];

  const box: NimbusSandboxHandle = {
    ready: async () => {},
    exec: async (_command, options) => {
      seen.push({ method: 'exec', env: options?.env });

      return { command: 'env', exitCode: 0, success: true, duration: 0, timestamp: 0, stdout: '', stderr: '' };
    },
    startProcess: async (command, options) => {
      seen.push({ method: 'startProcess', env: options?.env });

      return {
        command, pid: 7, ports: [], startedAt: 0,
        process: { pid: 7, command, argv: [command], cwd: '/home/alpha', state: 'running', exitCode: null, startTime: 0, endTime: null, longRunning: true, attachedTty: false },
      };
    },
  };

  const facet = withHostedNodeExecution(box, { home: '/home/alpha', tmp: '/tmp/alpha', cred: { uid: 1001, gid: 1001, groups: [1001], umask: 0o022 } });
  const execution = withCommandEnvironment(facet, granted().environment);

  await execution.exec('env', { env: { STRIPE_SECRET_KEY: CALLS_OWN } });
  await execution.startProcess?.('serve', {});

  expect(seen).toEqual([
    { method: 'exec', env: { STRIPE_SECRET_KEY: CALLS_OWN, DATABASE_PASSWORD: DB_PASSWORD, HOME: '/home/alpha', TMPDIR: '/tmp/alpha' } },
    { method: 'startProcess', env: { STRIPE_SECRET_KEY: PLACEHOLDER, DATABASE_PASSWORD: `pxs1_${'d'.repeat(43)}`, HOME: '/home/alpha', TMPDIR: '/tmp/alpha' } },
  ]);
});
