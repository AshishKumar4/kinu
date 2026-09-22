/**
 * Each scorer: a pass, its defect going red, and an empty store reporting a zero
 * denominator rather than a pass.
 */
import { describe, test, expect } from 'bun:test';
import {
  initAlternateTakesTable, initHeadsTables, initMctsSearchTable, initRunEventTables,
  initSearchTables, listForkRuns, type ActorHandle, type JsonObject, type SqlExecutor,
} from '@kinu.run/core';
import { createTestSql, testActorHandle, type TestSql } from '../src/sql';
import { createTestActors } from '../src/actors';
import {
  BEHAVIOUR_SCORERS, completionHonesty, craftReuse, editLanding, parseFailureMix,
  recoveryDurability, scoreExploration, scoreSettleVisibility,
  spillRetrieval, steeringConversion, toolOutcomes,
} from '../src/agent-evals';

/**
 * `queryCompetedRuns` LEFT JOINs `mcts_search_runs`, so seeding only `search_nodes` throws.
 * The actor is real: the head journal is actor-private, and scorers read as this handle.
 */
interface ForkStore extends TestSql {
  readonly actor: ActorHandle;
}

function forkStore(): ForkStore {
  const store = createTestSql();
  initSearchTables(store.execRaw);
  initMctsSearchTable(store.execRaw);
  initAlternateTakesTable(store.execRaw);
  initHeadsTables(store.execRaw);

  return { ...store, actor: createTestActors(store.sql, store.execRaw).main };
}

function branchStatus(terminal: boolean, winner: number | null): string {
  if (terminal) return 'terminal';

  return winner === null ? 'open' : 'pruned';
}

/**
 * Takes the store: `search_nodes` and `alternate_takes` are keyed `(actor_id, id)` with a
 * NOT NULL actor, so rows must carry the handle the scorer reads as.
 */
function seedSearch(store: ForkStore, opts: {
  root: string; branches: number; winner: number | null; value?: number;
}): void {
  const { sql } = store;
  const actorId = store.actor.actorId;
  const { root, branches, winner } = opts;
  void sql`INSERT INTO search_nodes
    (actor_id, id, parent_id, root_id, task, depth, status, created_at)
    VALUES (${actorId}, ${root}, ${null}, ${root}, ${'task ' + root}, ${0}, ${'open'}, ${1_000})`;

  for (let i = 0; i < branches; i++) {
    const id = `${root}-n${String(i)}`;
    const terminal = winner === i;
    void sql`INSERT INTO search_nodes
      (actor_id, id, parent_id, root_id, task, depth, status, value, visits, created_at)
      VALUES (${actorId}, ${id}, ${root}, ${root}, ${'task ' + root}, ${1},
              ${branchStatus(terminal, winner)},
              ${terminal ? (opts.value ?? 0.8) : 0.2}, ${1}, ${1_001 + i})`;
  }

  if (winner !== null) {
    const winnerNode = `${root}-n${String(winner)}`;
    void sql`INSERT INTO alternate_takes
      (actor_id, id, task, source, winner_node_id, chosen_node_id, candidates, created_at)
      VALUES (${actorId}, ${root + '-take'}, ${'task ' + root}, ${'mcts'}, ${winnerNode},
              ${null}, ${JSON.stringify([{ nodeId: winnerNode }])}, ${1_010})`;
  }
}

function seedHeads(store: ForkStore, opts: { root: string; heads: number }): void {
  const { sql } = store;
  const actorId = store.actor.actorId;
  void sql`INSERT INTO head_runs (actor_id, root_id, rationale, spawned_at)
    VALUES (${actorId}, ${opts.root}, ${'why ' + opts.root}, ${2_000})`;

  for (let i = 0; i < opts.heads; i++) {
    void sql`INSERT INTO head_journal
      (actor_id, id, parent_id, root_id, depth, task, status, spawned_at, completed_at)
      VALUES (${actorId}, ${`${opts.root}-h${String(i)}`}, ${null}, ${opts.root}, ${1},
              ${'head task'}, ${'completed'}, ${2_001 + i}, ${2_100})`;
  }
}

