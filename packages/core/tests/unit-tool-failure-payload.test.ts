/**
 * What the MODEL sees when a tool fails.
 *
 * The suite has always been good at "the tool failed" and blind to "and this is
 * what came back". Those are different assertions, and only the second one is
 * the contract: a failed tool result is not an error code the runtime consumes,
 * it is a message the model reads and acts on. If the payload is empty the turn
 * is over — the model has no way to know what broke, so it guesses, retries the
 * same command, or declares success.
 *
 * The defect these lock: `run` reported ONLY stderr on a nonzero exit and threw
 * stdout away. Every test runner on earth prints its failures to stdout and
 * exits nonzero — `pytest`, `bun test`, `cargo test`, `make`. So the model ran
 * the suite, got back `Error (exit 1): ` with nothing after the colon, and had
 * to re-run it redirected to see anything. It survived the whole suite because
 * every existing test asserted only the `Error (exit N)` prefix.
 *
 * Three implementations of one contract, so all three are pinned here:
 *   - the `run` builtin over the workspace shell (core/tools/builtins.ts)
 *   - the inline executor's `exec` (core/execution/inline.ts)
 *   - the local `laptop` executor's `exec` (cli-backend, covered in its own suite)
 */

import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import { buildBuiltinTools } from '../src/tools/builtins';
import { createInlineExecutor } from '../src/execution/inline';
import { createTestRuntime } from './helpers';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type {  } from '../src/types/agent-runtime';
import type { Shell } from '../src/types/primitives';

type RunTool = { execute: (args: { command: string; runtime?: string }) => Promise<string> };

/** A shell whose command failed the way a test runner fails: the diagnosis on
 *  stdout, a bare summary line (or nothing at all) on stderr, nonzero exit. */
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

function runToolOver(shell: Shell): RunTool {
  const { rt } = createTestRuntime();
  const runtime: AgentRuntime = { ...rt, shell };
  const tools = buildBuiltinTools({ rt: runtime });
  return { execute: toolExecute<{ command: string; runtime?: string }, string>(tools.run) };
}

describe('a failed `run` tells the model what actually happened', () => {
  test('a nonzero exit keeps stdout — the failing suite is legible, not swallowed', async () => {
    const run = runToolOver(failingSuiteShell());
    const out = await run.execute({ command: 'bun test' });

    // The diagnosis, not just the verdict. Without these the model is told only
    // that something exited 1, which is the same information as no message.
    expect(out).toContain('applies the discount before tax');
    expect(out).toContain('Expected: 90');
    expect(out).toContain('checkout.test.ts:41');
  });

  test('the exit code still rides along, so failure stays unambiguous', async () => {
    const run = runToolOver(failingSuiteShell());
    const out = await run.execute({ command: 'bun test' });

    // Keeping stdout must not cost the failure signal: a model that only sees
    // suite output cannot tell a failing run from a passing one that printed
    // the word "fail", and the delegation nudge reads this prefix too.
    expect(out).toMatch(/exit 1/);
  });

  test('stderr is not dropped either when the command wrote to both', async () => {
    const run = runToolOver(failingSuiteShell('error: script "test" exited with code 1'));
    const out = await run.execute({ command: 'bun test' });

    expect(out).toContain('applies the discount before tax');
    expect(out).toContain('script "test" exited with code 1');
  });

  test('a failure with no output at all says so, rather than trailing into nothing', async () => {
    const run = runToolOver({ exec: async () => ({ stdout: '', stderr: '', exitCode: 127 }) });
    const out = await run.execute({ command: 'nosuchbinary' });

    // The degenerate case: the model must be able to distinguish "the command
    // said nothing" from "the payload lost what it said".
    expect(out).toMatch(/exit 127/);
    expect(out.trim()).not.toMatch(/exit 127\)?:?$/);
  });

  test('a successful command is unchanged — stdout only, no error framing', async () => {
    const run = runToolOver({
      exec: async () => ({ stdout: 'all good', stderr: 'a deprecation warning', exitCode: 0 }),
    });
    const out = await run.execute({ command: 'bun test' });

    expect(out).toContain('all good');
    expect(out).not.toContain('Error (exit');
  });
});

describe('the inline executor `exec` honours the same contract', () => {
  function inlineExec(shell: Shell) {
    const { rt } = createTestRuntime();
    return createInlineExecutor({
      vfs: rt.storage.vfs,
      memory: rt.memory,
      craftStore: rt.craftStore,
      shell,
      sql: rt.storage.sql,
    });
  }

  test('a nonzero exit keeps stdout', async () => {
    const exec = inlineExec(failingSuiteShell());
    const out = String(await exec.tools.exec.execute('bun test'));

    expect(out).toContain('applies the discount before tax');
    expect(out).toMatch(/exit 1/);
  });

  test('a clean run is untouched', async () => {
    const exec = inlineExec({ exec: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) });
    expect(String(await exec.tools.exec.execute('true'))).toBe('ok');
  });
});
