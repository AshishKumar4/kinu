// What a shell command's outcome looks like to the model.
//
// The regression these tests pin: a non-zero exit used to return stderr alone,
// so a failing `pytest`/`make` — which writes its diagnostics to stdout —
// reached the model as an exit code and nothing else. Asserted through the
// PUBLIC surfaces the model actually reads (the `run` tool, codemode
// `workspace.exec`, an executor's `exec`), not just the renderer.
import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@proteus/test-utils';
import { formatExecResult } from '../src/execution/exec-result';
import { createInlineExecutor } from '../src/execution/inline';
import { createNimbusExecutor } from '../src/execution/nimbus';
import { createDeviceTunnelExecutor } from '../src/execution/device-tunnel-executor';
import { buildBuiltinTools } from '../src/tools/builtins';
import { createTestRuntime } from './helpers';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { Shell } from '../src/types/primitives';

type RunTool = { execute: (args: { command: string; runtime?: string }) => Promise<string> };

/** A pytest-shaped failure: everything diagnostic on stdout, nothing on stderr. */
const PYTEST = {
  stdout: 'FAILED tests/test_math.py::test_add - assert 3 == 4\n1 failed, 2 passed',
  stderr: '',
  exitCode: 1,
};

const runToolOver = (shell: Shell): RunTool => {
  const { rt } = createTestRuntime();
  const runtime: AgentRuntime = { ...rt, shell };
  return {
    execute: toolExecute<{ command: string; runtime?: string }, string>(
      buildBuiltinTools({ rt: runtime }).run,
    ),
  };
};

describe('formatExecResult', () => {
  test('a failing command shows the exit code AND stdout — the diagnostics are on stdout', () => {
    const out = formatExecResult(PYTEST);
    expect(out).toStartWith('Error (exit 1)');
    expect(out).toContain('test_add - assert 3 == 4');
    expect(out).toContain('1 failed, 2 passed');
  });

  test('a failing command with both streams keeps both, stdout labelled first', () => {
    const out = formatExecResult({ stdout: 'OUT', stderr: 'ERR', exitCode: 2 });
    expect(out).toBe('Error (exit 2)\n--- stdout ---\nOUT\n--- stderr ---\nERR');
  });

  test('a failing command that printed nothing says so instead of trailing an empty label', () => {
    expect(formatExecResult({ stdout: '', stderr: '', exitCode: 127 })).toBe('Error (exit 127)\n(no output)');
  });

  test('a quiet success is exactly its stdout — the common case is unchanged', () => {
    expect(formatExecResult({ stdout: 'hello\n', stderr: '', exitCode: 0 })).toBe('hello\n');
  });

  test('a successful command that wrote to stderr keeps the warnings too', () => {
    const out = formatExecResult({ stdout: 'built', stderr: 'warning: deprecated', exitCode: 0 });
    expect(out).toBe('built\n--- stderr ---\nwarning: deprecated');
  });

  test('a successful command with output only on stderr is not reported as silent', () => {
    expect(formatExecResult({ stdout: '', stderr: 'progress: 100%', exitCode: 0 })).toBe('progress: 100%');
  });

  test('a silent success still reads as no output', () => {
    expect(formatExecResult({ stdout: '', stderr: '', exitCode: 0 })).toBe('(no output)');
  });

  test('a missing exit code is a success — transports that omit it never read as failures', () => {
    expect(formatExecResult({ stdout: 'ok' })).toBe('ok');
  });
});

describe('the surfaces the model reads', () => {
  test('the `run` tool surfaces a failing test suite\'s stdout', async () => {
    const run = runToolOver({ exec: async () => PYTEST });
    const out = await run.execute({ command: 'pytest' });
    expect(out).toContain('test_add - assert 3 == 4');
    expect(out).toStartWith('Error (exit 1)');
  });

  test('`run` on a successful command with warnings keeps the warnings', async () => {
    const run = runToolOver({ exec: async () => ({ stdout: 'ok', stderr: 'npm WARN deprecated', exitCode: 0 }) });
    expect(await run.execute({ command: 'npm install' })).toContain('npm WARN deprecated');
  });

  test('codemode `workspace.exec` surfaces the same failure detail as `run`', async () => {
    const { rt } = createTestRuntime();
    const provider = createInlineExecutor({
      vfs: rt.storage.vfs, memory: rt.memory, craftStore: rt.craftStore,
      shell: { exec: async () => PYTEST },
    });
    const out = String(await provider.tools.exec!.execute('pytest'));
    expect(out).toStartWith('Error (exit 1)');
    expect(out).toContain('1 failed, 2 passed');
  });

  test('a remote container exec reports failures with the `Error` prefix the harness detects', async () => {
    const nimbus = createNimbusExecutor({
      box: {
        ready: async () => {},
        exec: async () => ({ ...PYTEST, command: 'pytest', success: false }),
        files: {
          read: async () => null,
          write: async () => {},
          list: async () => [],
          exists: async () => false,
          delete: async () => {},
        },
      },
    });
    const out = String(await nimbus.tools.exec!.execute('pytest'));
    expect(out).toStartWith('Error (exit 1)');
    expect(out).toContain('test_add - assert 3 == 4');
  });

  test('the device tunnel reports failures the same way', async () => {
    const laptop = createDeviceTunnelExecutor({
      rpc: async () => PYTEST,
      status: () => ({ connected: true, registered: true }),
      refreshStatus: async () => ({ connected: true, registered: true }),
    });
    const out = String(await laptop.tools.exec!.execute('pytest'));
    expect(out).toStartWith('Error (exit 1)');
    expect(out).toContain('test_add - assert 3 == 4');
  });
});
