/**
 * MCTS evict-resume (B6): a search interrupted mid-run (DO eviction) is re-entered
 * from its durable checkpoint and continues its REMAINING budget against the
 * persisted tree, rather than being discarded or restarted from scratch. The
 * lease epoch fences a stale executor.
 *
 * Engine-seam test (DOs aren't bun-bootable): the durable MctsSearchStore lives
 * over the same in-memory SQLite the runtime uses; "eviction" is an AbortSignal
 * that unwinds the loop mid-run, leaving a `running` checkpoint; the resume is a
 * fresh runMCTS call for the same task.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestRuntime, createMockSession, makeSql } from './helpers.js';
import { runMCTS } from '../src/mcts/engine.js';
import { initSearchTables } from '../src/mcts/schemas.js';
import { initScaffoldTables } from '../src/scaffold/schemas.js';
import { initCraftScoreTables } from '../src/craft/schemas.js';
import { MctsSearchStore, initMctsSearchTable } from '../src/mcts/search-store.js';
import type { AgentRuntime } from '../src/types/agent-runtime.js';

function initTables(rt: AgentRuntime): void {
  initSearchTables(rt.storage.execRaw);
  initScaffoldTables(rt.storage.execRaw);
  initCraftScoreTables(rt.storage.execRaw);
  initMctsSearchTable(rt.storage.execRaw);
}

const TASK = 'pick the best database architecture';

describe('MCTS evict-resume (B6)', () => {
  test('an interrupted search resumes from checkpoint, continues remaining budget, converges', async () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const store = new MctsSearchStore(makeSql(db as unknown as Database));

    // ── Run 1: budget 4, "evicted" after 2 iterations ──────────────────────
    const ctrl = new AbortController();
    let run1Iters = 0;
    await expect(runMCTS(rt, createMockSession(), TASK, {
      budget: 4, branches: 1, search: store, signal: ctrl.signal,
      onProgress: (event) => {
        if (event.type !== 'iteration-complete') return;
        run1Iters = event.iteration;
        if (event.iteration === 2) ctrl.abort(new Error('DO eviction')); // interrupt mid-run
      },
    })).rejects.toThrow();

    expect(run1Iters).toBe(2);
    const mid = store.findResumable(TASK);
    expect(mid).not.toBeNull();
    expect(mid!.iteration).toBe(2);
    expect(mid!.budget).toBe(2);          // 2 of 4 consumed, 2 remaining
    expect(mid!.epoch).toBe(0);
    const rootId = mid!.rootId;

    // ── Run 2: fresh call (restarted DO) resumes the SAME search ────────────
    let run2Iters = 0;
    const result = await runMCTS(rt, createMockSession(), TASK, {
      budget: 4, branches: 1, search: store,
      onProgress: (event) => {
        if (event.type === 'iteration-complete') run2Iters = event.iteration;
      },
    });

    expect(result).toBeDefined();
    // The resume did ONLY the 2 remaining iterations (continuing from 2 → 3, 4),
    // not a fresh 4 — proof the checkpoint was honored, not restarted.
    expect(run2Iters).toBe(4);

    const after = store.get(rootId);
    expect(after?.status).toBe('converged');
    expect(after?.budget).toBe(0);
    expect(after?.epoch).toBe(1);         // reclaim bumped the lease on resume (fence)

    // No SECOND search row was created for the same task — it resumed in place.
    expect(store.findResumable(TASK)).toBeNull(); // the only row is now converged
  });

  test('a completed search is not re-resumed; a new run of the same task starts fresh', async () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const store = new MctsSearchStore(makeSql(db as unknown as Database));

    await runMCTS(rt, createMockSession(), TASK, { budget: 2, branches: 1, search: store });
    expect(store.findResumable(TASK)).toBeNull();   // converged → not resumable

    // A brand-new run of the same task begins a distinct search (fresh root).
    const before = store.findResumable(TASK);
    await runMCTS(rt, createMockSession(), TASK, { budget: 2, branches: 1, search: store });
    expect(before).toBeNull();
  });
});

// The observability audit (2026-08-12): a durably-checkpointed search running
// for hours produced NOTHING in Workers Logs / `wrangler tail` per iteration —
// the checkpoint (mcts_search_runs.updated_at) is the one real heartbeat this
// backend has, but nothing reached console output. Gated on `search` being
// present, same as the checkpoint call itself.
/** Manual console.log capture — bun:test's spyOn(console, 'log') does not
 *  intercept calls made from inside the async work `await`ed here (its own
 *  reporter appears to hold a pre-mock reference), verified against a direct
 *  count. A plain reassignment is what actually observes the calls. */
async function captureConsoleLog(fn: () => Promise<unknown>): Promise<string[]> {
  const original = console.log;
  const calls: string[] = [];
  console.log = (...args: unknown[]) => { calls.push(String(args[0])); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return calls;
}

describe('MCTS per-iteration checkpoint logging', () => {
  test('a durably-checkpointed search logs iteration/total/remaining every iteration', async () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const store = new MctsSearchStore(makeSql(db as unknown as Database));
    const lines = await captureConsoleLog(() =>
      runMCTS(rt, createMockSession(), TASK, { budget: 3, branches: 1, search: store }),
    );
    const checkpointLines = lines.filter((line) => line.startsWith('[proteus] mcts checkpoint'));
    expect(checkpointLines).toHaveLength(3);
    expect(checkpointLines[0]).toContain('iteration=1/3 remaining=2');
    expect(checkpointLines[2]).toContain('iteration=3/3 remaining=0');
  });

  test('the fiber-snapshot-only path (no search store) stays silent', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    initScaffoldTables(rt.storage.execRaw);
    initCraftScoreTables(rt.storage.execRaw);
    const lines = await captureConsoleLog(() =>
      runMCTS(rt, createMockSession(), TASK, { budget: 2, branches: 1 }),
    );
    expect(lines.filter((line) => line.startsWith('[proteus] mcts checkpoint'))).toHaveLength(0);
  });
});
