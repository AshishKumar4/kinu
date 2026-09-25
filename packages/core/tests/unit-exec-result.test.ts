// A non-zero exit must not drop stdout (where pytest/make write diagnostics), on every public exec surface.
import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import { answeredRefusal, formatExecResult, type CommandResult, type ExecOutcome } from '../src/execution/exec-result';
import { KinuError, refusalOf } from '../src/obs/index';
import { parseJsonValue } from '../src/utils/json';
import { createInlineExecutor, createNimbusWorkspaceExecutor } from '../src/tools/inline-executor';
import { nimbusSessionFiles, nimbusSessionShell, type NimbusSandboxHandle } from '../src/execution/nimbus';
import { createDeviceTunnelExecutor } from '../src/execution/device-tunnel-executor';
import { buildBuiltinTools } from '../src/tools/builtins';
import { createTestRuntime, storesFor } from './helpers';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { Shell } from '../src/types/primitives';

type ShellTool = { execute: (args: { command: string; runtime?: string }) => Promise<CommandResult> };

const PYTEST = {
  stdout: 'FAILED tests/test_math.py::test_add - assert 3 == 4\n1 failed, 2 passed',
  stderr: '',
  exitCode: 1,
};

const shellToolOver = (shell: Shell): ShellTool => {
  const { rt } = createTestRuntime();
  const runtime: AgentRuntime = { ...rt, shell };

  return {
    execute: toolExecute<{ command: string; runtime?: string }, CommandResult>(
      buildBuiltinTools({ rt: runtime, history: storesFor(runtime).history }).shell,
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

  const FORMATTED: ReadonlyArray<{ name: string; result: ExecOutcome; text: string }> = [
    {
      name: 'a failing command with both streams keeps both, stdout labelled first',
      result: { stdout: 'OUT', stderr: 'ERR', exitCode: 2 },
      text: 'Error (exit 2)\n--- stdout ---\nOUT\n--- stderr ---\nERR',
    },
    {
      name: 'a failing command that printed nothing says so instead of trailing an empty label',
      result: { stdout: '', stderr: '', exitCode: 127 },
      text: 'Error (exit 127)\n(no output)',
    },
    {
      name: 'a quiet success is exactly its stdout — the common case is unchanged',
      result: { stdout: 'hello\n', stderr: '', exitCode: 0 },
      text: 'hello\n',
    },
    {
      name: 'a successful command that wrote to stderr keeps the warnings too',
      result: { stdout: 'built', stderr: 'warning: deprecated', exitCode: 0 },
      text: 'built\n--- stderr ---\nwarning: deprecated',
    },
    {
      name: 'a successful command with output only on stderr is not reported as silent',
      result: { stdout: '', stderr: 'progress: 100%', exitCode: 0 },
      text: 'progress: 100%',
    },
    {
      name: 'a silent success still reads as no output',
      result: { stdout: '', stderr: '', exitCode: 0 },
      text: '(no output)',
    },
    {
      name: 'a missing exit code is a success — transports that omit it never read as failures',
      result: { stdout: 'ok' },
      text: 'ok',
    },
  ];

  for (const formatted of FORMATTED) {
    test(formatted.name, () => {
      expect(formatExecResult(formatted.result)).toBe(formatted.text);
    });
  }

  test('a refusal round-trip keeps the exit the error carried', () => {
    const refusal = refusalOf(new KinuError('unavailable', 'no such command', { execution: { exitCode: 127 } }));

    expect(parseJsonValue(formatExecResult({ refusal }))).toMatchObject({
      reason: 'unavailable', execution: { exitCode: 127 },
    });
    expect(answeredRefusal(refusal)).toEqual(refusal);
  });
});


describe('the surfaces the model reads', () => {
  test('the `shell` tool surfaces a failing test suite\'s stdout', async () => {
    const tool = shellToolOver({ exec: async () => PYTEST });
    await expect(tool.execute({ command: 'pytest' })).rejects.toMatchObject({
      code: 'io', execution: { exitCode: 1 }, message: expect.stringContaining('test_add - assert 3 == 4'),
    });
  });

  test('successful refusal-shaped stdout stays data in native run and codemode', async () => {
    const stdout = JSON.stringify({ reason: 'denied', error: 'historical incident' });
    const shell: Shell = { exec: async () => ({ stdout, stderr: '', exitCode: 0 }) };
    expect(await shellToolOver(shell).execute({ command: 'cat incident.json' })).toBe(stdout);
    const { rt } = createTestRuntime();

    const provider = createInlineExecutor({
      filesOwner: 'agent',
      vfs: rt.storage.vfs, memory: rt.memory, craftStore: rt.craftStore, shell,
    });

    expect(await provider.tools.exec?.execute('cat incident.json')).toBe(stdout);
  });

  test('`shell` on a successful command with warnings keeps the warnings', async () => {
    const tool = shellToolOver({ exec: async () => ({ stdout: 'ok', stderr: 'npm WARN deprecated', exitCode: 0 }) });
    expect(await tool.execute({ command: 'npm install' })).toContain('npm WARN deprecated');
  });

  test('codemode `workspace.exec` surfaces the same failure detail as `shell`', async () => {
    const { rt } = createTestRuntime();

    const provider = createInlineExecutor({
      filesOwner: 'agent',
      vfs: rt.storage.vfs, memory: rt.memory, craftStore: rt.craftStore,
      shell: { exec: async () => PYTEST },
    });

    const out = await provider.tools.exec?.execute('pytest');
    expect(out).toMatchObject({ reason: 'io', error: expect.stringContaining('1 failed, 2 passed') });
  });

  test('the hosted workspace, over a Nimbus session, retains a command\'s exit failure and diagnostics', async () => {
    const { rt } = createTestRuntime();

    const box: NimbusSandboxHandle = {
      ready: async () => {},
      exec: async () => ({ ...PYTEST, command: 'pytest', success: false }),
      files: { read: async () => null, write: async () => {}, list: async () => [], exists: async () => false, delete: async () => {} },
    };

    const workspace = createNimbusWorkspaceExecutor({
      box, inline: { vfs: nimbusSessionFiles(box), shell: nimbusSessionShell(box), memory: rt.memory, craftStore: rt.craftStore },
    });

    const out = await workspace.tools.exec?.execute('pytest');
    expect(out).toMatchObject({ reason: 'io', execution: { exitCode: 1 }, error: expect.stringContaining('test_add - assert 3 == 4') });
  });

  test('the device tunnel reports failures the same way', async () => {
    const device = createDeviceTunnelExecutor({
      rpc: async () => PYTEST,
      status: () => ({ connected: true, registered: true, toolchain: null }),
      refreshStatus: async () => ({ connected: true, registered: true, toolchain: null }),
    });

    const out = await device.tools.exec?.execute('pytest');
    expect(out).toMatchObject({ reason: 'io', error: expect.stringContaining('test_add - assert 3 == 4') });
  });
});