describe('scoreExploration — a search tree reached, branched and ranked', () => {
  test('a converged multi-branch search scores a non-zero denominator and passes', () => {
    const store = forkStore();
    seedSearch(store, { root: 'search-a', branches: 3, winner: 1, value: 0.91 });

    const score = scoreExploration(store.sql, store.actor);

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
    // Defect shape: nodes exist, the run is visible, and nothing ranked.
    const store = forkStore();
    seedSearch(store, { root: 'search-b', branches: 3, winner: null });

    const score = scoreExploration(store.sql, store.actor);

    expect(score.searchRuns).toBe(1);
    expect(score.branchedRuns).toBe(1);
    expect(score.rankedRuns).toBe(0);
    expect(score.durablyRankedRuns).toBe(0);
    store.close();
  });

  test('a single-branch search ranked nothing — there was no competition to win', () => {
    const store = forkStore();
    seedSearch(store, { root: 'search-c', branches: 1, winner: 0 });

    const score = scoreExploration(store.sql, store.actor);

    expect(score.searchRuns).toBe(1);
    expect(score.branchedRuns).toBe(0);
    store.close();
  });

  test('an empty store reports a ZERO denominator, not a pass', () => {
    const store = forkStore();
    const score = scoreExploration(store.sql, store.actor);
    expect(score.searchRuns).toBe(0);
    expect(score.branchedRuns).toBe(0);
    expect(score.runs).toEqual([]);
    store.close();
  });

  test('a journal-only run is not counted as a run with a search tree', () => {
    // `searchRuns === 0` is also what an empty or foreign-actor store reports, so the run is
    // proved visible to the production reader before being denied a tree.
    const store = forkStore();
    seedHeads(store, { root: 'merge-a', heads: 2 });

    const listed = listForkRuns(store.sql, store.actor, null, 10).items;
    expect(listed.map((run) => run.id)).toEqual(['merge-a']);
    expect(listed[0]).toMatchObject({ hasNodeTranscripts: true, hasSearchTree: false });

    expect(scoreExploration(store.sql, store.actor).searchRuns).toBe(0);
    store.close();
  });
});

describe('scoreSettleVisibility — every half a run writes is where the reader reads', () => {
  test('both stores populated: every written root is visible', () => {
    const store = forkStore();
    seedSearch(store, { root: 'search-a', branches: 2, winner: 0 });
    seedHeads(store, { root: 'merge-a', heads: 2 });

    const score = scoreSettleVisibility(store.sql, store.actor);

    expect(score.rootsWritten).toBe(2);
    expect(score.invisibleRoots).toEqual([]);

    for (const half of score.stores) {
      expect(half.rootsWritten).toBe(1);
      expect(half.rootsVisible).toBe(1);
    }

    store.close();
  });

  test('the reader is asked for more rows than were written, so its window is never the failure', () => {
    // The reader's default window is 20; 25 runs keep the scorer from blaming that limit.
    const store = forkStore();

    for (let i = 0; i < 25; i++) seedHeads(store, { root: `merge-${String(i)}`, heads: 1 });
    seedSearch(store, { root: 'search-late', branches: 2, winner: 0 });

    const score = scoreSettleVisibility(store.sql, store.actor);

    expect(score.rootsWritten).toBe(26);
    expect(score.invisibleRoots).toEqual([]);
    store.close();
  });

  test('NEGATIVE CONTROL: a reader that reads only head_journal loses every search', () => {
    // Tree search wrote search_nodes while the reader read head_journal: must fail and name the store.
    const store = forkStore();
    seedSearch(store, { root: 'search-a', branches: 2, winner: 0 });
    seedHeads(store, { root: 'merge-a', heads: 2 });

    const transcriptsOnly = (sql: SqlExecutor, limit: number) =>
      listForkRuns(sql, store.actor, null, limit).items.filter((run) => !run.hasSearchTree);

    const score = scoreSettleVisibility(store.sql, store.actor, transcriptsOnly);

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
    // The same bug reversed; both directions must fail.
    const store = forkStore();
    seedSearch(store, { root: 'search-a', branches: 2, winner: 0 });
    seedHeads(store, { root: 'merge-a', heads: 2 });

    const treeOnly = (sql: SqlExecutor, limit: number) =>
      listForkRuns(sql, store.actor, null, limit).items.filter((run) => run.hasSearchTree);

    const score = scoreSettleVisibility(store.sql, store.actor, treeOnly);

    expect(score.invisibleRoots).toEqual(['merge-a']);
    store.close();
  });

  test('NEGATIVE CONTROL: a writer filling a store no reader reads is invisible', () => {
    // A root in a store the reader has no query for: the shape of any future third store.
    const store = forkStore();
    seedHeads(store, { root: 'merge-a', heads: 1 });
    const noReader = () => [];
    const score = scoreSettleVisibility(store.sql, store.actor, noReader);

    expect(score.rootsWritten).toBe(1);
    expect(score.invisibleRoots).toEqual(['merge-a']);
    store.close();
  });

  test('steer-branch roots are excluded, so a correct reader does not look broken', () => {
    // Asserted as a difference: a lone steer-only store reads 0 whether the prefix filter works,
    // the fixture wrote nothing, or rows landed under another actor.
    const store = forkStore();
    seedHeads(store, { root: 'merge-a', heads: 1 });
    void store.sql`INSERT INTO head_journal
      (actor_id, id, parent_id, root_id, depth, task, status, spawned_at)
      VALUES (${store.actor.actorId}, ${'branch-abc-h0'}, ${null}, ${'branch-abc'}, ${0}, ${'steer'}, ${'completed'}, ${5_000})`;

    const score = scoreSettleVisibility(store.sql, store.actor);

    const transcripts = score.stores.find((half) => half.store === 'head_journal');
    expect(transcripts).toMatchObject({ rootsWritten: 1, rootsVisible: 1 });
    expect(score.rootsWritten).toBe(1);
    expect(score.invisibleRoots).toEqual([]);
    store.close();
  });

  test('an empty store reports a ZERO denominator, not a pass', () => {
    const store = forkStore();
    const score = scoreSettleVisibility(store.sql, store.actor);
    expect(score.rootsWritten).toBe(0);
    expect(score.invisibleRoots).toEqual([]);
    store.close();
  });
});

