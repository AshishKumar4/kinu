/**
 * The host shell's process contract: `exec` returns when the command exits, not when every inherited pipe closes
 * (a backgrounded server holds stdout), leaves nothing keeping the event loop alive, reports a signal death as
 * that signal, and holds a flood of output in bounded memory.
 */

import { describe, expect, test } from 'bun:test';
import { constants } from 'node:os';
import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { awaitExit, runToExit, scratchDir } from '@kinu.run/test-utils';
import { tolerate } from '@kinu.run/core/obs';
import { createHostShell } from '../src/runtime';
import { shellQuote } from '@kinu.run/core';

const FloodReportSchema = v.object({ grew: v.number(), exitCode: v.number(), stdout: v.string() });

async function endBackgrounded(stdout: string): Promise<void> {
  const pid = Number(/started (\d+)/u.exec(stdout)?.[1]);

  expect(pid).toBeGreaterThan(0);
  expect((await runToExit(['kill', '-0', String(pid)])).exitCode).toBe(0);
  tolerate(() => process.kill(pid, 'SIGKILL'), 'esrch');
  await awaitExit(pid);
}

async function pipeGate(): Promise<{ home: string; fifo: string; resident: string }> {
  const home = scratchDir('host-shell');
  const fifo = join(home, 'release');
  const made = await runToExit(['mkfifo', fifo]);

  if (made.exitCode !== 0) throw new Error(made.stderr);

  return { home, fifo, resident: 'sh -c ' + shellQuote('read released < ' + shellQuote(fifo)) + ' & echo started $!' };
}

describe('createHostShell', () => {
  test('aborts a running command through AbortSignal', async () => {
    const shell = createHostShell(process.cwd());
    const controller = new AbortController();
    const gate = await pipeGate();
    const readyFile = join(gate.home, 'ready');
    const entered = Promise.withResolvers<void>();
    const observer = watch(gate.home, () => { if (existsSync(readyFile)) entered.resolve(); });
    observer.once('error', entered.reject);
    const command = shell.exec('printf ready > ' + shellQuote(readyFile) + '; read released < ' + shellQuote(gate.fifo) + '; echo done', { signal: controller.signal });

    try {
      await Promise.race([entered.promise, command.then(() => { if (!controller.signal.aborted) throw new Error('the command exited before the abort'); })]);
      controller.abort(new Error('stop requested'));
      const result = await command;
      expect(result.stdout).not.toContain('done');
      expect(result.stderr).toContain('Command aborted.');
      expect(result.exitCode).toBe(130);
    } finally {
      observer.close();
    }
  });

  test('returns when the command finishes while its child still holds stdout', async () => {
    const shell = createHostShell(process.cwd());
    const gate = await pipeGate();
    const result = await shell.exec(gate.resident);

    await endBackgrounded(result.stdout);
    expect(result.stdout).toContain('started');
    expect(result.exitCode).toBe(0);
  });

  test('a backgrounded child does not keep the host process alive', async () => {
    const gate = await pipeGate();

    const script = `
      import { createHostShell } from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).pathname)};
      const shell = createHostShell(process.cwd());
      const { stdout } = await shell.exec(${JSON.stringify(gate.resident)});
      process.stdout.write(stdout);
    `;

    const proc = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;

    await endBackgrounded(await new Response(proc.stdout).text());
    expect(await new Response(proc.stderr).text()).toBe('');
    expect(exitCode).toBe(0);
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
