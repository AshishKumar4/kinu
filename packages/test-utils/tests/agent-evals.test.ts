/**
 * The scorers' own tests — the half that makes a green live assertion mean
 * anything.
 *
 * Each scorer gets three cases: a populated store where it reports a non-zero
 * denominator and a pass, a populated store where the specific defect it exists
 * for is present and it reports a FAIL, and an empty store where it reports a
 * ZERO denominator rather than a pass. The third is the important one: this
 * repo's signature defect is a check that reports clean over nothing, and a
 * scorer is only trustworthy if "I looked at nothing" is distinguishable from
 * "I looked and it was fine".
 */
import { describe, test, expect } from 'bun:test';
import {
  initAlternateTakesTable, initHeadsTables, initMctsSearchTable, initRunEventTables,
  initSearchTables, listForkRuns, type JsonObject, type SqlExecutor,
} from '@proteus/core';
import { createTestSql, type TestSql } from '../src/sql.js';
import { scoreDelegation, scoreExploration, scoreSettleVisibility } from '../src/agent-evals.js';

/**
 * Every table the Exploration reader touches. Note that `initSearchTables`
 * alone is not enough: `queryCompetedRuns` LEFT JOINs `mcts_search_runs`, which
 * a different initialiser owns, so a fixture that seeds only `search_nodes`
 * makes the reader throw rather than return an empty list.
 */
function forkStore(): TestSql {
  const store = createTestSql();
  initSearchTables(store.execRaw, store.sql);
  initMctsSearchTable(store.execRaw);
  initAlternateTakesTable(store.execRaw, store.sql);
  initHeadsTables(store.execRaw, store.sql);
  return store;
}

/** A search the way runMCTS writes one: a root, `branches` children, and — when
 *  `winner` is given — that child marked terminal with the rest pruned, plus
 *  the durable take row convergence writes beside it. */
function seedSearch(sql: SqlExecutor, opts: {
  root: string; branches: number; winner: number | null; value?: number;
}): void {
  const { root, branches, winner } = opts;
  void sql`INSERT INTO search_nodes (id, parent_id, root_id, task, depth, status, created_at)
    VALUES (${root}, ${null}, ${root}, ${'task ' + root}, ${0}, ${'open'}, ${1_000})`;
  for (let i = 0; i < branches; i++) {
    const id = `${root}-n${String(i)}`;
    const terminal = winner === i;
    void sql`INSERT INTO search_nodes
      (id, parent_id, root_id, task, depth, status, value, visits, created_at)
      VALUES (${id}, ${root}, ${root}, ${'task ' + root}, ${1},
              ${terminal ? 'terminal' : winner === null ? 'open' : 'pruned'},
              ${terminal ? (opts.value ?? 0.8) : 0.2}, ${1}, ${1_001 + i})`;
  }
  if (winner !== null) {
    const winnerNode = `${root}-n${String(winner)}`;
    void sql`INSERT INTO alternate_takes
      (id, task, source, winner_node_id, chosen_node_id, candidates, created_at)
      VALUES (${root + '-take'}, ${'task ' + root}, ${'mcts'}, ${winnerNode},
              ${null}, ${JSON.stringify([{ nodeId: winnerNode }])}, ${1_010})`;
  }
}

/** A merged fork the way HeadController writes one: a run label plus one
 *  head_journal row per head. */
function seedHeads(sql: SqlExecutor, opts: { root: string; heads: number }): void {
  void sql`INSERT INTO head_runs (root_id, rationale, spawned_at)
    VALUES (${opts.root}, ${'why ' + opts.root}, ${2_000})`;
  for (let i = 0; i < opts.heads; i++) {
    void sql`INSERT INTO head_journal
      (id, parent_id, root_id, depth, task, status, spawned_at, completed_at)
      VALUES (${`${opts.root}-h${String(i)}`}, ${null}, ${opts.root}, ${1},
              ${'head task'}, ${'completed'}, ${2_001 + i}, ${2_100})`;
  }
}