/** A run-event store bound to one actor. */
type EventStore = TestSql & { actor: ActorHandle };

function eventStore(): EventStore {
  const store = createTestSql();
  initRunEventTables(store.execRaw);

  return { ...store, actor: testActorHandle(store.sql) };
}

let eventIndex = 0;

/**
 * Payload is the whole stamped event `{...input, eventIndex, runId, timestamp}`, as
 * `RunEventRecorder` writes it; type fields alone pass `json_extract` but fail the canonical parse.
 */
function emit(
  store: EventStore, runId: string, type: string, payload: JsonObject,
): void {
  eventIndex += 1;

  const event = {
    ...payload, type, runId, eventIndex, timestamp: new Date().toISOString(),
  };

  void store.sql`INSERT INTO run_events (actor_id, run_id, event_index, type, payload, ts)
    VALUES (${store.actor.actorId}, ${runId}, ${eventIndex}, ${type},
            ${JSON.stringify(event)}, ${event.timestamp})`;
}

describe('BEHAVIOUR_SCORERS — the panel contract', () => {
  test('every scorer is uniquely named and reports a null rate over an empty store', () => {
    const store = eventStore();
    const names = BEHAVIOUR_SCORERS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(BEHAVIOUR_SCORERS.length).toBeGreaterThanOrEqual(6);

    for (const scorer of BEHAVIOUR_SCORERS) {
      const score = scorer.score(store.sql, store.actor);
      expect(score.eligible, `${scorer.name} denominator`).toBe(0);
      expect(score.passed, `${scorer.name} numerator`).toBe(0);
      // Absent is not zero.
      expect(score.rate, `${scorer.name} rate`).toBeNull();
      expect(scorer.asserts.length, `${scorer.name} asserts`).toBeGreaterThan(0);
    }

    store.close();
  });

  test('a rate is never reported above 1, so paired statistics stay well-formed', () => {
    const store = eventStore();
    // followUps deliberately exceeds referenced: one spill address cited twice.
    emit(store, 'run-a', 'context_budget', {
      admittedChars: 10, omittedChars: 900, trips: { run: 1 },
      referenced: 1, followUps: 3,
    });
    const score = spillRetrieval.score(store.sql, store.actor);
    expect(score.eligible).toBe(1);
    expect(score.rate).toBe(1);
    store.close();
  });
});

