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
} from '@kinu.run/core';
import { createTestSql, type TestSql } from '../src/sql';
import {
  BEHAVIOUR_SCORERS, completionHonesty, craftReuse, delegationConversion, editLanding,
  recoveryDurability, scoreDelegation, scoreExploration, scoreSettleVisibility,
  spillRetrieval, steeringConversion, toolOutcomes,
} from '../src/agent-evals';

/**
 * Every table the Exploration reader touches. Note that `initSearchTables`
 * alone is not enough: `queryCompetedRuns` LEFT JOINs `mcts_search_runs`, which
 * a different initialiser owns, so a fixture that seeds only `search_nodes`
 * makes the reader throw rather than return an empty list.
 */
function forkStore(): TestSql {
  const store = createTestSql();
  initSearchTables(store.execRaw, store.sql);
  initMctsSearchTable(store.execRaw, store.sql);
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

describe('scoreExploration — a search tree reached, branched and ranked', () => {
  test('a converged multi-branch search scores a non-zero denominator and passes', () => {
    const store = forkStore();
    seedSearch(store.sql, { root: 'search-a', branches: 3, winner: 1, value: 0.91 });

    const score = scoreExploration(store.sql);

    expect(score.searchRuns).toBe(1);
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

    expect(score.searchRuns).toBe(1);
    expect(score.branchedRuns).toBe(1);
    expect(score.rankedRuns).toBe(0);
    expect(score.durablyRankedRuns).toBe(0);
    store.close();
  });

  test('a single-branch search ranked nothing — there was no competition to win', () => {
    const store = forkStore();
    seedSearch(store.sql, { root: 'search-c', branches: 1, winner: 0 });

    const score = scoreExploration(store.sql);

    expect(score.searchRuns).toBe(1);
    expect(score.branchedRuns).toBe(0);
    store.close();
  });

  test('an empty store reports a ZERO denominator, not a pass', () => {
    const store = forkStore();
    const score = scoreExploration(store.sql);
    expect(score.searchRuns).toBe(0);
    expect(score.branchedRuns).toBe(0);
    expect(score.runs).toEqual([]);
    store.close();
  });

  test('a journal-only run is not counted as a run with a search tree', () => {
    const store = forkStore();
    seedHeads(store.sql, { root: 'merge-a', heads: 2 });
    expect(scoreExploration(store.sql).searchRuns).toBe(0);
    store.close();
  });
});

describe('scoreSettleVisibility — every half a run writes is where the reader reads', () => {
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
    // The reader pages its merged order. With a default window of 20 and 25
    // journalled runs, a real search would read as invisible — the scorer must not
    // be able to blame the reader's limit.
    const store = forkStore();
    for (let i = 0; i < 25; i++) seedHeads(store.sql, { root: `merge-${String(i)}`, heads: 1 });
    seedSearch(store.sql, { root: 'search-late', branches: 2, winner: 0 });

    const score = scoreSettleVisibility(store.sql);

    expect(score.rootsWritten).toBe(26);
    expect(score.invisibleRoots).toEqual([]);
    store.close();
  });

  test('NEGATIVE CONTROL: a reader that reads only head_journal loses every search', () => {
    // The Exploration pane as it shipped the first time. A tree search wrote
    // search_nodes, the reader read head_journal, and the pane was empty for a run
    // that had really run. The scorer must call that a failure and say which store
    // it happened in.
    const store = forkStore();
    seedSearch(store.sql, { root: 'search-a', branches: 2, winner: 0 });
    seedHeads(store.sql, { root: 'merge-a', heads: 2 });

    const transcriptsOnly = (sql: SqlExecutor, limit: number) =>
      listForkRuns(sql, null, limit).items.filter((run) => !run.hasSearchTree);
    const score = scoreSettleVisibility(store.sql, transcriptsOnly);

    expect(score.rootsWritten).toBe(2);
    expect(score.invisibleRoots).toEqual(['search-a']);
    const tree = score.stores.find((half) => half.store === 'search_nodes');
    expect(tree).toEqual({
      half: 'tree', store: 'search_nodes', present: true,
      rootsWritten: 1, rootsVisible: 0, invisibleRoots: ['search-a'],
    });
    store.close();
  });

  test('NEGATIVE CONTROL: a reader that reads only search_nodes loses every journalled run', () => {
    // The same bug the other way round, which is how it shipped the second
    // time. Both directions must fail, or the scorer only guards one of them.
    const store = forkStore();
    seedSearch(store.sql, { root: 'search-a', branches: 2, winner: 0 });
    seedHeads(store.sql, { root: 'merge-a', heads: 2 });

    const treeOnly = (sql: SqlExecutor, limit: number) =>
      listForkRuns(sql, null, limit).items.filter((run) => run.hasSearchTree);
    const score = scoreSettleVisibility(store.sql, treeOnly);

    expect(score.invisibleRoots).toEqual(['merge-a']);
    store.close();
  });

  test('NEGATIVE CONTROL: a writer filling a store no reader reads is invisible', () => {
    // A run that writes NEITHER store leaves no trace at all. Modelled here as a
    // root present in a write store that the reader has no query for: the shape any
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

/**
 * Write one `run_events` row EXACTLY as `RunEventRecorder` does.
 *
 * The payload column holds the whole stamped event — `{...input, eventIndex,
 * runId, timestamp}` (events/recorder.ts:112-113, 179-182) — not just the
 * type-specific fields. This fixture used to write only the latter, which every
 * `json_extract`-based scorer read happily while the canonical parse rejected
 * it. That is the write-path/read-path disagreement this module's own docstring
 * warns about, reproduced inside its tests: a fixture that agrees with the
 * hand-rolled query and not with the real writer certifies nothing.
 */
function emit(sql: SqlExecutor, runId: string, type: string, payload: JsonObject): void {
  eventIndex += 1;
  const event = {
    ...payload, type, runId, eventIndex, timestamp: new Date().toISOString(),
  };
  void sql`INSERT INTO run_events (run_id, event_index, type, payload, ts)
    VALUES (${runId}, ${eventIndex}, ${type}, ${JSON.stringify(event)}, ${event.timestamp})`;
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
    expect(score.toolCalls).toBe(0);
    expect(score.arms.map((a) => a.rate)).toEqual([null, null]);
    store.close();
  });

  test('PRECONDITION: an inert turn yields rate 0 with ZERO tool calls, so the rate is undecidable', () => {
    // The corpus a real bench run produced: evolution fired 14 times over 14
    // turns and every outcome read "ungraded | 0 tool calls | 1 step". Over
    // turns like these the arithmetic rate is a clean-looking 0%, and it would
    // be read as "the agent chose not to delegate" when nothing happened at
    // all. `toolCalls` is what lets a caller tell those apart, so it must be
    // reported as zero here while `rate` is still numerically 0.
    const store = eventStore();
    for (let i = 0; i < 3; i++) {
      emit(store.sql, `inert-${String(i)}`, 'turn_steering', {
        trigger: 'turn_start_no_delegation', step: 0, converted: false,
      });
      emit(store.sql, `inert-${String(i)}`, 'turn_end', {});
    }

    const score = scoreDelegation(store.sql);

    expect(score.eligible).toBe(3);
    expect(score.completedTurns).toBe(3);
    expect(score.arms.find((a) => a.trigger === 'turn_start_no_delegation')?.rate).toBe(0);
    // The precondition that makes that 0 meaningless.
    expect(score.toolCalls).toBe(0);
    store.close();
  });

  test('a turn that used tools reports a non-zero precondition', () => {
    const store = eventStore();
    emit(store.sql, 'busy', 'turn_steering', {
      trigger: 'turn_start_no_delegation', step: 0, converted: false,
    });
    emit(store.sql, 'busy', 'tool_call_end', { name: 'run', toolCallId: 't1', durationMs: 3 });
    emit(store.sql, 'busy', 'turn_end', {});

    const score = scoreDelegation(store.sql);

    expect(score.eligible).toBe(1);
    expect(score.toolCalls).toBe(1);
    expect(score.forkedRuns).toBe(0);
    store.close();
  });
});

