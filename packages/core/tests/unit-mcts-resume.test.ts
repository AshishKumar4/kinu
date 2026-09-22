/**
 * MCTS evict-resume (B6): an interrupted search continues its remaining budget from the durable checkpoint;
 * the lease epoch fences a stale executor. "Eviction" is an AbortSignal that leaves a `running` checkpoint.
 */

import { describe, test, expect } from 'bun:test';
import { present } from '@kinu.run/test-utils';
import { createTestRuntime, createMockSession, makeSql, captureConsole } from './helpers';
import { runMCTS } from '../src/mcts/engine';
import { initSearchTables } from '../src/mcts/schemas';
import { initScaffoldTables } from '../src/scaffold/schemas';
import { MctsSearchStore, initMctsSearchTable, persistableMCTSConfig } from '../src/mcts/search-store';
import { recordNode } from '../src/mcts/record-node';
import type { AgentRuntime } from '../src/types/agent-runtime';

function initTables(rt: AgentRuntime): void {
  initSearchTables(rt.storage.execRaw);
  initScaffoldTables(rt.storage.execRaw);
  initMctsSearchTable(rt.storage.execRaw);
}

const TASK = 'pick the best database architecture';

describe('MCTS evict-resume (B6)', () => {

  test('an interrupted search resumes from checkpoint, continues remaining budget, converges', async () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const store = new MctsSearchStore(makeSql(db), rt.actor);

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
    const mid = present(store.findResumable(TASK), 'the interrupted checkpoint');

    expect(mid.iteration).toBe(2);
    expect(mid.budget).toBe(2);          // 2 of 4 consumed, 2 remaining
    expect(mid.epoch).toBe(0);
    const rootId = mid.rootId;

    let run2Iters = 0;

    const result = await runMCTS(rt, createMockSession(), TASK, {
      budget: 4, branches: 1, search: store,
      onProgress: (event) => {
        if (event.type === 'iteration-complete') run2Iters = event.iteration;
      },
    });

    expect(result).toBeDefined();
    // Only the 2 remaining iterations, not a fresh 4.
    expect(run2Iters).toBe(4);

    const after = store.get(rootId);
    expect(after?.status).toBe('converged');
    expect(after?.budget).toBe(0);
    expect(after?.epoch).toBe(1);         // reclaim bumped the lease on resume (fence)

    expect(store.findResumable(TASK)).toBeNull(); // the only row is now converged
  });

  test('a completed search is not re-resumed; a new run of the same task starts fresh', async () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const store = new MctsSearchStore(makeSql(db), rt.actor);

    await runMCTS(rt, createMockSession(), TASK, { budget: 2, branches: 1, search: store });
    expect(store.findResumable(TASK)).toBeNull();   // converged → not resumable

    const before = store.findResumable(TASK);
    await runMCTS(rt, createMockSession(), TASK, { budget: 2, branches: 1, search: store });
    expect(before).toBeNull();
  });
});

// The checkpoint heartbeat is logged per iteration, gated on `search` like the checkpoint call.

/** Keyed on the stable dotted event name, as a log query would be. */
const isCheckpointLine = (line: string): boolean => line.includes('"event":"mcts.checkpoint_reached"');

/** The only configuration that heartbeats at all. */
function checkpointedRuntime() {
  const { rt, db } = createTestRuntime();
  initTables(rt);

  return { rt, store: new MctsSearchStore(makeSql(db), rt.actor) };
}

describe('MCTS per-iteration checkpoint logging', () => {
  test('a durably-checkpointed search logs iteration/total/remaining every iteration', async () => {
    const { rt, store } = checkpointedRuntime();

    const { stderr } = await captureConsole(() =>
      runMCTS(rt, createMockSession(), TASK, { budget: 3, branches: 1, search: store }),
    );

    const checkpointLines = stderr.filter(isCheckpointLine);
    expect(checkpointLines).toHaveLength(3);
    // Scalar fields a query can filter on, not an interpolated string.
    expect(JSON.parse(checkpointLines[0]).fields).toMatchObject({ iteration: 1, total: 3, remaining: 2 });
    expect(JSON.parse(checkpointLines[2]).fields).toMatchObject({ iteration: 3, total: 3, remaining: 0 });
  });

  // On stderr: stdout is the `kinu exec --json` NDJSON event stream.
  test('the heartbeat never touches stdout, which is the CLI machine channel', async () => {
    const { rt, store } = checkpointedRuntime();

    const { stdout } = await captureConsole(() =>
      runMCTS(rt, createMockSession(), TASK, { budget: 3, branches: 1, search: store }),
    );

    expect(stdout.filter(isCheckpointLine)).toHaveLength(0);
  });

  test('the fiber-snapshot-only path (no search store) stays silent', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    initScaffoldTables(rt.storage.execRaw);

    const { stdout, stderr } = await captureConsole(() =>
      runMCTS(rt, createMockSession(), TASK, { budget: 2, branches: 1 }),
    );

    expect([...stdout, ...stderr].filter(isCheckpointLine)).toHaveLength(0);
  });
});