describe('steeringConversion — every mechanical trigger', () => {
  test('a repeat-breaker steer that converted is counted', () => {
    const store = eventStore();
    emit(store, 'run-a', 'turn_steering', { trigger: 'repeated_call', step: 3, tool: 'shell', converted: true });
    emit(store, 'run-a', 'turn_steering', { trigger: 'no_progress', step: 9, converted: true });

    expect(steeringConversion.score(store.sql, store.actor).rate).toBe(1);
    store.close();
  });

  test('RED: steers that fired and did not convert score below 1', () => {
    const store = eventStore();

    for (let i = 0; i < 3; i++) {
      emit(store, `run-${String(i)}`, 'turn_steering', {
        trigger: 'repeated_failure', step: 5, tool: 'shell', converted: false,
      });
    }

    emit(store, 'run-x', 'turn_steering', { trigger: 'repeated_failure', step: 5, tool: 'shell', converted: true });

    const score = steeringConversion.score(store.sql, store.actor);
    expect(score.eligible).toBe(4);
    expect(score.passed).toBe(1);
    expect(score.rate).toBe(0.25);
    store.close();
  });

  test('a trigger outside the producer picklist THROWS rather than vanishing', () => {
    // `trigger` is a picklist, so a trigger missing from the schema throws instead of silently
    // dropping out of this denominator.
    const store = eventStore();
    emit(store, 'run-a', 'turn_steering', { trigger: 'some_future_trigger', step: 1, converted: false });
    expect(() => steeringConversion.score(store.sql, store.actor))
      .toThrow(/Invalid type: Expected \("repeated_call" \| "repeated_failure" \| "no_progress"\) but received "some_future_trigger"/);
    store.close();
  });

  test('a malformed row of an UNRELATED type does not break this scorer', () => {
    // Scorers narrow by type in SQL first, so a corrupt `step_finish` costs one number, not eight.
    const store = eventStore();
    emit(store, 'run-a', 'turn_steering', { trigger: 'no_progress', step: 2, converted: true });
    void store.sql`INSERT INTO run_events (actor_id, run_id, event_index, type, payload, ts)
      VALUES (${store.actor.actorId}, ${'run-a'}, ${9_999}, ${'step_finish'},
              ${'{"type":"step_finish","nonsense":true}'}, ${'t'})`;

    const score = steeringConversion.score(store.sql, store.actor);

    expect(score.eligible).toBe(1);
    expect(score.passed).toBe(1);
    expect(toolOutcomes.score(store.sql, store.actor).eligible).toBe(0);
    store.close();
  });
});

describe('craftReuse — the in-episode loop closing', () => {
  test('crafted then reused scores over the tools crafted, not the turns', () => {
    const store = eventStore();
    emit(store, 'run-a', 'craft_cycle', {
      crafted: ['grep_imports', 'count_todos'], invoked: ['grep_imports'],
      reused: ['grep_imports'], returned: 1, raised: 0, dropped: [],
    });
    const score = craftReuse.score(store.sql, store.actor);
    expect(score.eligible).toBe(2);
    expect(score.passed).toBe(1);
    expect(score.rate).toBe(0.5);
    store.close();
  });

  test('RED: a tool crafted and never reached for again scores zero over a real denominator', () => {
    const store = eventStore();
    emit(store, 'run-a', 'craft_cycle', {
      crafted: ['write_only'], invoked: [], reused: [], returned: 0, raised: 0, dropped: [],
    });
    const score = craftReuse.score(store.sql, store.actor);
    expect(score.eligible).toBe(1);
    expect(score.passed).toBe(0);
    expect(score.rate).toBe(0);
    store.close();
  });

  test('a turn that only invoked a previously-crafted tool crafts no new denominator', () => {
    const store = eventStore();
    emit(store, 'run-a', 'craft_cycle', {
      crafted: [], invoked: ['from_last_turn'], reused: [], returned: 1, raised: 0, dropped: [],
    });
    const score = craftReuse.score(store.sql, store.actor);
    expect(score.eligible).toBe(0);
    expect(score.rate).toBeNull();
    expect(score.detail).toContain('1 crafted-tool invocations');
    store.close();
  });
});

