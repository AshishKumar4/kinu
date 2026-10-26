// A new user's first session, run against the CLI's own entry: the names people reach for and the errors they meet each
// lead to the command that does it (staging first-run transcript, 2026-10-25).
import { scratchDir } from '../../test-utils/src/scratch';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { chatResponse, present, runToExit } from '@kinu.run/test-utils';
import * as v from 'valibot';

const cliBin = join(resolve(__dirname, '../../..'), 'packages/cli/bin/cli.ts');

const text = (output: string) => Bun.stripANSI(output).replaceAll('\r\n', '\n');

function runCli(args: string[], home: string, env: Record<string, string> = {}, cwd = scratchDir('first-run-project')) {
  return runToExit([process.execPath, cliBin, ...args], { cwd, env: { ...process.env, KINU_SKIP_DAEMON: '1', KINU_HOME: home, ...env } });
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The same, on a terminal: `script` gives the CLI a pty, as a person's shell does. */
function runCliOnTerminal(args: string[], home: string, env: Record<string, string>) {
  const assignments = Object.entries({ KINU_SKIP_DAEMON: '1', KINU_HOME: home, ...env }).map(([name, value]) => `${name}=${quote(value)}`);
  const command = [...assignments, quote(process.execPath), quote(cliBin), ...args.map(quote)].join(' ');

  return runToExit(['script', '-qefc', command, '/dev/null'], { cwd: scratchDir('first-run-project') });
}

/** A model endpoint; the status line is drawn at the turn's start, before any answer can arrive. */
function model(answer: string) {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
      const body = v.parse(v.object({ stream: v.optional(v.boolean()) }), await request.json());

      return chatResponse({ model: 'mock-model', text: answer, usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }, body.stream === true);
    },
  });

  return {
    env: { KINU_BASE_URL: `http://127.0.0.1:${String(present(server.port, 'the model port'))}`, KINU_AUTH: 'Bearer mock', KINU_MODEL: 'mock-model' },
    stop: () => server.stop(true),
  };
}

function cloudHome(): string {
  const home = scratchDir('first-run-cloud');
  const at = new Date(0).toISOString();

  writeFileSync(join(home, 'config.json'), JSON.stringify({
    origin: 'https://kinu.example.com',
    accessToken: ['ptc_', '0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz'].join(''),
    agents: { demo: { name: 'demo', mode: 'cloud', cloudName: 'demo', displayName: 'Demo', purpose: 'Demo', createdAt: at, updatedAt: at } },
  }), { mode: 0o600 });

  return home;
}

describe('a first session with the CLI', () => {
  test('`kinu help` is the root help, and `kinu help <command>` that command\'s own', async () => {
    const home = scratchDir('first-run-help');
    const [root, create] = await Promise.all([runCli(['help'], home), runCli(['help', 'create'], home)]);

    expect([root.exitCode, create.exitCode]).toEqual([0, 0]);
    expect(text(root.stdout)).toContain('kinu <command>');
    expect(text(create.stdout)).toContain('Usage: kinu create');
  });

  test('`kinu ls` and `kinu workspaces` list the workspaces, as `kinu list` does', async () => {
    const home = scratchDir('first-run-list');
    const project = scratchDir('first-run-listed-project');
    const endpoint = model('unused');

    try {
      expect((await runCli(['create', 'listed', '--mode', 'local', '--purpose', 'be listed'], home, endpoint.env, project)).exitCode).toBe(0);
      const runs = await Promise.all(['list', 'ls', 'workspaces'].map((name) => runCli([name], home, {}, project)));

      expect(runs.map((run) => run.exitCode)).toEqual([0, 0, 0]);
      expect(text(runs[0]?.stdout ?? '')).toContain('listed');
      expect(new Set(runs.map((run) => text(run.stdout))).size).toBe(1);
    } finally {
      await endpoint.stop();
    }
  });

  test('deleting at the top says where deleting lives, for each name people reach for', async () => {
    const home = scratchDir('first-run-delete');
    const runs = await Promise.all(['delete', 'rm', 'remove'].map((name) => runCli([name, 'demo'], home)));

    for (const run of runs) {
      expect(run.exitCode).toBe(1);
      expect(text(run.stderr)).toContain('kinu workspace delete <name>');
    }
  });

  test('`kinu create` with no name and no terminal names the command that creates one', async () => {
    const run = await runCli(['create'], scratchDir('first-run-create'));

    expect(run.exitCode).toBe(1);
    expect(text(run.stderr)).toContain('kinu create <name>');
  });

  test('`kinu logout` with nobody signed in says so, and how to sign in, rather than that it signed out', async () => {
    const run = await runCli(['logout'], scratchDir('first-run-logout'));

    expect({ exitCode: run.exitCode, said: text(run.stdout) }).toMatchObject({ exitCode: 0, said: expect.stringContaining('kinu auth') });
    expect(text(run.stdout)).not.toContain('Signed out');
  });

  test('deleting with no terminal to confirm names the command that confirms it', async () => {
    const run = await runCli(['workspace', 'delete', 'demo'], cloudHome());

    expect(run.exitCode).toBe(1);
    expect(text(run.stderr)).toContain('kinu workspace delete demo --yes');
  });

  test('`kinu run` on a terminal says what it waits for until the answer comes, and a pipe carries only the answer', async () => {
    const home = scratchDir('first-run-wait');
    const endpoint = model('Hello from the model.');

    try {
      expect((await runCli(['create', 'waity', '--mode', 'local', '--purpose', 'wait'], home, endpoint.env)).exitCode).toBe(0);
      const terminal = await runCliOnTerminal(['run', 'waity', 'Say hello'], home, endpoint.env);
      const piped = await runCli(['run', 'waity', 'Say hello'], home, endpoint.env);
      const shown = text(terminal.stdout);

      expect([terminal.exitCode, piped.exitCode]).toEqual([0, 0]);
      expect(shown.indexOf('waiting for waity')).toBeGreaterThan(-1);
      expect(shown.indexOf('waiting for waity')).toBeLessThan(shown.indexOf('Hello from the model.'));
      expect(text(piped.stdout).trim()).toBe('Hello from the model.');
    } finally {
      await endpoint.stop();
    }
  });
});
