/**
 * The host shell's process contract.
 *
 * These are the assertions an in-process unit test normally cannot make,
 * which is why this class of defect keeps shipping: everything here is about
 * WHEN a call returns and WHAT the runtime still holds afterwards, not about
 * the value. A suite that only inspects return values is structurally blind to
 * it — the bug is in the timing and the handles, and both look identical to a
 * green assertion.
 *
 * The defect these lock: `exec` resolved on the child's `close` event. `close`
 * does not mean "the command finished" — it means "the command finished AND
 * every pipe it handed out has been closed". A shell command that backgrounds
 * anything (`npm run dev &`, `python -m http.server &`, `./server &`) leaves a
 * grandchild holding the inherited stdout pipe, so `close` waits for the
 * SERVER's lifetime. The agent typed one command, got its prompt back in the
 * terminal instantly, and the tool call sat there for as long as the server ran.
 */

import { describe, expect, test } from 'bun:test';
import { createHostShell } from '../src/runtime.js';

describe('createHostShell', () => {
  test('aborts long-running commands through AbortSignal', async () => {
    const shell = createHostShell(process.cwd());
    const controller = new AbortController();
    const started = Date.now();
    const command = shell.exec('sleep 5; echo done', { signal: controller.signal });

    setTimeout(() => controller.abort(new Error('stop requested')), 100);
    const result = await command;

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.stdout).not.toContain('done');
    expect(result.stderr).toContain('Command aborted.');
    expect(result.exitCode).toBe(130);
  });

  test('returns when the COMMAND finishes, not when a backgrounded child does', async () => {
    // `sleep 20 &` inherits the stdout pipe this shell reads. The command
    // itself is over in milliseconds — `echo` runs, `sh` exits — so that is
    // when the tool call has to come back. Measured before the fix: 20.3s for
    // a command whose own work took ~5ms.
    const shell = createHostShell(process.cwd());
    const started = Date.now();
    const result = await shell.exec('sleep 20 & echo started');
    const elapsed = Date.now() - started;

    expect(result.stdout).toContain('started');
    expect(result.exitCode).toBe(0);
    // Generous by three orders of magnitude against the correct behaviour
    // (~50ms) and still an order of magnitude under the broken one.
    expect(elapsed).toBeLessThan(3_000);
  }, 30_000);

  test('a backgrounded child does not keep the host process alive', async () => {
    // The other half of the same contract, and the half only a real process can
    // answer: even once `exec` has returned, an un-unref'd child handle or a
    // still-open pipe keeps node's event loop alive, so a one-shot `proteus
    // exec` that started a server would refuse to exit until the server died.
    const script = `
      import { createHostShell } from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).pathname)};
      const shell = createHostShell(process.cwd());
      await shell.exec('sleep 20 & echo started');
      // Nothing else keeps this process alive. If it lingers, the shell does.
    `;
    const started = Date.now();
    const proc = Bun.spawn(['bun', '-e', script], { stdout: 'ignore', stderr: 'pipe' });
    const exitCode = await proc.exited;
    const elapsed = Date.now() - started;

    expect(await new Response(proc.stderr).text()).toBe('');
    expect(exitCode).toBe(0);
    expect(elapsed).toBeLessThan(10_000);
  }, 40_000);

  test('output written before the command exits is not truncated by the early return', async () => {
    // The failure mode the fix must not introduce: returning on `exit` instead
    // of `close` is only correct if everything the command itself wrote is
    // still collected. A large write goes through the pipe in several chunks,
    // so this is where a naive early return loses bytes.
    const shell = createHostShell(process.cwd());
    const result = await shell.exec('seq 1 20000');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(20_000);
    expect(result.stdout).toContain('\n20000');
  }, 30_000);

  test('a failing command still reports its exit code and both streams', async () => {
    const shell = createHostShell(process.cwd());
    const result = await shell.exec('echo out; echo err 1>&2; exit 3');

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain('out');
    expect(result.stderr).toContain('err');
  });
});
