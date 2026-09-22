/** Local clamp marker: its advertised remedy, a ranged read of the named path, restores the bytes on any plane. */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildBuiltinTools, DEFAULT_TOOL_RESULT_MAX_CHARS } from '@kinu.run/core';
import { createCLIRuntime } from '../src/runtime';
import { present, scratchDir, scratchPath, toolExecute } from '@kinu.run/test-utils';
import * as v from 'valibot';

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

    const clamped = await run({
      command: `awk 'BEGIN { for (i = 0; i < 9000; i++) print "padding log line", i; print "FINAL-ERROR-LINE" }'`,
    });

    expect(clamped.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);
    expect(clamped).toContain('[truncated;');
    expect(clamped).toContain('FINAL-ERROR-LINE');
    expect(clamped).not.toContain('runtime "workspace"');

    const path = present(/full result at (\S+)\]/.exec(clamped)?.[1], 'the offload path the clamp marker names');
    expect(path).toBeTruthy();

    const router = present(rt.executionRouter, 'the runtime execution router');
    const workspace = present(router.getProvider('workspace'), 'the workspace executor');
    const restored = v.parse(v.string(), await workspace.tools.readFile.execute(path));
    expect(restored).toContain('padding log line 0');
    expect(restored).toContain('FINAL-ERROR-LINE');
    expect(restored.length).toBeGreaterThan(DEFAULT_TOOL_RESULT_MAX_CHARS);

    const grepped = await run({ command: `grep FINAL-ERROR-LINE ${path}` });
    expect(grepped).toContain('FINAL-ERROR-LINE');
    // A machine nickname is refused as unregistered, never routed to a second shell.
    const elsewhere = run({ runtime: 'device', command: `grep FINAL-ERROR-LINE ${path}` });
    await expect(elsewhere).rejects.toMatchObject({ code: 'unavailable' });
  });
});
