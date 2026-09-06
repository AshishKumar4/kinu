import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { createSandboxedExecutor } from '../src/executor';

describe('createSandboxedExecutor', () => {
  test('runs without provider arguments', async () => {
    const result = await createSandboxedExecutor().execute('7 * 6', []);
    expect(result).toEqual({ result: 42 });
  });
  test('runs module metadata in the subprocess async body', async () => {
    const executor = createSandboxedExecutor();
    expect(await executor.execute('return import.meta.main', []))
      .toEqual({ result: true });
    expect(await executor.execute('await Promise.resolve();\n({ main: import.meta.main })\n// result', []))
      .toEqual({ result: { main: true } });
    expect(await executor.execute('({ main: import.meta.main })\n// result', []))
      .toEqual({ result: { main: true } });
  });

  test('invokes codemode callables once, including a trailing comment', async () => {
    const executor = createSandboxedExecutor();
    expect(await executor.execute('async () => 42 // result', []))
      .toEqual({ result: 42 });
    let calls = 0;
    expect(await executor.execute('async () => (await probe.seed()) + 41 // result', [
      { name: 'probe', fns: { seed: async () => ++calls } },
    ])).toEqual({ result: 42 });
    expect(calls).toBe(1);
  });

  test('refuses module metadata in the in-process function context before side effects', async () => {
    let calls = 0;
    const result = await createSandboxedExecutor().execute(
      'await probe.seed(); return import.meta.main',
      [{ name: 'probe', fns: { seed: async () => ++calls } }],
    );
    expect(result.result).toBeUndefined();
    expect(result.error).toMatch(/import\.meta/);
    expect(calls).toBe(0);
  });
  test('declares installed interpreters and runs code in the requested language', async () => {
    const executor = createSandboxedExecutor();
    const installed = Bun.which('python3') !== null;
    expect(executor.languages.includes('python')).toBe(installed);
    if (!installed) return;
    const result = await executor.execute('print(40 + 2)', [], { language: 'python' });
    expect(result).toEqual({ result: '42' });
  });

  test('rejects a language it did not declare', async () => {
    const executor = createSandboxedExecutor();
    const result = await executor.execute('puts 42', [], { language: 'ruby' });
    expect(result.error).toContain('does not support language "ruby"');
  });

  // The TB2.1 nginx hang: the craft probe's code daemonized a server, the
  // daemon kept the inherited stdout pipe open after the probe exited, and the
  // EOF-bound read held `kinu exec` until the harness cap killed it. With
  // file-backed stdio the read completes at EXIT. The daemonization below is
  // the same shape (sh backgrounds a child holding the wrapper's stdio and
  // exits); a hang outlives bun's 5s default test timeout and fails red.
  test('a daemonized grandchild does not hold the executor past exit', async () => {
    const result = await createSandboxedExecutor().execute(
      'const c = Bun.spawn(["sleep", "30"], { stdout: "inherit", stderr: "inherit" });\nc.unref();\n"done"',
      [],
    );
    expect(result).toEqual({ result: 'done' });
  });

  // Red on 2026-09-05: the wrapper ran the expression form, caught its runtime
  // throw, and ran the statement form too, so a side effect before the throw
  // landed twice. The form is now chosen by parsing, and the code runs once.
  test('a throwing expression runs its side effect once, and the throw is reported', async () => {
    const marker = join(scratchDir('executor-once'), 'count.txt');
    const append = JSON.stringify(`echo x >> ${marker}`);
    const result = await createSandboxedExecutor().execute(
      `await (async () => { Bun.spawnSync(["sh", "-c", ${append}]); throw new Error("boom"); })()`,
      [],
    );
    expect(result).toEqual({ result: undefined, error: 'boom' });
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1);
  });
  test('returns the final expression across lines and trailing comments', async () => {
    const executor = createSandboxedExecutor();
    const source = 'const values = [20, 22];\nvalues.reduce(\n(sum, value) => sum + value,\n0\n)\n// result';
    expect(await executor.execute(source, [])).toEqual({ result: 42 });
    expect(await executor.execute('const n = await probe.seed();\n(n +\n41)\n// result', [
      { name: 'probe', fns: { seed: async () => 1 } },
    ])).toEqual({ result: 42 });
  });
  test('honors an explicit return after an awaited operation', async () => {
    const executor = createSandboxedExecutor();
    expect(await executor.execute('await Promise.resolve(1); return "done";', []))
      .toEqual({ result: 'done' });
    expect(await executor.execute('await probe.seed(); return "done";', [
      { name: 'probe', fns: { seed: async () => 1 } },
    ])).toEqual({ result: 'done' });
  });
});
