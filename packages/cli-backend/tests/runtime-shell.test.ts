/**
 * The host shell's process contract: `exec` returns when the command exits, not when every inherited pipe closes
 * (a backgrounded server holds stdout), and leaves nothing keeping the event loop alive.
 */

import { describe, expect, test } from 'bun:test';
import { createHostShell } from '../src/runtime';

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
    // `sleep 20 &` inherits the stdout pipe; the call must return when `sh` exits, not when the pipe closes.
    const shell = createHostShell(process.cwd());
    const started = Date.now();
    const result = await shell.exec('sleep 20 & echo started');
    const elapsed = Date.now() - started;

    expect(result.stdout).toContain('started');
    expect(result.exitCode).toBe(0);
    // Generous against the correct ~50ms, still far under the broken ~20s.
    expect(elapsed).toBeLessThan(3_000);
  });

  test('a backgrounded child does not keep the host process alive', async () => {
    // Even after `exec` returns, an un-unref'd child or open pipe would keep a one-shot `kinu exec` from exiting.
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
  });

  test('output written before the command exits is not truncated by the early return', async () => {
    // Returning on `exit` is only correct if a large multi-chunk write is still fully collected.
    const shell = createHostShell(process.cwd());
    const result = await shell.exec('seq 1 20000');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(20_000);
    expect(result.stdout).toContain('\n20000');
  });

  test('a failing command still reports its exit code and both streams', async () => {
    const shell = createHostShell(process.cwd());
    const result = await shell.exec('echo out; echo err 1>&2; exit 3');

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain('out');
    expect(result.stderr).toContain('err');
  });
});