describe('scoreExploration — MCTS reached, branched and ranked', () => {
  test('a converged multi-branch search scores a non-zero denominator and passes', () => {
    const store = forkStore();
    seedSearch(store.sql, { root: 'search-a', branches: 3, winner: 1, value: 0.91 });

    const score = scoreExploration(store.sql);

    expect(score.competedRuns).toBe(1);
    expect(score.branchedRuns).toBe(1);
    expect(score.rankedRuns).toBe(1);
    expect(score.durablyRankedRuns).toBe(1);
    expect(score.runs[0]?.branches).toBe(3);
    expect(score.runs[0]?.winnerScore).toBeCloseTo(0.91);
    expect(score.runs[0]?.terminalNodes).toBe(1);
    expect(score.runs[0]?.takeWinnerId).toBe('search-a-n1');
    store.close();
  });

  test('a search that never converged is counted but reports no ranked winner', () => {
    // The shipped defect: nodes exist, the run is visible, and nothing ranked.
    const store = forkStore();
    seedSearch(store.sql, { root: 'search-b', branches: 3, winner: null });

    const score = scoreExploration(store.sql);

    expect(score.competedRuns).toBe(1);
    expect(score.branchedRuns).toBe(1);
    expect(score.rankedRuns).toBe(0);
    expect(score.durablyRankedRuns).toBe(0);
    store.close();
  });

  test('a single-branch search ranked nothing — there was no competition to win', () => {
    const store = forkStore();
    seedSearch(store.sql, { root: 'search-c', branches: 1, winner: 0 });

    const score = scoreExploration(store.sql);

    expect(score.competedRuns).toBe(1);
    expect(score.branchedRuns).toBe(0);
    store.close();
  });

  test('an empty store reports a ZERO denominator, not a pass', () => {
    const store = forkStore();
    const score = scoreExploration(store.sql);
    expect(score.competedRuns).toBe(0);
    expect(score.branchedRuns).toBe(0);
    expect(score.runs).toEqual([]);
    store.close();
  });

  test('a merged fork is not counted as a competed run', () => {
    const store = forkStore();
    seedHeads(store.sql, { root: 'merge-a', heads: 2 });
    expect(scoreExploration(store.sql).competedRuns).toBe(0);
    store.close();
  });
});

