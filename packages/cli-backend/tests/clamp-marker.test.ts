/**
 * Clamp-marker honesty on the LOCAL backend. Here rt.shell is the HOST shell
 * (the user's machine at cwd) while the clamp offloads full outputs to the
 * workspace filesystem — two different filesystems. The marker's advertised
 * remedy must therefore be workspace.readFile (execute_tools, same VFS on
 * every backend), never a host-shell grep of the offload path.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildBuiltinTools, DEFAULT_TOOL_RESULT_MAX_CHARS } from '@kinu.run/core';
import { createCLIRuntime } from '../src/runtime';
import { scratchPath, toolExecute } from '@kinu.run/test-utils';

function localRuntime() {
  const db = new Database(':memory:');
  return createCLIRuntime(db, {
    dbPath: scratchPath('clamp-marker', 'agent.db'),
    llm: { name: 'x', baseURL: 'http://localhost:0', headers: {}, model: 'm' },
  });
}

describe('clamped run output on the local backend', () => {
  test('the marker remedy round-trips: workspace.readFile restores what the host shell cannot see', async () => {
    const rt = localRuntime();
    const tools = buildBuiltinTools({ rt });
    const run = toolExecute<{ command: string; runtime?: string }, string>(tools.run);

    // A real HOST command whose output blows the clamp budget. `laptop` is
    // where the machine is now — the default `workspace` runtime is the
    // agent's own filesystem and its own shell.
    const clamped = await run({
      runtime: 'laptop',
      command: `awk 'BEGIN { for (i = 0; i < 9000; i++) print "padding log line", i; print "FINAL-ERROR-LINE" }'`,
    });
    expect(clamped.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS + 300);
    expect(clamped).toContain('chars omitted');
    expect(clamped).toContain('FINAL-ERROR-LINE');
    // The marker advertises only the remedy that works here.
    expect(clamped).toContain('workspace.readFile inside execute_tools');
    expect(clamped).not.toContain('runtime "workspace"');

    const path = /full output saved to (\S+) —/.exec(clamped)?.[1];
    expect(path).toBeTruthy();

    // Following the marker's own instruction: the execute_tools workspace
    // surface restores the full text.
    const workspace = rt.executionRouter!.getProvider('workspace')!;
    const restored = await workspace.tools.readFile!.execute(path);
    expect(String(restored)).toContain('padding log line 0');
    expect(String(restored)).toContain('FINAL-ERROR-LINE');
    expect(String(restored).length).toBeGreaterThan(DEFAULT_TOOL_RESULT_MAX_CHARS);

    // The offload lands in the agent's OWN filesystem, so the workspace shell
    // can also grep it — a remedy the marker could not offer while that shell
    // was an emulator over a different plane.
    const grepped = await run({ command: `grep FINAL-ERROR-LINE ${path}` });
    expect(grepped).toContain('FINAL-ERROR-LINE');
    // The host shell cannot: it is a different machine with a different
    // filesystem, which is exactly why the marker names workspace.readFile.
    const onHost = await run({ runtime: 'laptop', command: `grep FINAL-ERROR-LINE ${path}` });
    expect(onHost).toContain('Error');
  });
});