/**
 * The uniform panel's own tests.
 *
 * Same three cases per scorer as above — a pass, the specific defect it exists
 * for going RED, and an empty store reporting a null rate rather than a pass —
 * because a scorer that has never been shown going red is an assertion nobody
 * has any reason to believe.
 */
describe('BEHAVIOUR_SCORERS — the panel contract', () => {
  test('every scorer is uniquely named and reports a null rate over an empty store', () => {
    const store = eventStore();
    const names = BEHAVIOUR_SCORERS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(BEHAVIOUR_SCORERS.length).toBeGreaterThanOrEqual(6);
    for (const scorer of BEHAVIOUR_SCORERS) {
      const score = scorer.score(store.sql);
      expect(score.eligible, `${scorer.name} denominator`).toBe(0);
      expect(score.passed, `${scorer.name} numerator`).toBe(0);
      // The whole point of the panel: absent is not zero.
      expect(score.rate, `${scorer.name} rate`).toBeNull();
      expect(scorer.asserts.length, `${scorer.name} asserts`).toBeGreaterThan(0);
    }
    store.close();
  });

  test('a rate is never reported above 1, so paired statistics stay well-formed', () => {
    const store = eventStore();
    // followUps deliberately exceeds referenced: one spill address cited twice.
    emit(store.sql, 'run-a', 'context_budget', {
      admittedChars: 10, omittedChars: 900, trips: { run: 1 },
      referenced: 1, tightened: 0, followUps: 3,
    });
    const score = spillRetrieval.score(store.sql);
    expect(score.eligible).toBe(1);
    expect(score.rate).toBe(1);
    store.close();
  });
});