describe('editLanding — did the edit actually land', () => {
  test('applied over attempted, with the dominant failure mode named', () => {
    const store = eventStore();
    emit(store, 'run-a', 'file_edit', {
      attempts: 4, applied: 3, failures: { not_found: 1 },
      recoveredPaths: 1, abandonedPaths: 0,
    });
    const score = editLanding.score(store.sql, store.actor);
    expect(score.eligible).toBe(4);
    expect(score.passed).toBe(3);
    expect(score.detail).toContain('not_found×1');
    store.close();
  });

  test('RED: a turn that attempted edits and landed none scores zero, not null', () => {
    const store = eventStore();
    emit(store, 'run-a', 'file_edit', {
      attempts: 5, applied: 0, failures: { stale: 3, ambiguous: 2 },
      recoveredPaths: 0, abandonedPaths: 2,
    });
    const score = editLanding.score(store.sql, store.actor);
    expect(score.eligible).toBe(5);
    expect(score.passed).toBe(0);
    expect(score.rate).toBe(0);
    expect(score.detail).toContain('stale×3');
    expect(score.detail).toContain('2 paths abandoned');
    store.close();
  });
});

describe('recoveryDurability — the recovery that TOOK', () => {
  test('a finding whose signature never recurs holds', () => {
    const store = eventStore();
    emit(store, 'run-a', 'execution_recovery', {
      recoveries: [{ tool: 'shell', failures: 3, failedSignature: 'run:bun test x' }],
    });
    const score = recoveryDurability.score(store.sql, store.actor);
    expect(score.eligible).toBe(1);
    expect(score.passed).toBe(1);
    expect(score.detail).toContain('3 consecutive failures absorbed');
    store.close();
  });

  test('RED: the same signature failing again in a LATER turn scores the finding red', () => {
    // The producer's named falsifier: without it, recoveries-over-recoveries is 1.00 on every run.
    const store = eventStore();
    emit(store, 'run-a', 'execution_recovery', {
      recoveries: [{ tool: 'shell', failures: 2, failedSignature: 'run:pytest -q' }],
    });
    emit(store, 'run-a', 'execution_recovery', {
      recoveries: [{ tool: 'shell', failures: 4, failedSignature: 'run:pytest -q' }],
    });
    const score = recoveryDurability.score(store.sql, store.actor);
    expect(score.eligible).toBe(1);
    expect(score.passed).toBe(0);
    expect(score.rate).toBe(0);
    expect(score.detail).toContain('1 signatures failed again later');
    store.close();
  });

  test('the same signature under a DIFFERENT tool is a different finding', () => {
    const store = eventStore();
    emit(store, 'run-a', 'execution_recovery', {
      recoveries: [
        { tool: 'shell', failures: 1, failedSignature: 'same' },
        { tool: 'file', failures: 1, failedSignature: 'same' },
      ],
    });
    const score = recoveryDurability.score(store.sql, store.actor);
    expect(score.eligible).toBe(2);
    expect(score.passed).toBe(2);
    store.close();
  });
});

