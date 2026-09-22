/**
 * Clamp-marker honesty on the LOCAL backend. The clamp offloads full outputs
 * to the workspace filesystem, and the marker's advertised remedy is a ranged
 * read of the path it names — the one path that restores the bytes whichever
 * plane the session is bound to.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildBuiltinTools, DEFAULT_TOOL_RESULT_MAX_CHARS } from '@kinu.run/core';
import { createCLIRuntime } from '../src/runtime';
import { present, scratchDir, scratchPath, toolExecute } from '@kinu.run/test-utils';
import * as v from 'valibot';

/** A session bound to a directory: the machine is the workspace, and its
 *  shell is the real one there. */
function localRuntime() {
  const db = new Database(scratchPath('clamp-marker', 'agent.db'), { create: true });

  return createCLIRuntime(db, {
    dbPath: db.filename,
    llm: { name: 'x', baseURL: 'http://localhost:0', headers: {}, model: 'm' },
    cwd: scratchDir('clamp-marker-cwd'),
  });
}

describe('clamped run output on the local backend', () => {
  test('the marker remedy round-trips: a ranged read restores what the host shell cannot see', async () => {
    const rt = localRuntime();
    const tools = buildBuiltinTools({ rt, history: rt.stores.history });
    const run = toolExecute<{ command: string; runtime?: string }, string>(tools.shell);

    // A real host command whose output blows the clamp budget, on the one
    // runtime the CLI has: the workspace shell, which here is the machine's.
    const clamped = await run({
      command: `awk 'BEGIN { for (i = 0; i < 9000; i++) print "padding log line", i; print "FINAL-ERROR-LINE" }'`,
    });

    expect(clamped.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);
    expect(clamped).toContain('[truncated;');
    expect(clamped).toContain('FINAL-ERROR-LINE');
    expect(clamped).not.toContain('runtime "workspace"');

    const path = present(/full result at (\S+)\]/.exec(clamped)?.[1], 'the offload path the clamp marker names');
    expect(path).toBeTruthy();

    // Following the marker's own instruction: the eval workspace
    // surface restores the full text.
    const router = present(rt.executionRouter, 'the runtime execution router');
    const workspace = present(router.getProvider('workspace'), 'the workspace executor');
    const restored = v.parse(v.string(), await workspace.tools.readFile.execute(path));
    expect(restored).toContain('padding log line 0');
    expect(restored).toContain('FINAL-ERROR-LINE');
    expect(restored.length).toBeGreaterThan(DEFAULT_TOOL_RESULT_MAX_CHARS);

    // The offload lands in the agent's OWN filesystem, so the workspace shell
    // can also grep it — a remedy the marker could not offer while that shell
    // was an emulator over a different plane.
    const grepped = await run({ command: `grep FINAL-ERROR-LINE ${path}` });
    expect(grepped).toContain('FINAL-ERROR-LINE');
    // There is no other runtime to name: a machine nickname is refused as an
    // unregistered machine, never routed to a second shell over this tree.
    const elsewhere = run({ runtime: 'device', command: `grep FINAL-ERROR-LINE ${path}` });
    await expect(elsewhere).rejects.toMatchObject({ code: 'unavailable' });
  });
});