/**
 * The judge ensemble a run was observed to sample, folded onto its ledger row: the shared call pool
 * can realise a request lower than the knobs' ceiling.
 */
describe('the ledger records the ensemble a run was observed to sample', () => {
  function ledger() {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const store = new MctsSearchStore(makeSql(db), rt.actor);
    store.begin({
      rootId: 'r1', task: TASK, engine: 'mcts', rootMsgId: 'm1',
      config: { budget: 2, branches: 2, judgeSamples: 20 }, budget: 2, now: 1_000,
    });

    const realised = () => makeSql(db)<{ judge_samples_realised: number | null }>`
      SELECT judge_samples_realised FROM mcts_search_runs
      WHERE actor_id = ${rt.actor.actorId} AND root_id = 'r1'`[0]
      ?.judge_samples_realised ?? null;

    return { store, realised };
  }

  test('a fresh row claims nothing until an ensemble is actually observed', () => {
    expect(ledger().realised()).toBeNull();
  });

  test('the SMALLEST observation wins, whichever order the observations arrive in', () => {
    // Both orders, because a last-write-wins fold passes one and fails the other.
    const ascending = ledger();

    for (const seen of [2, 5, 9]) ascending.store.observeJudgeEnsemble('r1', seen);
    expect(ascending.realised()).toBe(2);

    const descending = ledger();

    for (const seen of [9, 5, 2]) descending.store.observeJudgeEnsemble('r1', seen);
    expect(descending.realised()).toBe(2);
  });

  test('an observation for a root with no ledger row changes nothing', () => {
    // The fold is an UPDATE, never an upsert: a pruned row is not resurrected.
    const { store, realised } = ledger();
    store.observeJudgeEnsemble('some-other-root', 3);
    expect(realised()).toBeNull();
  });
});

/**
 * `findResumable` must filter on engine, or a dead swarm would be resumed by the MCTS loop
 * (a swarm's config parses as a persisted MCTS config).
 */
