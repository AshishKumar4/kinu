import { describe, expect, test } from 'bun:test';
import { createSandboxedExecutor } from '../src/executor';

describe('createSandboxedExecutor', () => {
  test('runs without provider arguments', async () => {
    const result = await createSandboxedExecutor().execute('7 * 6', []);
    expect(result).toEqual({ result: 42 });
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
  // EOF-bound read held `proteus exec` until the harness cap killed it. With
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
});