describe('completionHonesty — polarity is the reverse of every other scorer', () => {
  test('a gate that found no work left is the PASS', () => {
    const store = eventStore();
    emit(store, 'run-a', 'completion_gate', { converted: false });
    const score = completionHonesty.score(store.sql, store.actor);
    expect(score.eligible).toBe(1);
    expect(score.passed).toBe(1);
    expect(score.detail).toContain('0 were forced back to work');
    store.close();
  });

  test('RED: converted=true means it claimed done with work left, and must score red', () => {
    // Converted-as-numerator would reward declaring victory early.
    const store = eventStore();
    emit(store, 'run-a', 'completion_gate', { converted: true });
    emit(store, 'run-b', 'completion_gate', { converted: true });
    emit(store, 'run-c', 'completion_gate', { converted: false });
    const score = completionHonesty.score(store.sql, store.actor);
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
    emit(store, 'run-a', 'context_budget', {
      admittedChars: 1_000, omittedChars: 40_000, trips: { run: 2 },
      referenced: 2, followUps: 2,
    });
    const score = spillRetrieval.score(store.sql, store.actor);
    expect(score.eligible).toBe(2);
    expect(score.passed).toBe(2);
    expect(score.detail).toContain('40000 chars withheld');
    store.close();
  });

  test('RED: a readable spill the agent never fetched scores zero', () => {
    const store = eventStore();
    emit(store, 'run-a', 'context_budget', {
      admittedChars: 500, omittedChars: 80_000, trips: { run: 3 },
      referenced: 3, followUps: 0,
    });
    const score = spillRetrieval.score(store.sql, store.actor);
    expect(score.eligible).toBe(3);
    expect(score.passed).toBe(0);
    expect(score.rate).toBe(0);
    store.close();
  });

  test('a spill with no resolvable address is excluded, not charged to the agent', () => {
    // Nothing to read back is a harness failure, not the model's.
    const store = eventStore();
    emit(store, 'run-a', 'context_budget', {
      admittedChars: 0, omittedChars: 9_000, trips: { attachment: 1 },
      referenced: 0, followUps: 0,
    });
    const score = spillRetrieval.score(store.sql, store.actor);
    expect(score.eligible).toBe(0);
    expect(score.rate).toBeNull();
    store.close();
  });
});

describe('toolOutcomes — structural attribution with an observed denominator', () => {
  test('producer outcomes win over error-looking data and clean-looking failures', () => {
    const store = eventStore();
    emit(store, 'run-a', 'tool_call_end', {
      name: 'file', toolCallId: 't1', outcome: { success: true }, result: { error: 'ordinary document data' },
    });
    emit(store, 'run-a', 'tool_call_end', {
      name: 'shell', toolCallId: 't2', outcome: { success: true }, result: 'Error (exit 3)',
    });
    emit(store, 'run-a', 'tool_call_end', {
      name: 'shell', toolCallId: 't3', outcome: { success: false, reason: null, execution: { exitCode: 3 } }, result: 'ok',
    });
    const result = toolOutcomes.score(store.sql, store.actor);
    expect(result.eligible).toBe(3);
    expect(result.passed).toBe(2);
    expect(result.rate).toBeCloseTo(2 / 3);
    expect(result.measured).toEqual({ succeeded: 2, failed: 1, unmeasured: 0 });
    store.close();
  });

  test('rows with no producer outcome remain observed but cannot supply a success rate', () => {
    const store = eventStore();
    emit(store, 'run-a', 'tool_call_end', { name: 'shell', toolCallId: 't1', result: 'Error (exit 3)' });
    emit(store, 'run-a', 'tool_call_end', { name: 'shell', toolCallId: 't2', error: 'a bare error string, no outcome' });
    emit(store, 'run-a', 'tool_call_end', { name: 'file', toolCallId: 't3', error: '', result: 'ok' });
    const result = toolOutcomes.score(store.sql, store.actor);
    expect(result.eligible).toBe(3);
    expect(result.passed).toBe(0);
    expect(result.rate).toBeNull();
    expect(result.measured).toEqual({ succeeded: 0, failed: 1, unmeasured: 2 });
    store.close();
  });

  test('failure attribution uses recorded refusal reasons and process exits', () => {
    const store = eventStore();

    for (const id of ['t1', 't2']) emit(store, 'run-a', 'tool_call_end', {
      name: 'file', toolCallId: id, args: { action: 'edit' }, outcome: { success: false, reason: 'not_found' }, result: 'no details',
    });
    emit(store, 'run-a', 'tool_call_end', {
      name: 'shell', toolCallId: 't3', outcome: { success: false, reason: null, execution: { exitCode: 1 } }, result: 'no details',
    });
    const result = toolOutcomes.score(store.sql, store.actor);
    expect(result.eligible).toBe(3);
    expect(result.passed).toBe(0);
    expect(result.rate).toBe(0);
    expect(parseFailureMix(result.detail)).toEqual([['file·edit·not_found', 2], ['shell·exit_1', 1]]);
    store.close();
  });
});
