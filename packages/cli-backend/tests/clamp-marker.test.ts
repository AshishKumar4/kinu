/**
 * Clamp-marker honesty on the LOCAL backend. Here rt.shell is the HOST shell
 * (the user's machine at cwd) while the clamp offloads full outputs to the
 * SqliteFS workspace VFS — two different filesystems. The marker's advertised
 * remedy must therefore be workspace.readFile (execute_tools, same VFS on
 * every backend), never a host-shell grep of the offload path.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildBuiltinTools, DEFAULT_TOOL_RESULT_MAX_CHARS } from '@proteus/core';
import { createCLIRuntime } from '../src/runtime.js';

type RunTool = { execute: (args: { command: string; runtime?: string }, options?: unknown) => Promise<string> };

function localRuntime() {
  const db = new Database(':memory:');
  return createCLIRuntime(db as never, {
    dbPath: `/tmp/proteus-clamp-${Math.floor(performance.now())}.db`,
    llm: { name: 'x', baseURL: 'http://localhost:0', headers: {}, model: 'm' },
  });
}

describe('clamped run output on the local backend', () => {
  test('the marker remedy round-trips: workspace.readFile restores what the host shell cannot see', async () => {
    const rt = localRuntime();
    const tools = buildBuiltinTools({ rt });
    const run = tools.run as unknown as RunTool;

    // A real host command whose output blows the clamp budget.
    const clamped = await run.execute({
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
    // surface (inline executor over the SqliteFS VFS) restores the full text.
    const workspace = rt.executionRouter!.getProvider('workspace')!;
    const restored = await workspace.tools.readFile!.execute(path);
    expect(String(restored)).toContain('padding log line 0');
    expect(String(restored)).toContain('FINAL-ERROR-LINE');
    expect(String(restored).length).toBeGreaterThan(DEFAULT_TOOL_RESULT_MAX_CHARS);

    // And the reason the old shell remedy was dropped: the offload file does
    // not exist on the host filesystem the local run-tool shell executes on.
    const grep = await run.execute({ command: `grep FINAL-ERROR-LINE ${path}` });
    expect(grep).toContain('Error');
  });
});