describe('scoreSettleVisibility — every settle mode writes where the reader reads', () => {
  test('both stores populated: every written root is visible', () => {
    const store = forkStore();
    seedSearch(store.sql, { root: 'search-a', branches: 2, winner: 0 });
    seedHeads(store.sql, { root: 'merge-a', heads: 2 });

    const score = scoreSettleVisibility(store.sql);

    expect(score.rootsWritten).toBe(2);
    expect(score.invisibleRoots).toEqual([]);
    for (const half of score.stores) {
      expect(half.rootsWritten).toBe(1);
      expect(half.rootsVisible).toBe(1);
    }
    store.close();
  });

  test('the reader is asked for more rows than were written, so its window is never the failure', () => {
    // `listForkRuns` slices AFTER merging its two halves. With a default window
    // of 20 and 25 merged runs, a real search would read as invisible — the
    // scorer must not be able to blame the reader's limit.
    const store = forkStore();
    for (let i = 0; i < 25; i++) seedHeads(store.sql, { root: `merge-${String(i)}`, heads: 1 });
    seedSearch(store.sql, { root: 'search-late', branches: 2, winner: 0 });

    const score = scoreSettleVisibility(store.sql);

    expect(score.rootsWritten).toBe(26);
    expect(score.invisibleRoots).toEqual([]);
    store.close();
  });

  test('NEGATIVE CONTROL: a reader that reads only head_journal loses every search', () => {
    // The Exploration pane as it shipped the first time. `settle=mcts` wrote
    // search_nodes, the reader read head_journal, and the pane was empty for a
    // fork that had really run. The scorer must call that a failure and say
    // which store it happened in.
    const store = forkStore();
    seedSearch(store.sql, { root: 'search-a', branches: 2, winner: 0 });
    seedHeads(store.sql, { root: 'merge-a', heads: 2 });

    const mergedOnly = (sql: SqlExecutor, limit: number) =>
      listForkRuns(sql, limit).filter((run) => run.settle === 'merged');
    const score = scoreSettleVisibility(store.sql, mergedOnly);

    expect(score.rootsWritten).toBe(2);
    expect(score.invisibleRoots).toEqual(['search-a']);
    const competed = score.stores.find((half) => half.store === 'search_nodes');
    expect(competed).toEqual({
      settle: 'competed', store: 'search_nodes',
      rootsWritten: 1, rootsVisible: 0, invisibleRoots: ['search-a'],
    });
    store.close();
  });

  test('NEGATIVE CONTROL: a reader that reads only search_nodes loses every merge', () => {
    // The same bug the other way round, which is how it shipped the second
    // time. Both directions must fail, or the scorer only guards one of them.
    const store = forkStore();
    seedSearch(store.sql, { root: 'search-a', branches: 2, winner: 0 });
    seedHeads(store.sql, { root: 'merge-a', heads: 2 });

    const competedOnly = (sql: SqlExecutor, limit: number) =>
      listForkRuns(sql, limit).filter((run) => run.settle === 'competed');
    const score = scoreSettleVisibility(store.sql, competedOnly);

    expect(score.invisibleRoots).toEqual(['merge-a']);
    store.close();
  });

  test('NEGATIVE CONTROL: a settle mode writing a store no reader reads is invisible', () => {
    // `single-shot` is registered and dispatchable and writes NEITHER store, so
    // a fork settled that way leaves no trace at all. Modelled here as a root
    // present in a write store that the reader has no query for: the shape any
    // future third store would take.
    const store = forkStore();
    seedHeads(store.sql, { root: 'merge-a', heads: 1 });
    const noReader = () => [];
    const score = scoreSettleVisibility(store.sql, noReader);

    expect(score.rootsWritten).toBe(1);
    expect(score.invisibleRoots).toEqual(['merge-a']);
    store.close();
  });

  test('steer-branch roots are excluded, so a correct reader does not look broken', () => {
    const store = forkStore();
    void store.sql`INSERT INTO head_journal
      (id, parent_id, root_id, depth, task, status, spawned_at)
      VALUES (${'branch-abc-h0'}, ${null}, ${'branch-abc'}, ${0}, ${'steer'}, ${'completed'}, ${5_000})`;

    const score = scoreSettleVisibility(store.sql);

    expect(score.rootsWritten).toBe(0);
    expect(score.invisibleRoots).toEqual([]);
    store.close();
  });

  test('an empty store reports a ZERO denominator, not a pass', () => {
    const store = forkStore();
    const score = scoreSettleVisibility(store.sql);
    expect(score.rootsWritten).toBe(0);
    expect(score.invisibleRoots).toEqual([]);
    store.close();
  });
});

function eventStore(): TestSql {
  const store = createTestSql();
  initRunEventTables(store.execRaw);
  return store;
}

let eventIndex = 0;

/** Write one `run_events` row the way `RunEventRecorder` does: the whole event
 *  body as JSON in `payload`, which is what the scorer's `json_extract` reads. */
function emit(sql: SqlExecutor, runId: string, type: string, payload: JsonObject): void {
  eventIndex += 1;
  void sql`INSERT INTO run_events (run_id, event_index, type, payload, ts)
    VALUES (${runId}, ${eventIndex}, ${type}, ${JSON.stringify(payload)}, ${new Date().toISOString()})`;
}