describe('steeringConversion — every trigger, not just the delegation pair', () => {
  test('a repeat-breaker steer that converted is counted, which scoreDelegation excludes', () => {
    const store = eventStore();
    emit(store.sql, 'run-a', 'turn_steering', { trigger: 'repeated_call', step: 3, tool: 'run', converted: true });
    emit(store.sql, 'run-a', 'turn_steering', { trigger: 'no_progress', step: 9, converted: true });

    expect(steeringConversion.score(store.sql).rate).toBe(1);
    // The delegation scorer must still see nothing: these are not its arms.
    expect(scoreDelegation(store.sql).eligible).toBe(0);
    store.close();
  });

  test('RED: steers that fired and did not convert score below 1', () => {
    const store = eventStore();
    for (let i = 0; i < 3; i++) {
      emit(store.sql, `run-${String(i)}`, 'turn_steering', {
        trigger: 'repeated_failure', step: 5, tool: 'run', converted: false,
      });
    }
    emit(store.sql, 'run-x', 'turn_steering', { trigger: 'repeated_failure', step: 5, tool: 'run', converted: true });

    const score = steeringConversion.score(store.sql);
    expect(score.eligible).toBe(4);
    expect(score.passed).toBe(1);
    expect(score.rate).toBe(0.25);
    store.close();
  });

  test('a trigger outside the producer picklist THROWS rather than vanishing', () => {
    // A steer nobody scores is a steer nobody can tell is broken. The canonical
    // parse is what prevents that: `trigger` is a picklist, so a trigger added
    // to the producer and not to the schema cannot quietly drop out of this
    // denominator and read as a steer that never fired. Loud beats silent for a
    // signal something is being trained against.
    const store = eventStore();
    emit(store.sql, 'run-a', 'turn_steering', { trigger: 'some_future_trigger', step: 1, converted: false });
    expect(() => steeringConversion.score(store.sql)).toThrow();
    store.close();
  });

  test('a malformed row of an UNRELATED type does not break this scorer', () => {
    // The recorder's own reader parses its whole window before filtering by
    // type, so one bad row throws for every caller. These scorers narrow in SQL
    // first, so a corrupt `step_finish` costs one number and not eight.
    const store = eventStore();
    emit(store.sql, 'run-a', 'turn_steering', { trigger: 'no_progress', step: 2, converted: true });
    void store.sql`INSERT INTO run_events (run_id, event_index, type, payload, ts)
      VALUES (${'run-a'}, ${9_999}, ${'step_finish'}, ${'{"type":"step_finish","nonsense":true}'}, ${'t'})`;

    const score = steeringConversion.score(store.sql);

    expect(score.eligible).toBe(1);
    expect(score.passed).toBe(1);
    // And the panel's other scorers are equally unaffected.
    expect(toolOutcomes.score(store.sql).eligible).toBe(0);
    store.close();
  });
});

