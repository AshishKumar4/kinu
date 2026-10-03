/**
 * The stateless shell on a machine whose own shell keeps nothing (a container's, a device's, a host's `sh -c`): every
 * call starts fresh in its `cwd` or the machine's home, and a named one keeps its directory and exported variables in
 * a file only its owner reads. Real `sh` and `bash`, in a scratch home.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { createBashShell } from '../src/execution/shell-session';
import type { Shell, ShellExecOptions } from '../src/types/primitives';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'kinu-machine-shell-'));
  homes.push(home);
  mkdirSync(join(home, 'sub'));

  return home;
}

/** A machine's own shell: each call a fresh `sh -c` in `home`, its stdout handed on as it arrives. */
function machine(home: string): Shell {
  return {
    async exec(command, stdinOrOptions) {
      const options: ShellExecOptions = v.is(v.string(), stdinOrOptions) ? { stdin: stdinOrOptions } : stdinOrOptions ?? {};

      const child = Bun.spawn(['sh', '-c', command], {
        cwd: home, env: { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe',
      });

      const chunks: Uint8Array[] = [];

      for await (const chunk of child.stdout) {
        chunks.push(chunk);
        options.output?.write('stdout', chunk);
      }

      const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

      return { stdout: Buffer.concat(chunks).toString('utf8'), stderr, exitCode };
    },
  };
}

const place = (home: string) => ({ home, scope: 'agent:alpha', stateDirectory: '~/.kinu/shells' });

test('an unnamed call keeps nothing, and its result names where it started', async () => {
  const home = scratchHome();
  const shell = createBashShell(machine(home), place(home));

  expect(await shell.exec('cd sub && export LEFT=1 && pwd')).toMatchObject({ stdout: `${home}/sub\n`, exitCode: 0, cwd: home });
  expect(await shell.exec('pwd; echo "left=$LEFT"')).toMatchObject({ stdout: `${home}\nleft=\n`, cwd: home });
  expect(await shell.exec('pwd', { cwd: 'sub' })).toMatchObject({ stdout: `${home}/sub\n`, cwd: `${home}/sub` });
  // No name, no state.
  expect(readdirSync(home)).toEqual(['sub']);
});

test("a name keeps its directory and exports from call to call, past `exit 3`, in a file only its owner reads", async () => {
  const home = scratchHome();
  const shell = createBashShell(machine(home), place(home));

  expect(await shell.exec('mkdir -p work && cd work && export TOKEN=s3 && exit 3', { name: 'build' }))
    .toMatchObject({ exitCode: 3, cwd: home, finalCwd: `${home}/work` });
  expect(await shell.exec('pwd; echo "token=$TOKEN"', { name: 'build' }))
    .toMatchObject({ stdout: `${home}/work\ntoken=s3\n`, cwd: `${home}/work`, finalCwd: `${home}/work` });

  // Another name, and the same name under another agent, start fresh at home.
  expect(await shell.exec('pwd; echo "token=$TOKEN"', { name: 'other' })).toMatchObject({ stdout: `${home}\ntoken=\n` });
  expect(await createBashShell(machine(home), { ...place(home), scope: 'agent:beta' }).exec('pwd; echo "token=$TOKEN"', { name: 'build' }))
    .toMatchObject({ stdout: `${home}\ntoken=\n` });

  const states = join(home, '.kinu', 'shells');

  expect(statSync(states).mode & 0o777).toBe(0o700);

  for (const file of readdirSync(states)) expect(statSync(join(states, file)).mode & 0o777).toBe(0o600);

  // Read cold, as approval reads a name it has not seen this session.
  expect(await shell.cwd?.('build')).toBe(`${home}/work`);
  expect(await shell.cwd?.('never')).toBeNull();
});

test("a named call's live output, like its result, holds the command's output alone", async () => {
  const home = scratchHome();
  const shell = createBashShell(machine(home), place(home));
  const heard: string[] = [];
  const decoder = new TextDecoder();

  const result = await shell.exec('printf "one\\n"; sleep 0.1; printf "two\\n"', {
    name: 'stream',
    output: { write: (_stream, data) => { heard.push(v.is(v.string(), data) ? data : decoder.decode(data, { stream: true })); }, lost: () => {} },
  });

  expect(result.stdout).toBe('one\ntwo\n');
  expect(heard.join('')).toBe('one\ntwo\n');
});