describe('scoreDelegation — conversion over eligible turns', () => {
  test('each arm reports its own denominator and rate, never pooled', () => {
    const store = eventStore();
    // Turn-start arm: 4 eligible, 1 converted.
    for (let i = 0; i < 4; i++) {
      emit(store.sql, `run-${String(i)}`, 'turn_steering', {
        trigger: 'turn_start_no_delegation', step: 0, converted: i === 0,
      });
      emit(store.sql, `run-${String(i)}`, 'turn_end', {});
    }
    // Step-25 arm: 2 eligible, 2 converted. Only reachable on turns the first
    // arm did not convert, which is why these are reported separately.
    for (let i = 1; i < 3; i++) {
      emit(store.sql, `run-${String(i)}`, 'turn_steering', {
        trigger: 'long_turn_no_delegation', step: 25, converted: true,
      });
    }

    const score = scoreDelegation(store.sql);

    const start = score.arms.find((a) => a.trigger === 'turn_start_no_delegation');
    const long = score.arms.find((a) => a.trigger === 'long_turn_no_delegation');
    expect(start).toEqual({ trigger: 'turn_start_no_delegation', eligible: 4, converted: 1, rate: 0.25 });
    expect(long).toEqual({ trigger: 'long_turn_no_delegation', eligible: 2, converted: 2, rate: 1 });
    expect(score.eligible).toBe(6);
    expect(score.converted).toBe(3);
    expect(score.completedTurns).toBe(4);
    store.close();
  });

  test('a non-delegation steer is not counted as an eligible delegation turn', () => {
    const store = eventStore();
    emit(store.sql, 'run-a', 'turn_steering', {
      trigger: 'repeated_call', step: 3, tool: 'run', converted: false,
    });
    const score = scoreDelegation(store.sql);
    expect(score.eligible).toBe(0);
    for (const arm of score.arms) expect(arm.rate).toBeNull();
    store.close();
  });

  test('`converted` counts any agents call; `forkedRuns` counts only turns that opened heads', () => {
    // The steer's own conversion test accepts the whole `agents` tool, so a turn
    // that merely listed the roster converts it without delegating anything.
    // `head_split` is what an actual fork writes, so that is the strict signal.
    const store = eventStore();
    emit(store.sql, 'run-listed', 'turn_steering', {
      trigger: 'turn_start_no_delegation', step: 0, converted: true,
    });
    emit(store.sql, 'run-forked', 'turn_steering', {
      trigger: 'turn_start_no_delegation', step: 0, converted: true,
    });
    emit(store.sql, 'run-forked', 'head_split', {
      rootId: 'root-1', headIds: ['h0', 'h1', 'h2'], rationale: 'compare designs',
    });

    const score = scoreDelegation(store.sql);

    expect(score.eligible).toBe(2);
    expect(score.converted).toBe(2);
    expect(score.forkedRuns).toBe(1);
    expect(score.headsOpened).toBe(3);
    store.close();
  });

  test('REGRESSION: the delegation signal is not `tool_call_start`, which nothing emits', () => {
    // This scorer was first written against `tool_call_start` rows naming the
    // `agents` tool. No production code emits that type on either backend — the
    // sinks emit `tool_call_end` and `step_finish` — so it would have reported
    // "never delegated" forever, on every run, and been believed. A store
    // holding ONLY the row shape production writes must still score non-zero.
    const store = eventStore();
    emit(store.sql, 'run-a', 'tool_call_end', {
      name: 'agents', toolCallId: 't1', durationMs: 5,
    });
    emit(store.sql, 'run-a', 'head_split', {
      rootId: 'root-1', headIds: ['h0', 'h1'], rationale: 'why',
    });

    const score = scoreDelegation(store.sql);

    expect(score.forkedRuns).toBe(1);
    expect(score.headsOpened).toBe(2);
    store.close();
  });

  test('a run that forked with no steer still counts as a forked run', () => {
    const store = eventStore();
    emit(store.sql, 'run-unprompted', 'head_split', {
      rootId: 'root-2', headIds: ['h0', 'h1'], rationale: 'unprompted',
    });
    const score = scoreDelegation(store.sql);
    expect(score.forkedRuns).toBe(1);
    expect(score.eligible).toBe(0);
    store.close();
  });

  test('an empty store reports a ZERO denominator and null rates, not a pass', () => {
    const store = eventStore();
    const score = scoreDelegation(store.sql);
    expect(score.eligible).toBe(0);
    expect(score.forkedRuns).toBe(0);
    expect(score.headsOpened).toBe(0);
    expect(score.completedTurns).toBe(0);
    expect(score.arms.map((a) => a.rate)).toEqual([null, null]);
    store.close();
  });
});