describe('the resume loop reclaims its own engine only', () => {
  test('a still-running swarm row is never handed to the resume loop', () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const store = new MctsSearchStore(makeSql(db), rt.actor);
    store.begin({
      rootId: 'swarm-root', task: TASK, engine: 'swarm', rootMsgId: null,
      config: { budget: 6, branches: 3, mode: 'build', maxDepth: 2 }, budget: 6, now: 1_000,
    });

    // Matches every `findResumable` condition except the engine.
    expect(store.get('swarm-root')).toMatchObject({ status: 'running' });
    expect(store.findResumable(TASK, 'build')).toBeNull();

    store.begin({
      rootId: 'mcts-root', task: TASK, engine: 'mcts', rootMsgId: 'm1',
      config: { budget: 4, branches: 2, mode: 'build' }, budget: 4, now: 2_000,
    });
    expect(store.findResumable(TASK, 'build')?.rootId).toBe('mcts-root');
  });

  test('the ledger lists both engines and says which each row is', () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const store = new MctsSearchStore(makeSql(db), rt.actor);
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

/** A search whose every branch is below minAcceptableScore settles 'no_acceptable_candidate', not 'converged' or 'failed'. */
describe('the ledger classifies a search that earned no acceptable answer', () => {
  function store() {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const s = new MctsSearchStore(makeSql(db), rt.actor);
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
    expect(s.list(10)[0]).toMatchObject({ rootId: 'r1', status: 'no_acceptable_candidate' });
  });

  test('the classified settle is fenced on epoch like every other terminal write', () => {
    const { s } = store();
    // A reclaimed search (epoch bumped) makes the dead executor's settle a no-op.
    s.reclaim('r1');
    s.noAcceptableCandidate('r1', 0, 2_000);
    expect(s.get('r1')?.status).toBe('running');
    expect(s.findResumable(TASK)).not.toBeNull();
  });

  test('a classified row is settled: never resumed, never re-converged', () => {
    const { s } = store();
    s.noAcceptableCandidate('r1', 0, 2_000);
    expect(s.findResumable(TASK)).toBeNull();
    s.converge('r1', 0, 3_000);
    expect(s.get('r1')?.status).toBe('no_acceptable_candidate');
  });
});

/** The table ships whole: a column the writer names but the DDL lacks fails here rather than being re-added at boot. */
describe('the search ledger is created whole', () => {
  function fresh() {
    const { rt, db } = createTestRuntime();
    initMctsSearchTable(rt.storage.execRaw);

    return { db, sql: makeSql(db), actor: rt.actor };
  }

  test('the CREATE alone carries every column the writer names', () => {
    const { sql } = fresh();

    const columns = sql<{ name: string }>`SELECT name FROM pragma_table_info('mcts_search_runs')`
      .map((row) => row.name);

    expect(columns).toEqual([
      'actor_id', 'root_id', 'task', 'engine', 'root_msg_id', 'config_json', 'iteration',
      'budget', 'status', 'epoch', 'judge_samples_realised', 'created_at', 'updated_at',
    ]);
  });

  test('begin writes the engine discriminator and the unobserved ensemble', () => {
    const { db, sql, actor } = fresh();
    new MctsSearchStore(makeSql(db), actor).begin({
      rootId: 'r1', task: TASK, engine: 'swarm', rootMsgId: null,
      config: { budget: 3, branches: 3 }, budget: 3, now: 1_000,
    });
    // The discriminator stops the MCTS resume loop re-entering a swarm's tree. An unobserved ensemble is NULL, not 0.
    expect(sql<{ engine: string; judge_samples_realised: number | null }>`
      SELECT engine, judge_samples_realised FROM mcts_search_runs
      WHERE actor_id = ${actor.actorId} AND root_id = 'r1'`[0])
      .toEqual({ engine: 'swarm', judge_samples_realised: null });
  });

  test('a ledger row whose config will not parse refuses instead of resuming', () => {
    const { db, sql, actor } = fresh();
    const store = new MctsSearchStore(makeSql(db), actor);
    void sql`INSERT INTO mcts_search_runs
      (actor_id, root_id, task, engine, root_msg_id, config_json, iteration, budget, status, epoch,
       judge_samples_realised, created_at, updated_at)
      VALUES (${actor.actorId}, 'r1', ${TASK}, 'mcts', 'm1', '{', 0, 2, 'running', 0, NULL, 1000, 1000)`;
    // An unparseable config is corruption; resuming on a default would fabricate a search.
    expect(() => store.findResumable(TASK)).toThrow();

    void sql`UPDATE mcts_search_runs SET engine = 'swarm'
      WHERE actor_id = ${actor.actorId} AND root_id = 'r1'`;
    expect(() => store.findRunningSwarms(TASK)).toThrow('its ledger config_json will not parse');
  });

  test('a config that parses but carries no budget refuses by name', () => {
    const { db, sql, actor } = fresh();
    const store = new MctsSearchStore(makeSql(db), actor);
    void sql`INSERT INTO mcts_search_runs
      (actor_id, root_id, task, engine, root_msg_id, config_json, iteration, budget, status, epoch,
       judge_samples_realised, created_at, updated_at)
      VALUES (${actor.actorId}, 'r1', ${TASK}, 'swarm', '', '{"branches":3}', 0, 3, 'running', 0, NULL, 1000, 1000)`;
    expect(() => store.findRunningSwarms(TASK)).toThrow('carries no budget');
  });
});

/** The upfront spend gate prices the remaining iterations, not the persisted initial budget. */
describe('a resume prices its remaining budget, not its initial one', () => {
  test('a resume whose remaining budget fits the cap runs its remainder', async () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const sql = makeSql(db);
    const store = new MctsSearchStore(sql, rt.actor);
    const session = createMockSession();

    const rootId = 'resume-budget-root';

    const rootMsgId = await recordNode(session, rt.storage.sql, rt.actor, {
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
    store.checkpoint(rootId, 0, { iteration: 6, budget: 4, now: 2_000 });

    // These prices refuse 10 fresh iterations but fund the remaining 4.
    let lastIteration = 0;

    const result = await runMCTS(rt, createMockSession(), TASK, {
      budget: 10, branches: 1, search: store,
      costModel: () => ({ spec: 'anthropic/claude-fable-5', pricing: { input: 10, output: 50 } }),
      onProgress: (event) => {
        if (event.type === 'iteration-complete') lastIteration = event.iteration;
      },
    });

    expect(result).toBeDefined();
    // 6 done plus 4 is 10, not 16.
    expect(lastIteration).toBe(10);
    expect(store.get(rootId)).toMatchObject({ status: 'converged', budget: 0 });
  });
});

/** Repeating a live root id in `begin` is a caller fault: replacing the row would zero checkpointed progress. */
describe('a repeated begin on a live root throws instead of resetting it', () => {
  test('root id reuse refuses and the checkpointed progress survives', () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const store = new MctsSearchStore(makeSql(db), rt.actor);
    store.begin({
      rootId: 'r1', task: TASK, engine: 'mcts', rootMsgId: 'm1',
      config: { budget: 10, branches: 2 }, budget: 10, now: 1_000,
    });
    store.checkpoint('r1', 0, { iteration: 5, budget: 5, now: 2_000 });

    expect(() => store.begin({
      rootId: 'r1', task: TASK, engine: 'mcts', rootMsgId: 'm1',
      config: { budget: 10, branches: 2 }, budget: 10, now: 3_000,
    })).toThrow();
    expect(store.get('r1')).toMatchObject({ status: 'running', iteration: 5, budget: 5, epoch: 0 });
  });
});
