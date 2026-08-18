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
import { createTestRuntime, createMockSession, makeSql } from './helpers.js';
import { runMCTS } from '../src/mcts/engine.js';
import { initSearchTables } from '../src/mcts/schemas.js';
import { initScaffoldTables } from '../src/scaffold/schemas.js';
import { initCraftScoreTables } from '../src/craft/schemas.js';
import { MctsSearchStore, initMctsSearchTable } from '../src/mcts/search-store.js';
import type { AgentRuntime } from '../src/types/agent-runtime.js';

function initTables(rt: AgentRuntime): void {
  initSearchTables(rt.storage.execRaw, rt.storage.sql);
  initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
  initCraftScoreTables(rt.storage.execRaw);
  initMctsSearchTable(rt.storage.execRaw);
}

const TASK = 'pick the best database architecture';

describe('MCTS evict-resume (B6)', () => {
  test('an interrupted search resumes from checkpoint, continues remaining budget, converges', async () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const store = new MctsSearchStore(makeSql(db));

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
    const store = new MctsSearchStore(makeSql(db));

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
/** Manual console capture — bun:test's spyOn(console, …) does not intercept
 *  calls made from inside the async work `await`ed here (its own reporter
 *  appears to hold a pre-mock reference), verified against a direct count. A
 *  plain reassignment is what actually observes the calls. Both channels are
 *  captured because WHICH one carries the heartbeat is the contract under
 *  test. */
interface ConsoleCapture {
  stdout: string[];
  stderr: string[];
}

async function captureConsole<Result>(fn: () => Promise<Result>): Promise<ConsoleCapture> {
  const originalLog = console.log;
  const originalError = console.error;
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (...args: unknown[]) => { stdout.push(String(args[0])); };
  console.error = (...args: unknown[]) => { stderr.push(String(args[0])); };
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { stdout, stderr };
}

/** The heartbeat, as the typed logger emits it: one JSON line whose `event` is the
 *  stable dotted name. Keyed on the NAME rather than on prose, which is the whole
 *  point of the name — this predicate is what a Workers Logs query would be. */
const isCheckpointLine = (line: string): boolean => line.includes('"event":"mcts.checkpoint_reached"');

/** A runtime plus the durable search store — the only configuration that
 *  heartbeats at all, so both channel assertions run against it. */
function checkpointedRuntime() {
  const { rt, db } = createTestRuntime();
  initTables(rt);
  return { rt, store: new MctsSearchStore(makeSql(db)) };
}

describe('MCTS per-iteration checkpoint logging', () => {
  test('a durably-checkpointed search logs iteration/total/remaining every iteration', async () => {
    const { rt, store } = checkpointedRuntime();
    const { stderr } = await captureConsole(() =>
      runMCTS(rt, createMockSession(), TASK, { budget: 3, branches: 1, search: store }),
    );
    const checkpointLines = stderr.filter(isCheckpointLine);
    expect(checkpointLines).toHaveLength(3);
    // Fields, not prose: `iteration`/`total`/`remaining` are scalars a query can
    // filter and order on, which the old interpolated `iteration=1/3` string was not.
    expect(JSON.parse(checkpointLines[0]!).fields).toMatchObject({ iteration: 1, total: 3, remaining: 2 });
    expect(JSON.parse(checkpointLines[2]!).fields).toMatchObject({ iteration: 3, total: 3, remaining: 0 });
  });

  // Regression: the heartbeat used to go to stdout, which under
  // `proteus exec --json` IS the NDJSON event stream — four corrupt,
  // unparseable lines per run for any CI consumer. Workers Logs capture stderr
  // just the same, so one channel serves both surfaces.
  test('the heartbeat never touches stdout, which is the CLI machine channel', async () => {
    const { rt, store } = checkpointedRuntime();
    const { stdout } = await captureConsole(() =>
      runMCTS(rt, createMockSession(), TASK, { budget: 3, branches: 1, search: store }),
    );
    expect(stdout.filter(isCheckpointLine)).toHaveLength(0);
  });

  test('the fiber-snapshot-only path (no search store) stays silent', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    initCraftScoreTables(rt.storage.execRaw);
    const { stdout, stderr } = await captureConsole(() =>
      runMCTS(rt, createMockSession(), TASK, { budget: 2, branches: 1 }),
    );
    expect([...stdout, ...stderr].filter(isCheckpointLine)).toHaveLength(0);
  });
});
