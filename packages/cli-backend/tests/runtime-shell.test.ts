/**
 * The host shell's process contract: `exec` returns when the command exits, not when every inherited pipe closes
 * (a backgrounded server holds stdout), leaves nothing keeping the event loop alive, reports a signal death as
 * that signal, and holds a flood of output in bounded memory.
 */

import { describe, expect, test } from 'bun:test';
import { constants } from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { scratchDir } from '@kinu.run/test-utils';
import { createHostShell } from '../src/runtime';

const FloodReportSchema = v.object({ grew: v.number(), exitCode: v.number(), stdout: v.string() });

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

  test('a command killed by a signal reports that signal, never exit 0', async () => {
    const shell = createHostShell(process.cwd());

    for (const name of ['SIGSEGV', 'SIGABRT', 'SIGBUS'] as const) {
      const expected = 128 + constants.signals[name];
      const flag = name.slice(3);
      // The login shell itself dies; then a lone binary the shell execs dies (what bash does to a one-command line).
      const throughShell = await shell.exec(`kill -${flag} $$`);
      const loneBinary = await shell.exec(`exec sh -c 'kill -${flag} $$'`);
      // The catalog's spelling: dash forks the inner shell and reports its death itself; bash execs it.
      const nested = await shell.exec(`sh -c 'kill -${flag} $$'`);

      expect({ name, exitCode: throughShell.exitCode, named: throughShell.stderr.includes(name) }).toEqual({ name, exitCode: expected, named: true });
      expect({ name, exitCode: loneBinary.exitCode, named: loneBinary.stderr.includes(name) }).toEqual({ name, exitCode: expected, named: true });
      expect({ name, exitCode: nested.exitCode }).toEqual({ name, exitCode: expected });
    }
  });

  // Peak resident memory is read from the kernel's high-water mark (`VmHWM`, reset at exec), so the capture runs
  // in its own process and nothing samples on a timer. /proc is Linux's.
  test.skipIf(process.platform !== 'linux')('a 400 MB single-line print is captured in bounded memory; head, tail and the saved whole survive', async () => {
    const dir = scratchDir('host-shell-flood');

    const script = `
      import { readFileSync } from 'node:fs';
      import { createHostShell } from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).pathname)};
      const peak = () => Number(/VmHWM:\\s+(\\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8'))?.[1]) * 1024;
      const before = peak();
      const result = await createHostShell(${JSON.stringify(dir)}).exec("head -c 400000000 /dev/zero | tr '\\\\0' a; printf END");
      process.stdout.write(JSON.stringify({ grew: peak() - before, exitCode: result.exitCode, stdout: result.stdout }));
    `;

    const proc = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'inherit' });
    const report = v.parse(FloodReportSchema, JSON.parse(await new Response(proc.stdout).text()));
    await proc.exited;
    const saved = /the full stdout is at (\S+)\]/.exec(report.stdout)?.[1] ?? '';

    expect(report.grew).toBeLessThan(256 * 1024 * 1024);
    expect(report.exitCode).toBe(0);
    expect(report.stdout.length).toBeLessThan(1024 * 1024);
    expect(report.stdout.startsWith('a'.repeat(4096))).toBe(true);
    expect(report.stdout).toContain(`${'a'.repeat(4096)}END\n`);
    expect(report.stdout).toContain('[stdout: 400000003 bytes, ');
    expect(statSync(join(dir, saved)).size).toBe(400_000_003);
    expect(readFileSync(join(dir, saved)).subarray(-3).toString()).toBe('END');
  });
});