describe('craftReuse — the in-episode loop closing', () => {
  test('crafted then reused scores over the tools crafted, not the turns', () => {
    const store = eventStore();
    emit(store.sql, 'run-a', 'craft_cycle', {
      crafted: ['grep_imports', 'count_todos'], invoked: ['grep_imports'],
      reused: ['grep_imports'], returned: 1, raised: 0, dropped: [],
    });
    const score = craftReuse.score(store.sql);
    expect(score.eligible).toBe(2);
    expect(score.passed).toBe(1);
    expect(score.rate).toBe(0.5);
    store.close();
  });

  test('RED: a tool crafted and never reached for again scores zero over a real denominator', () => {
    const store = eventStore();
    emit(store.sql, 'run-a', 'craft_cycle', {
      crafted: ['write_only'], invoked: [], reused: [], returned: 0, raised: 0, dropped: [],
    });
    const score = craftReuse.score(store.sql);
    expect(score.eligible).toBe(1);
    expect(score.passed).toBe(0);
    expect(score.rate).toBe(0);
    store.close();
  });

  test('a turn that only invoked a previously-crafted tool crafts no new denominator', () => {
    const store = eventStore();
    emit(store.sql, 'run-a', 'craft_cycle', {
      crafted: [], invoked: ['from_last_turn'], reused: [], returned: 1, raised: 0, dropped: [],
    });
    const score = craftReuse.score(store.sql);
    expect(score.eligible).toBe(0);
    expect(score.rate).toBeNull();
    expect(score.detail).toContain('1 crafted-tool invocations');
    store.close();
  });
});

describe('editLanding — did the edit actually land', () => {
  test('applied over attempted, with the dominant failure mode named', () => {
    const store = eventStore();
    emit(store.sql, 'run-a', 'file_edit', {
      attempts: 4, applied: 3, failures: { not_found: 1 },
      recoveredPaths: 1, abandonedPaths: 0,
    });
    const score = editLanding.score(store.sql);
    expect(score.eligible).toBe(4);
    expect(score.passed).toBe(3);
    expect(score.detail).toContain('not_found×1');
    store.close();
  });

  test('RED: a turn that attempted edits and landed none scores zero, not null', () => {
    const store = eventStore();
    emit(store.sql, 'run-a', 'file_edit', {
      attempts: 5, applied: 0, failures: { stale: 3, ambiguous: 2 },
      recoveredPaths: 0, abandonedPaths: 2,
    });
    const score = editLanding.score(store.sql);
    expect(score.eligible).toBe(5);
    expect(score.passed).toBe(0);
    expect(score.rate).toBe(0);
    // Ordered by frequency so the reader sees what to fix first.
    expect(score.detail).toContain('stale×3');
    expect(score.detail).toContain('2 paths abandoned');
    store.close();
  });
});

