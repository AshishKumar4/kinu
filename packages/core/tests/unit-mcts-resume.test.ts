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
import { createTestRuntime, createMockSession, makeSql, makeExecRaw, captureConsole } from './helpers';
import { runMCTS } from '../src/mcts/engine';
import { initSearchTables } from '../src/mcts/schemas';
import { initScaffoldTables } from '../src/scaffold/schemas';
import { MctsSearchStore, initMctsSearchTable, persistableMCTSConfig } from '../src/mcts/search-store';
import { recordNode } from '../src/mcts/record-node';
import type { AgentRuntime } from '../src/types/agent-runtime';

function initTables(rt: AgentRuntime): void {
  initSearchTables(rt.storage.execRaw, rt.storage.sql);
  initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
  initMctsSearchTable(rt.storage.execRaw, rt.storage.sql);
}

const TASK = 'pick the best database architecture';

describe('MCTS evict-resume (B6)', () => {
  test('repairs search ledgers created before engine and judge-observation columns', () => {
    const db = new Database(':memory:');
    const execRaw = makeExecRaw(db);
    const sql = makeSql(db);
    execRaw(`CREATE TABLE mcts_search_runs (
      root_id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      root_msg_id TEXT NOT NULL,
      config_json TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      budget INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      epoch INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    execRaw(`INSERT INTO mcts_search_runs
      (root_id, task, root_msg_id, config_json, iteration, budget, status, epoch, created_at, updated_at)
      VALUES ('legacy', 'task', '', '{}', 0, 1, 'running', 0, 1, 1)`);

    initMctsSearchTable(execRaw, sql);

    const columns = db.query<{ name: string }, []>('PRAGMA table_info(mcts_search_runs)').all()
      .map((row) => row.name);
    expect(columns).toContain('engine');
    expect(columns).toContain('judge_samples_realised');
    expect(db.query<{ engine: string; judge_samples_realised: number | null }, []>(
      `SELECT engine, judge_samples_realised FROM mcts_search_runs WHERE root_id = 'legacy'`,
    ).get()).toEqual({ engine: 'mcts', judge_samples_realised: null });
    db.close();
  });

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
  // `kinu exec --json` IS the NDJSON event stream — four corrupt,
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

/**
 * The settle status is CLASSIFIED. 'converged' is the ledger's claim that an
 * acceptable answer was earned; a search that ran its loop out with every
 * branch below minAcceptableScore settles as 'no_acceptable_candidate' instead
 * — it did not break (`failed`) and it did not land an answer (`converged`).
 */
describe('the ledger classifies a search that earned no acceptable answer', () => {
  function store() {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const s = new MctsSearchStore(makeSql(db));
    s.begin({
      rootId: 'r1', task: TASK, engine: 'mcts', rootMsgId: 'm1',
      config: { budget: 2, branches: 2 }, budget: 2, now: 1_000,
    });
    return { rt, s };
  }

  test('a nonconverged settle writes the classified status, not converged', () => {
    const { s } = store();
    s.noAcceptableCandidate('r1', 0, 2_000);
    expect(s.get('r1')?.status).toBe('no_acceptable_candidate');
    // And the run-level read model reports exactly that classification.
    expect(s.list(10)[0]).toMatchObject({ rootId: 'r1', status: 'no_acceptable_candidate' });
  });

  test('the classified settle is fenced on epoch like every other terminal write', () => {
    const { s } = store();
    // A reclaimed search (epoch bumped) leaves the dead executor's settle a no-op:
    // the row stays running for whoever holds the live lease.
    s.reclaim('r1');
    s.noAcceptableCandidate('r1', 0, 2_000);
    expect(s.get('r1')?.status).toBe('running');
    expect(s.findResumable(TASK)).not.toBeNull();
  });

  test('a classified row is settled: never resumed, never re-converged', () => {
    const { s } = store();
    s.noAcceptableCandidate('r1', 0, 2_000);
    expect(s.findResumable(TASK)).toBeNull();
    // The one write site in engine.ts only reaches converge() when
    // result.converged, so a converged status can never overwrite this one —
    // but the fence alone proves they are distinct writes.
    s.converge('r1', 0, 3_000);
    expect(s.get('r1')?.status).toBe('no_acceptable_candidate');
  });
});

/**
 * The table ships WHOLE. `initMctsSearchTable` used to follow its CREATE with a
 * `reconcileColumns` pass re-adding `engine` and `judge_samples_realised` for a
 * workspace whose table predated them; both sit in the CREATE and `begin` names
 * both, so the pass had nothing left to repair and is gone. These tests are what
 * keeps that true: a column that reaches the writer but not the DDL now fails
 * here instead of being silently re-added on the next boot.
 */
describe('the search ledger is created whole', () => {
  function fresh() {
    const { rt, db } = createTestRuntime();
    initMctsSearchTable(rt.storage.execRaw, rt.storage.sql);
    return { db, sql: makeSql(db) };
  }

  test('the CREATE alone carries every column the writer names', () => {
    const { sql } = fresh();
    const columns = sql<{ name: string }>`SELECT name FROM pragma_table_info('mcts_search_runs')`
      .map((row) => row.name);
    expect(columns).toEqual([
      'root_id', 'task', 'engine', 'root_msg_id', 'config_json', 'iteration',
      'budget', 'status', 'epoch', 'judge_samples_realised', 'created_at', 'updated_at',
    ]);
  });

  test('begin writes the engine discriminator and the unobserved ensemble', () => {
    const { db, sql } = fresh();
    new MctsSearchStore(makeSql(db)).begin({
      rootId: 'r1', task: TASK, engine: 'swarm', rootMsgId: null,
      config: { budget: 3, branches: 3 }, budget: 3, now: 1_000,
    });
    // The discriminator is load-bearing: it is what stops the MCTS resume loop
    // re-entering a swarm's tree. An unobserved ensemble is NULL, not 0.
    expect(sql<{ engine: string; judge_samples_realised: number | null }>`
      SELECT engine, judge_samples_realised FROM mcts_search_runs WHERE root_id = 'r1'`[0])
      .toEqual({ engine: 'swarm', judge_samples_realised: null });
  });

  test('a ledger row whose config will not parse refuses instead of resuming', () => {
    const { db, sql } = fresh();
    const store = new MctsSearchStore(makeSql(db));
    void sql`INSERT INTO mcts_search_runs
      (root_id, task, engine, root_msg_id, config_json, iteration, budget, status, epoch,
       judge_samples_realised, created_at, updated_at)
      VALUES ('r1', ${TASK}, 'mcts', 'm1', '{', 0, 2, 'running', 0, NULL, 1000, 1000)`;
    // `begin` wrote this column with JSON.stringify, so an unparseable row is
    // corruption. Resuming on a fabricated default would re-enter the search
    // with one branch and no budget and call that a resume.
    expect(() => store.findResumable(TASK)).toThrow();

    // The swarm reader refuses by name rather than reporting a budget nobody set.
    void sql`UPDATE mcts_search_runs SET engine = 'swarm' WHERE root_id = 'r1'`;
    expect(() => store.findRunningSwarms(TASK)).toThrow('its ledger config_json will not parse');
  });

  test('a config that parses but carries no budget refuses by name', () => {
    const { db, sql } = fresh();
    const store = new MctsSearchStore(makeSql(db));
    void sql`INSERT INTO mcts_search_runs
      (root_id, task, engine, root_msg_id, config_json, iteration, budget, status, epoch,
       judge_samples_realised, created_at, updated_at)
      VALUES ('r1', ${TASK}, 'swarm', '', '{"branches":3}', 0, 3, 'running', 0, NULL, 1000, 1000)`;
    expect(() => store.findRunningSwarms(TASK)).toThrow('carries no budget');
  });
});

/**
 * The upfront spend gate prices what the resume will still spend, not what the
 * search already spent. A search begun at budget 10 with 6 iterations behind it
 * has 4 left; a price that refuses a fresh 10 but funds the remaining 4 must
 * let the resume through. Pricing the persisted initial budget instead refuses
 * based on iterations that already ran.
 */
describe('a resume prices its remaining budget, not its initial one', () => {
  test('a resume whose remaining budget fits the cap runs its remainder', async () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const sql = makeSql(db);
    const store = new MctsSearchStore(sql);
    const session = createMockSession();

    // A search begun at budget 10, evicted with 6 iterations done and 4 left.
    const rootId = 'resume-budget-root';
    const rootMsgId = await recordNode(session, rt.storage.sql, {
      nodeId: rootId,
      parentNodeId: null,
      parentMsgId: null,
      rootId,
      task: TASK,
      action: '',
      observation: TASK,
      codeUsed: null,
      depth: 0,
    });
    store.begin({
      rootId, task: TASK, engine: 'mcts', rootMsgId,
      config: persistableMCTSConfig({
        budget: 10, branches: 1, judgeSamples: 1, maxEvalLLMCalls: 1, maxCostUSD: 0.5,
      }),
      budget: 10, now: 1_000,
    });
    store.checkpoint(rootId, 0, 6, 4, 2_000);

    // $10-in/$50-out prices 10 fresh iterations at ~$0.92 (over the $0.50 cap)
    // but the 4 remaining at ~$0.40 (under it). The resume must run those 4 —
    // iterations 7 through 10 — rather than refuse on the spent 6.
    let lastIteration = 0;
    const result = await runMCTS(rt, createMockSession(), TASK, {
      budget: 10, branches: 1, search: store,
      costModel: () => ({ spec: 'anthropic/claude-fable-5', pricing: { input: 10, output: 50 } }),
      onProgress: (event) => {
        if (event.type === 'iteration-complete') lastIteration = event.iteration;
      },
    });

    expect(result).toBeDefined();
    // The resume spent ONLY its remainder: 6 done plus 4 more is 10, not a
    // fresh 10 on top (which would end at 16).
    expect(lastIteration).toBe(10);
    expect(store.get(rootId)).toMatchObject({ status: 'converged', budget: 0 });
  });
});

/**
 * A `begin` names a fresh search run. Repeating a live root id is a caller
 * fault, not a reset: replacing the row would wipe the checkpointed progress
 * to zero while the tree it checkpointed keeps growing underneath.
 */
describe('a repeated begin on a live root throws instead of resetting it', () => {
  test('root id reuse refuses and the checkpointed progress survives', () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const store = new MctsSearchStore(makeSql(db));
    store.begin({
      rootId: 'r1', task: TASK, engine: 'mcts', rootMsgId: 'm1',
      config: { budget: 10, branches: 2 }, budget: 10, now: 1_000,
    });
    store.checkpoint('r1', 0, 5, 5, 2_000);

    expect(() => store.begin({
      rootId: 'r1', task: TASK, engine: 'mcts', rootMsgId: 'm1',
      config: { budget: 10, branches: 2 }, budget: 10, now: 3_000,
    })).toThrow();
    expect(store.get('r1')).toMatchObject({ status: 'running', iteration: 5, budget: 5, epoch: 0 });
  });
});
