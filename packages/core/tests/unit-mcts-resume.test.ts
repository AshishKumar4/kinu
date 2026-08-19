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
import { createTestRuntime, createMockSession, makeSql, captureConsole } from './helpers';
import { runMCTS } from '../src/mcts/engine';
import { initSearchTables } from '../src/mcts/schemas';
import { initScaffoldTables } from '../src/scaffold/schemas';
import { initCraftScoreTables } from '../src/craft/schemas';
import { MctsSearchStore, initMctsSearchTable } from '../src/mcts/search-store';
import type { AgentRuntime } from '../src/types/agent-runtime';

function initTables(rt: AgentRuntime): void {
  initSearchTables(rt.storage.execRaw, rt.storage.sql);
  initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
  initCraftScoreTables(rt.storage.execRaw);
  initMctsSearchTable(rt.storage.execRaw, rt.storage.sql);
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

/**
 * The judge ensemble a run was OBSERVED to sample, folded onto its ledger row.
 *
 * The number exists because the two spend knobs share one per-evaluation call pool, so
 * a request the pool cannot fund is realised lower — and it used to be disclosed once,
 * in the settle report of the call that ran, and persisted nowhere. `fork-params.ts`
 * answered a reader by recomputing the pool's CEILING from the knobs, which is not what
 * a run that short-circuited before judging actually sampled.
 */
describe('the ledger records the ensemble a run was observed to sample', () => {
  function ledger() {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const store = new MctsSearchStore(makeSql(db));
    store.begin({
      rootId: 'r1', task: TASK, engine: 'mcts', rootMsgId: 'm1',
      config: { budget: 2, branches: 2, judgeSamples: 20 }, budget: 2, now: 1_000,
    });
    const realised = () => makeSql(db)<{ judge_samples_realised: number | null }>`
      SELECT judge_samples_realised FROM mcts_search_runs WHERE root_id = 'r1'`[0]
      ?.judge_samples_realised ?? null;
    return { store, realised };
  }

  test('a fresh row claims nothing until an ensemble is actually observed', () => {
    expect(ledger().realised()).toBeNull();
  });

  test('the SMALLEST observation wins, whichever order the observations arrive in', () => {
    // The number answers "was the request honoured", so a run that funded one candidate
    // and clamped the next did clamp. Ascending and descending both, because a
    // last-write-wins fold passes one order and fails the other.
    const ascending = ledger();
    for (const seen of [2, 5, 9]) ascending.store.observeJudgeEnsemble('r1', seen);
    expect(ascending.realised()).toBe(2);

    const descending = ledger();
    for (const seen of [9, 5, 2]) descending.store.observeJudgeEnsemble('r1', seen);
    expect(descending.realised()).toBe(2);
  });

  test('an observation for a root with no ledger row changes nothing', () => {
    // A search whose settled row was pruned still has its tree, and a late observation
    // against it must not resurrect a row: the fold is an UPDATE, never an upsert.
    const { store, realised } = ledger();
    store.observeJudgeEnsemble('some-other-root', 3);
    expect(realised()).toBeNull();
  });
});

/**
 * Two engines write this ledger, and only one of them has a resume loop.
 *
 * `findResumable` keys on `status='running' AND task=?`, so without the engine column a
 * swarm that died mid-run would be handed to the MCTS loop as a resumable search of the
 * same task — which would then expand the swarm's tree with judged branches under the
 * swarm's own root id and report the result as that run's. A swarm's config parses as a
 * persisted MCTS config, so nothing downstream would notice.
 */
describe('the resume loop reclaims its own engine only', () => {
  test('a still-running swarm row is never handed to the resume loop', () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const store = new MctsSearchStore(makeSql(db));
    store.begin({
      rootId: 'swarm-root', task: TASK, engine: 'swarm', rootMsgId: null,
      config: { budget: 6, branches: 3, mode: 'build', maxDepth: 2 }, budget: 6, now: 1_000,
    });

    // THE DENOMINATOR, so this cannot pass for the wrong reason: the row is running and
    // its task is the one being asked for, which is every condition `findResumable`
    // matches on except the engine.
    expect(store.get('swarm-root')).toMatchObject({ status: 'running' });
    expect(store.findResumable(TASK, 'build')).toBeNull();

    // And the engine's own row beside it still resumes, so this is a filter rather than a
    // resume that quietly stopped working.
    store.begin({
      rootId: 'mcts-root', task: TASK, engine: 'mcts', rootMsgId: 'm1',
      config: { budget: 4, branches: 2, mode: 'build' }, budget: 4, now: 2_000,
    });
    expect(store.findResumable(TASK, 'build')?.rootId).toBe('mcts-root');
  });

  test('the ledger lists both engines and says which each row is', () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const store = new MctsSearchStore(makeSql(db));
    store.begin({
      rootId: 'swarm-root', task: TASK, engine: 'swarm', rootMsgId: null,
      config: { budget: 6, branches: 3 }, budget: 6, now: 1_000,
    });
    store.begin({
      rootId: 'mcts-root', task: TASK, engine: 'mcts', rootMsgId: 'm1',
      config: { budget: 4, branches: 2 }, budget: 4, now: 2_000,
    });
    const listed = store.list(10);
    expect(listed).toHaveLength(2);
    expect(listed.map((row) => [row.rootId, row.engine]))
      .toEqual([['mcts-root', 'mcts'], ['swarm-root', 'swarm']]);
  });
});