describe('recoveryDurability — the recovery that TOOK', () => {
  test('a finding whose signature never recurs holds', () => {
    const store = eventStore();
    emit(store.sql, 'run-a', 'execution_recovery', {
      recoveries: [{ tool: 'run', failures: 3, failedSignature: 'run:bun test x' }],
    });
    const score = recoveryDurability.score(store.sql);
    expect(score.eligible).toBe(1);
    expect(score.passed).toBe(1);
    expect(score.detail).toContain('3 consecutive failures absorbed');
    store.close();
  });

  test('RED: the same signature failing again in a LATER turn scores the finding red', () => {
    // This is the producer's own named falsifier. Without it this scorer is a
    // tautology: the event only exists when a streak was already broken, so
    // recoveries-over-recoveries is 1.00 on every run forever.
    const store = eventStore();
    emit(store.sql, 'run-a', 'execution_recovery', {
      recoveries: [{ tool: 'run', failures: 2, failedSignature: 'run:pytest -q' }],
    });
    emit(store.sql, 'run-a', 'execution_recovery', {
      recoveries: [{ tool: 'run', failures: 4, failedSignature: 'run:pytest -q' }],
    });
    const score = recoveryDurability.score(store.sql);
    expect(score.eligible).toBe(1);
    expect(score.passed).toBe(0);
    expect(score.rate).toBe(0);
    expect(score.detail).toContain('1 signatures failed again later');
    store.close();
  });

  test('the same signature under a DIFFERENT tool is a different finding', () => {
    const store = eventStore();
    emit(store.sql, 'run-a', 'execution_recovery', {
      recoveries: [
        { tool: 'run', failures: 1, failedSignature: 'same' },
        { tool: 'file', failures: 1, failedSignature: 'same' },
      ],
    });
    const score = recoveryDurability.score(store.sql);
    expect(score.eligible).toBe(2);
    expect(score.passed).toBe(2);
    store.close();
  });
});

describe('completionHonesty — polarity is the reverse of every other scorer', () => {
  test('a gate that found no work left is the PASS', () => {
    const store = eventStore();
    emit(store.sql, 'run-a', 'completion_gate', { converted: false });
    const score = completionHonesty.score(store.sql);
    expect(score.eligible).toBe(1);
    expect(score.passed).toBe(1);
    expect(score.detail).toContain('0 were forced back to work');
    store.close();
  });

  test('RED: converted=true means it claimed done with work left, and must score red', () => {
    // Scoring this the obvious way round — converted as the numerator — would
    // reward a model that habitually declares victory early.
    const store = eventStore();
    emit(store.sql, 'run-a', 'completion_gate', { converted: true });
    emit(store.sql, 'run-b', 'completion_gate', { converted: true });
    emit(store.sql, 'run-c', 'completion_gate', { converted: false });
    const score = completionHonesty.score(store.sql);
    expect(score.eligible).toBe(3);
    expect(score.passed).toBe(1);
    expect(score.rate).toBeCloseTo(1 / 3);
    expect(score.detail).toContain('2 were forced back to work');
    store.close();
  });
});

describe('spillRetrieval — spilled context read back', () => {
  test('a follow-up against a readable spill passes', () => {
    const store = eventStore();
    emit(store.sql, 'run-a', 'context_budget', {
      admittedChars: 1_000, omittedChars: 40_000, trips: { run: 2 },
      referenced: 2, tightened: 1, followUps: 2,
    });
    const score = spillRetrieval.score(store.sql);
    expect(score.eligible).toBe(2);
    expect(score.passed).toBe(2);
    expect(score.detail).toContain('40000 chars withheld');
    store.close();
  });

  test('RED: a readable spill the agent never fetched scores zero', () => {
    const store = eventStore();
    emit(store.sql, 'run-a', 'context_budget', {
      admittedChars: 500, omittedChars: 80_000, trips: { run: 3 },
      referenced: 3, tightened: 0, followUps: 0,
    });
    const score = spillRetrieval.score(store.sql);
    expect(score.eligible).toBe(3);
    expect(score.passed).toBe(0);
    expect(score.rate).toBe(0);
    store.close();
  });

  test('a spill with no resolvable address is excluded, not charged to the agent', () => {
    // There was nothing to read back, so this is the harness failing, not the
    // model. Charging it here would score our own defect against the agent.
    const store = eventStore();
    emit(store.sql, 'run-a', 'context_budget', {
      admittedChars: 0, omittedChars: 9_000, trips: { attachment: 1 },
      referenced: 0, tightened: 0, followUps: 0,
    });
    const score = spillRetrieval.score(store.sql);
    expect(score.eligible).toBe(0);
    expect(score.rate).toBeNull();
    store.close();
  });
});

