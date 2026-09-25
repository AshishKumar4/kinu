/**
 * A failed tool result is a message the model reads: stdout carries a test runner's diagnosis, so it must survive
 * a nonzero exit in `shell` (core/tools/builtins.ts) and inline `exec` (core/tools/inline-executor.ts).
 */

import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import { buildBuiltinTools } from '../src/tools/builtins';
import { createInlineExecutor } from '../src/tools/inline-executor';
import { createTestRuntime, storesFor } from './helpers';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type {  } from '../src/types/agent-runtime';
import type { Shell } from '../src/types/primitives';
import * as v from 'valibot';

type ShellTool = { execute: (args: { command: string; runtime?: string }) => Promise<string> };

/** Fails like a test runner: diagnosis on stdout, little or nothing on stderr. */
function failingSuiteShell(stderr = ''): Shell {
  return {
    exec: async () => ({
      stdout: [
        'FAIL tests/checkout.test.ts',
        '  ✗ applies the discount before tax',
        '    Expected: 90',
        '    Received: 108',
        '      at tests/checkout.test.ts:41',
        '1 pass, 1 fail',
      ].join('\n'),
      stderr,
      exitCode: 1,
    }),
  };
}

function shellToolOver(shell: Shell): ShellTool {
  const { rt } = createTestRuntime();
  const runtime: AgentRuntime = { ...rt, shell };
  const tools = buildBuiltinTools({ rt: runtime, history: storesFor(runtime).history });

  return { execute: toolExecute<{ command: string; runtime?: string }, string>(tools.shell) };
}

describe('a failed `shell` tells the model what actually happened', () => {
  test('a nonzero exit keeps stdout — the failing suite is legible, not swallowed', async () => {
    const tool = shellToolOver(failingSuiteShell());
    const pending = tool.execute({ command: 'bun test' });

    await expect(pending).rejects.toThrow('applies the discount before tax');
    await expect(pending).rejects.toThrow('Expected: 90');
    await expect(pending).rejects.toThrow('checkout.test.ts:41');
  });

  test('the exit code still rides along, so failure stays unambiguous', async () => {
    const tool = shellToolOver(failingSuiteShell());
    await expect(tool.execute({ command: 'bun test' })).rejects.toMatchObject({ code: 'io', execution: { exitCode: 1 } });
  });

  test('stderr is not dropped either when the command wrote to both', async () => {
    const tool = shellToolOver(failingSuiteShell('error: script "test" exited with code 1'));
    const pending = tool.execute({ command: 'bun test' });
    await expect(pending).rejects.toThrow('applies the discount before tax');
    await expect(pending).rejects.toThrow('script "test" exited with code 1');
  });

  test('a failure with no output at all says so, rather than trailing into nothing', async () => {
    const tool = shellToolOver({ exec: async () => ({ stdout: '', stderr: '', exitCode: 127 }) });
    const pending = tool.execute({ command: 'nosuchbinary' });
    await expect(pending).rejects.toMatchObject({ execution: { exitCode: 127 } });
    await expect(pending).rejects.toThrow('(no output)');
  });

  test('a successful command is unchanged — stdout only, no error framing', async () => {
    const tool = shellToolOver({
      exec: async () => ({ stdout: 'all good', stderr: 'a deprecation warning', exitCode: 0 }),
    });

    const out = await tool.execute({ command: 'bun test' });

    expect(out).toContain('all good');
    expect(out).not.toContain('Error (exit');
  });
});

describe('the inline executor `exec` honours the same contract', () => {
  function inlineExec(shell: Shell) {
    const { rt } = createTestRuntime();

    return createInlineExecutor({
      filesOwner: 'agent',
      vfs: rt.storage.vfs,
      memory: rt.memory,
      craftStore: rt.craftStore,
      shell,
      sql: rt.storage.sql,
    });
  }

  test('a nonzero exit keeps stdout', async () => {
    const exec = inlineExec(failingSuiteShell());
    const out = await exec.tools.exec.execute('bun test');
    expect(out).toMatchObject({ execution: { exitCode: 1 }, error: expect.stringContaining('applies the discount before tax') });
  });

  test('a clean run is untouched', async () => {
    const exec = inlineExec({ exec: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) });
    expect(v.parse(v.string(), await exec.tools.exec.execute('true'))).toBe('ok');
  });
});