describe('toolOutcomes — the coarse instrument that always has a denominator', () => {
  test('returning calls pass, and a clean run names NO mix', () => {
    // What this used to assert was `detail` containing `run×1` — a histogram
    // built over ALL rows, so every published mix summed to the denominator and
    // described the run's tool USAGE while sitting beside a failure rate. Run
    // flash-a scored 103/126 and the record could not say which 23 failed. The
    // mix is now over failures, so a clean run has nothing to name.
    const store = eventStore();
    emit(store.sql, 'run-a', 'tool_call_end', { name: 'run', toolCallId: 't1', durationMs: 10 });
    emit(store.sql, 'run-a', 'tool_call_end', { name: 'file', toolCallId: 't2', durationMs: 4 });
    const score = toolOutcomes.score(store.sql);
    expect(score.eligible).toBe(2);
    expect(score.passed).toBe(2);
    expect(score.detail).toBe('2/2 tool calls returned; 0 refused, 0 work failed, 0 runtime absent, 0 broke');
    expect(score.detail).not.toContain('run×1');
    store.close();
  });

  test('the failing mix names the tool, the ACTION and the reason', () => {
    // `file×13` was the best the old record could do, and it is unactionable:
    // read, write and edit are one bucket, and nine distinct refusal reasons are
    // one bucket. The args on the row plus the reason on the result are what make
    // this line a diagnosis instead of a count.
    const store = eventStore();
    emit(store.sql, 'run-a', 'tool_call_end', {
      name: 'file', toolCallId: 't1', args: { action: 'edit', path: 'a.ts' },
      result: { reason: 'not_found', error: 'old_text does not appear in a.ts' },
    });
    emit(store.sql, 'run-a', 'tool_call_end', {
      name: 'file', toolCallId: 't2', args: { action: 'edit', path: 'b.ts' },
      result: JSON.stringify({ reason: 'not_found', error: 'old_text does not appear in b.ts' }),
    });
    emit(store.sql, 'run-a', 'tool_call_end', {
      name: 'run', toolCallId: 't3', args: { command: 'bun test' },
      result: 'Error (exit 1)\n--- stdout ---\n1 fail\n',
    });
    const score = toolOutcomes.score(store.sql);
    expect(score.eligible).toBe(3);
    expect(score.passed).toBe(0);
    // Two refusals the tool was RIGHT to make, one command that ran and found a
    // failing suite, nothing broken. Reported split, because which part a
    // failure sits in is the whole finding.
    expect(score.detail).toBe(
      '0/3 tool calls returned; 2 refused, 1 work failed, 0 runtime absent, 0 broke; '
      + 'failed: file·edit·not_found×2, run·exit_1×1',
    );
    store.close();
  });

  test('RED: a structured error body is a failure, on either backend shape', () => {
    // Measured to score a CLEAN 1/1 before the fix, on both shapes. The cf sink
    // stores a tool's structured output as an object and the CLI sink renders it
    // through JSON.stringify, so the identical payload arrives two ways and a
    // reader that narrows to a string sees a per-backend false zero. The eval
    // harness ran a runtime with no executionRouter, so every `execute_tools`
    // block touching `workspace.*` failed exactly like this and was counted as a
    // pass — an overestimate of tool health, in the flattering direction.
    const store = eventStore();
    emit(store.sql, 'run-a', 'tool_call_end', {
      name: 'execute_tools', toolCallId: 't1',
      result: { error: 'workspace.createTool is not a function' },
    });
    emit(store.sql, 'run-a', 'tool_call_end', {
      name: 'execute_tools', toolCallId: 't2',
      result: JSON.stringify({ error: 'workspace.createTool is not a function' }),
    });
    const score = toolOutcomes.score(store.sql);
    expect(score.eligible).toBe(2);
    expect(score.passed).toBe(0);
    expect(score.detail).toContain('0 refused, 0 work failed, 0 runtime absent, 2 broke');
    expect(score.detail).toContain('execute_tools·returned_error×2');
    store.close();
  });

  test('RED: erroring calls score below 1', () => {
    const store = eventStore();
    emit(store.sql, 'run-a', 'tool_call_end', { name: 'run', toolCallId: 't1', error: 'exit 2' });
    emit(store.sql, 'run-a', 'tool_call_end', { name: 'run', toolCallId: 't2', durationMs: 3 });
    const score = toolOutcomes.score(store.sql);
    expect(score.eligible).toBe(2);
    expect(score.passed).toBe(1);
    expect(score.rate).toBe(0.5);
    store.close();
  });

  test('an empty error string is a success, not a failure', () => {
    const store = eventStore();
    emit(store.sql, 'run-a', 'tool_call_end', { name: 'run', toolCallId: 't1', error: '' });
    expect(toolOutcomes.score(store.sql).passed).toBe(1);
    store.close();
  });

  test('RED: a command that exited non-zero is a FAILURE, not a success', () => {
    // The defect this scorer shipped with. A non-zero exit comes back as an
    // ordinary SUCCESSFUL tool result — no `error` field — whose text begins
    // `Error (exit N)`. Counting only the transport discriminator scored a failed
    // test run as a clean call, which is the inverted-contamination shape: the
    // worst call in the turn contributing the best number. The same confusion
    // graded a command exiting 3 as `accepted` at quality 0.70 in the evolution
    // reward.
    const store = eventStore();
    emit(store.sql, 'run-a', 'tool_call_end', {
      name: 'run', toolCallId: 't1',
      result: 'Error (exit 3)\n(no output)',
    });
    emit(store.sql, 'run-a', 'tool_call_end', {
      name: 'run', toolCallId: 't2', result: 'ok\n',
    });

    const score = toolOutcomes.score(store.sql);

    expect(score.eligible).toBe(2);
    expect(score.passed).toBe(1);
    expect(score.rate).toBe(0.5);
    store.close();
  });

  test('a result merely CONTAINING the failure prefix later is not a failure', () => {
    // The predicate anchors at the start, so a command that succeeded while
    // printing the words "Error (exit 1)" — grepping a log, echoing a fixture —
    // is not miscounted. Otherwise this scorer would punish reading about errors.
    const store = eventStore();
    emit(store.sql, 'run-a', 'tool_call_end', {
      name: 'run', toolCallId: 't1',
      result: 'log line 12: Error (exit 1) was seen\n',
    });
    expect(toolOutcomes.score(store.sql).passed).toBe(1);
    store.close();
  });
});

describe('delegationConversion — the adapter does not drift from scoreDelegation', () => {
  test('the uniform shape reports the same numbers as the function it wraps', () => {
    const store = eventStore();
    for (let i = 0; i < 4; i++) {
      emit(store.sql, `run-${String(i)}`, 'turn_steering', {
        trigger: 'turn_start_no_delegation', step: 0, converted: i < 2,
      });
    }
    emit(store.sql, 'run-0', 'head_split', { rootId: 'r', headIds: ['a', 'b'], rationale: 'why' });

    const rich = scoreDelegation(store.sql);
    const uniform = delegationConversion.score(store.sql);

    expect(uniform.eligible).toBe(rich.eligible);
    expect(uniform.passed).toBe(rich.converted);
    expect(uniform.rate).toBe(0.5);
    expect(uniform.detail).toContain('1 runs opened 2 heads');
    store.close();
  });
});
