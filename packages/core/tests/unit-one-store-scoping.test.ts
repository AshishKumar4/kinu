/**
 * Every remaining per-actor table, over ONE physical database.
 *
 * The companion to `unit-actor-private-stores.test.ts`, which covers the five
 * store families that were scoped first. This file covers the rest: the
 * evolution ledgers, the identity logs, the effect ledgers, the safety
 * decisions, the plan/curriculum/prompt stores, the search and exploration
 * records, the subordinate roster, the events hub, and the workspace baseline.
 *
 * Every case here runs TWO issued actor handles over a SINGLE `SqlExecutor`.
 * That is the shape the scoping exists for and the only shape that can falsify
 * it: with a database per actor these assertions all pass vacuously, because
 * the rows were never in the same table.
 *
 * THE KEYS COLLIDE ON PURPOSE, and each case picks the identifier the two
 * actors really would present the same: a turn id, a session key, a debt-key
 * digest over the same turn ids, a subordinate name chosen by its parent, a
 * candidate id minted by the caller, a mission label, an upstream webhook or
 * timer delivery id. "The ids happen to differ" is not available as a reason
 * these rows stay apart.
 *
 * The last block is the other half of the binding: a handle whose validation
 * throws is refused BEFORE its statement runs, and the row count is unchanged.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createMemoryVfs, createScriptedLLM, testActorHandle } from '@kinu.run/test-utils';
import { makeExecRaw, makeSql, makeSqlExec } from './helpers';
import type { ActorHandle } from '../src/identity/actor-handle';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { RawSqlExec, SqlExec, SqlExecutor, VFS } from '../src/types/primitives';

import {
  initTurnOutcomeTables, recordTurnOutcome, listTurnOutcomes, recordedTurnVerdict,
  takePickOutcome, recordOutcomeLabels, listOutcomeLabels, goldLabels,
  recordEnsembleLabels, ensembleLabels, recordLesson, listLessons, getLesson,
  corroborateLessonsForTurn,
} from '../src/evolution/outcomes';
import { initCompletedTurnTable, createCompletedTurnStore } from '../src/evolution/session-window';
import { initReplayTables, runReplayEval, listReplayEvals } from '../src/evolution/replay';
import { initRefinementTables, createRefinementStore } from '../src/evolution/refinement';
import {
  initGepaTables, startGepaRun, persistGepaCandidate, listGepaRuns, loadGepaCandidates,
} from '../src/evolution/gepa/persistence';
import { initActorTables } from '../src/identity/schema';
import {
  initEffectTombstoneTable, effectAlreadyDone, recordEffectDone,
} from '../src/identity/effect-tombstones';
import { initTerminalEffectTable, TerminalEffectLedger } from '../src/orchestrator/terminal-effects';
import {
  initToolEffectClaimTable, claimToolEffect, settleToolEffect, releaseTurnEffectClaims,
} from '../src/tools/effect-claim';
import { initDeferredApprovalsTable, DeferredApprovalStore } from '../src/safety/deferred-approval';
import {
  initInstructionApprovalsTable, InstructionApprovalStore, instructionDigest,
} from '../src/safety/instruction-trust';
import { initPlanReviewTable, PlanReviewStore } from '../src/plans/review';
import {
  initCurriculumTable, listProposedTasks, updateProposedTaskStatus,
} from '../src/curriculum/proposer';
import {
  initPromptSectionTables, activePromptSectionOverrides, incumbentSectionSource,
  firstPendingPromptSection, getPendingPromptSection, applyPromptSectionDecision,
  recordPromptSectionTrial, promptSectionTrialRecord, listPromptSectionVersions,
} from '../src/prompting/section-store';
import { PROMPT_SECTIONS } from '../src/prompting/section-templates';
import {
  initAlternateTakesTable, recordBranchTakeSet, listAlternateTakeSets,
  latestAlternateTakeSet, claimAlternateTakesForTurn, unclaimedAlternateTakeIds,
  purgeUnclaimedAlternateTakes, recordTakePick,
} from '../src/mcts/takes';
import { initSearchTables } from '../src/mcts/schemas';
import {
  initExplorationRecordsTable, recordExploration, recordsFor, bestInCell, describeObjective,
  recordHandleOf, objectiveIdOf, verifierDigestOf,
} from '../src/strategy/records';
import {
  initSwarmNodeRecords, recordSwarmNode, markSwarmNodeMerged, readSwarmNodeRecords,
  type SwarmNodeRecord,
} from '../src/strategy/swarm-resume';
import {
  initImportedExperienceTable, stageImport, listImportedExperience, bindPendingImports,
} from '../src/experience/imports';
import { MissionBudgetLedger, listMissionSpend } from '../src/mission-budget';
import { SubordinateRosterStore } from '../src/subordinates/roster';
import { SubordinateIdentityStore, readSubordinateLiveStatus } from '../src/subordinates/support';
import { initEventsHubTables } from '../src/events/hub/schema';
import { EventLog } from '../src/events/hub/log';
import { ReplyChannelStore } from '../src/events/hub/reply-channel';
import { TriggerRegistry } from '../src/events/hub/triggers';
import {
  initWorkspaceBaselineTable, resetWorkspaceBaseline, getWorkspaceDiff,
} from '../src/read-models/workspace-diff';

// ── the world ────────────────────────────────────────────────────

interface World {
  readonly db: Database;
  readonly sql: SqlExecutor;
  readonly execRaw: RawSqlExec;
  readonly exec: SqlExec;
  readonly a: ActorHandle;
  readonly b: ActorHandle;
  /** Stop `revocable` answering — the binding's validation then throws. */
  revoke(): void;
  /** A handle that is live until {@link World.revoke}. */
  readonly revocable: ActorHandle;
  count(table: string): number;
  close(): void;
}

/** One database, three handles over it: two peers, and one the test can
 *  revoke to observe the refusal every bound store owes. */
function world(): World {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const exec = makeSqlExec(db);
  let live = true;
  return {
    db, sql, execRaw, exec,
    a: testActorHandle(sql, { actorId: 'actor-a' }),
    b: testActorHandle(sql, { actorId: 'actor-b' }),
    revocable: testActorHandle(sql, { actorId: 'actor-r', live: () => live }),
    revoke: () => { live = false; },
    count: (table) => db.prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).all()[0]?.n ?? 0,
    close: () => db.close(),
  };
}

/** A runtime over the world's database, bound to one of its actors — for the
 *  stores whose entry point is an `AgentRuntime` rather than a raw handle. */
function runtimeFor(w: World, actor: ActorHandle, vfs: VFS = createMemoryVfs().vfs): AgentRuntime {
  return {
    actor,
    storage: {
      vfs,
      sql: w.sql,
      execRaw: w.execRaw,
      transactionSync: (write) => w.db.transaction(write)(),
    },
    memory: {
      write: async () => {}, append: async () => {}, index: async () => {},
      search: async () => [], read: async () => null,
    },
    executor: { languages: ['javascript'], execute: async () => ({ result: undefined }) },
    llm: createScriptedLLM([]),
    schedule: {
      after: async (_ms, fn) => { await fn(); },
      cron: async () => {},
      fiber: async (_name, fn) => await fn({ stash: () => {}, snapshot: null }),
    },
    identity: {
      id: actor.actorId,
      name: actor.name,
      scaffold: {
        path: 'scaffold/agent.js',
        exists: async () => false,
        read: async () => '',
        write: async () => {},
        version: async () => 0,
      },
    },
    craftStore: {
      create: () => {}, update: () => {}, list: () => [], get: () => undefined,
      delete: () => {}, search: () => [],
    },
    spawnBranch: async () => ({
      explore: async () => ({ text: '' }),
      generateReflection: async () => ({ text: '' }),
      release: async () => {},
    }),
    abortBranch: async () => {},
    executionRouter: {
      register: () => {}, unregister: () => {}, listExecutors: () => [],
      getProvider: () => undefined, getProviders: () => [],
    },
  };
}

// ── evolution/outcomes.ts ────────────────────────────────────────

describe('two actors, one database: turn_outcomes', () => {
  test('both actors grade the same turn id, and each reads back its own verdict', () => {
    const w = world();
    initTurnOutcomeTables(w.execRaw);

    recordTurnOutcome(w.sql, w.a, {
      turnId: 'turn-1', outcome: 'accepted', confidence: 1, source: 'explicit',
      userMessage: 'ask', assistantResponse: 'from-a', now: 10,
    });
    recordTurnOutcome(w.sql, w.b, {
      turnId: 'turn-1', outcome: 'frustrated', confidence: 1, source: 'explicit',
      userMessage: 'ask', assistantResponse: 'from-b', now: 10,
    });

    expect(w.count('turn_outcomes')).toBe(2);
    expect(recordedTurnVerdict(w.sql, w.a, 'turn-1')?.outcome).toBe('accepted');
    expect(recordedTurnVerdict(w.sql, w.b, 'turn-1')?.outcome).toBe('frustrated');
    expect(listTurnOutcomes(w.sql, w.a).map((r) => r.assistantResponse)).toEqual(['from-a']);
    expect(listTurnOutcomes(w.sql, w.b).map((r) => r.assistantResponse)).toEqual(['from-b']);
    w.close();
  });

  test('a take pick recorded by one actor is not the other actor\'s pick', () => {
    const w = world();
    initTurnOutcomeTables(w.execRaw);
    recordTurnOutcome(w.sql, w.a, {
      turnId: 'turn-1', outcome: 'corrected', confidence: 1, source: 'take_pick',
      userMessage: 'ask', assistantResponse: 'a', now: 5,
    });
    expect(takePickOutcome(w.sql, w.a, 'turn-1')).toBe('corrected');
    expect(takePickOutcome(w.sql, w.b, 'turn-1')).toBeNull();
    w.close();
  });
});

describe('two actors, one database: lessons', () => {
  test('the same KEYED lesson id is a row per actor, and corroboration stops at the owner', () => {
    const w = world();
    initTurnOutcomeTables(w.execRaw);

    // `key` makes the row id deterministic — the exact collision two actors
    // replaying the same import or reflection would present.
    const idA = recordLesson(w.sql, w.a, {
      turnIds: ['turn-1'], text: 'from-a', source: 'turn_reflection', status: 'provisional', key: 'k1',
    });
    const idB = recordLesson(w.sql, w.b, {
      turnIds: ['turn-1'], text: 'from-b', source: 'turn_reflection', status: 'provisional', key: 'k1',
    });
    expect(idA).toBe(idB);
    expect(w.count('lessons')).toBe(2);

    expect(getLesson(w.sql, w.a, idA)?.text).toBe('from-a');
    expect(getLesson(w.sql, w.b, idB)?.text).toBe('from-b');

    corroborateLessonsForTurn(w.sql, w.a, 'turn-1', 99);
    expect(getLesson(w.sql, w.a, idA)?.status).toBe('corroborated');
    expect(getLesson(w.sql, w.b, idB)?.status).toBe('provisional');
    expect(listLessons(w.sql, w.b, { status: 'corroborated' })).toHaveLength(0);
    w.close();
  });
});

describe('two actors, one database: outcome_labels and outcome_ensemble_labels', () => {
  test('both actors label the same outcome id and neither sees the other\'s verdict', () => {
    const w = world();
    initTurnOutcomeTables(w.execRaw);

    recordOutcomeLabels(w.sql, w.a, { labeler: 'ana', labels: [{ outcomeId: 'outc-1', label: 'accepted' }] });
    recordOutcomeLabels(w.sql, w.b, { labeler: 'ben', labels: [{ outcomeId: 'outc-1', label: 'frustrated' }] });
    expect(w.count('outcome_labels')).toBe(2);
    expect(listOutcomeLabels(w.sql, w.a).map((r) => r.labeler)).toEqual(['ana']);
    expect(goldLabels(w.sql, w.b).get('outc-1')?.label).toBe('frustrated');

    recordEnsembleLabels(w.sql, w.a, { model: 'm/1', labels: [{ outcomeId: 'outc-1', label: 'accepted' }] });
    recordEnsembleLabels(w.sql, w.b, { model: 'm/1', labels: [{ outcomeId: 'outc-1', label: 'corrected' }] });
    expect(w.count('outcome_ensemble_labels')).toBe(2);
    expect(ensembleLabels(w.sql, w.a).map((r) => r.label)).toEqual(['accepted']);
    expect(ensembleLabels(w.sql, w.b).map((r) => r.label)).toEqual(['corrected']);
    w.close();
  });
});

describe('two actors, one database: pattern_extractions', () => {
  test('one effect key holds a different held answer for each actor', () => {
    const w = world();
    initTurnOutcomeTables(w.execRaw);
    // The store for this table lives in the evolution engine; what is scoped
    // here is the row identity, so the exercise is the identity itself.
    for (const [actor, answer] of [[w.a, 'from-a'], [w.b, 'from-b']] as const) {
      void w.sql`INSERT INTO pattern_extractions (actor_id, effect_key, answer, created_at)
        VALUES (${actor.actorId}, ${'turn-1:pattern'}, ${answer}, 1)`;
    }
    expect(w.count('pattern_extractions')).toBe(2);
    const read = (actor: ActorHandle): string | undefined => w.sql<{ answer: string }>`
      SELECT answer FROM pattern_extractions
      WHERE actor_id = ${actor.actorId} AND effect_key = ${'turn-1:pattern'}`[0]?.answer;
    expect(read(w.a)).toBe('from-a');
    expect(read(w.b)).toBe('from-b');
    w.close();
  });
});

// ── evolution/session-window.ts + identity/effect-tombstones.ts ──

describe('two actors, one database: completed_turns', () => {
  test('the same recorded turn id opens a window for each actor', () => {
    const w = world();
    initCompletedTurnTable(w.execRaw);
    const a = createCompletedTurnStore(w.sql, w.a);
    const b = createCompletedTurnStore(w.sql, w.b);
    const turn = {
      userMessage: 'ask', assistantResponse: 'answer', toolCalls: [], steps: 1,
      durationMs: 1, feedback: null, hadError: false,
    };

    expect(a.append(turn, { awaitsFollowup: false, id: 'row-1', now: 1 })).toBe('row-1');
    expect(b.append(turn, { awaitsFollowup: false, id: 'row-1', now: 1 })).toBe('row-1');
    expect(w.count('completed_turns')).toBe(2);
    expect(a.size()).toBe(1);
    expect(b.size()).toBe(1);
    expect(a.countQueuedReviews()).toBe(1);

    // A drains its own queue; B's identically-keyed row is untouched.
    const taken = a.takeQueuedReviews(5);
    expect(taken.reviews.map((r) => r.id)).toEqual(['row-1']);
    expect(a.countQueuedReviews()).toBe(0);
    expect(b.countQueuedReviews()).toBe(1);
    w.close();
  });
});

describe('two actors, one database: effect_tombstones', () => {
  test('one scope+key is done for one actor and still owed by the other', () => {
    const w = world();
    initEffectTombstoneTable(w.execRaw);
    recordEffectDone(w.sql, w.a, 'turn_review', 'row-1', 7);
    expect(w.count('effect_tombstones')).toBe(1);
    expect(effectAlreadyDone(w.sql, w.a, 'turn_review', 'row-1')).toBe(true);
    expect(effectAlreadyDone(w.sql, w.b, 'turn_review', 'row-1')).toBe(false);
    recordEffectDone(w.sql, w.b, 'turn_review', 'row-1', 8);
    expect(w.count('effect_tombstones')).toBe(2);
    w.close();
  });
});

// ── evolution/replay.ts ──────────────────────────────────────────

describe('two actors, one database: replay_evals', () => {
  test('each actor samples its own ledger and reads back only its own curve', async () => {
    const w = world();
    initTurnOutcomeTables(w.execRaw);
    initReplayTables(w.execRaw);
    for (const [actor, response] of [[w.a, 'a-answer'], [w.b, 'b-answer']] as const) {
      recordTurnOutcome(w.sql, actor, {
        turnId: 'turn-1', outcome: 'accepted', confidence: 1, source: 'explicit',
        userMessage: 'ask', assistantResponse: response, now: 1,
      });
    }

    const summary = await runReplayEval({
      sql: w.sql, actor: w.a,
      judge: createScriptedLLM(['{"score":1,"note":"ok"}']),
      runTask: async () => 'fresh',
      sampleSize: 1, now: 2,
    });
    expect(summary?.sampleSize).toBe(1);
    expect(listReplayEvals(w.sql, w.a)).toHaveLength(1);
    expect(listReplayEvals(w.sql, w.b)).toHaveLength(0);
    w.close();
  });
});

// ── evolution/refinement.ts ──────────────────────────────────────

describe('two actors, one database: refinement_requests', () => {
  test('one debt key opens a request for EACH actor', () => {
    const w = world();
    initRefinementTables(w.execRaw);
    const a = createRefinementStore(w.sql, w.a);
    const b = createRefinementStore(w.sql, w.b);
    const input = {
      trigger: 'evolution_debt' as const, scope: 'workspace' as const,
      turnIds: ['turn-1', 'turn-2'], debtKey: 'digest-1', now: 1,
    };

    const first = a.open(input);
    const second = b.open(input);
    // Both CREATED: the unique debt-key index is per owner, so one actor's
    // batch cannot refuse a sibling that owes a refinement over the same turns.
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(w.count('refinement_requests')).toBe(2);

    // And a re-open under the same key still collapses WITHIN one actor.
    expect(a.open(input).created).toBe(false);
    expect(w.count('refinement_requests')).toBe(2);

    expect(a.list()).toHaveLength(1);
    expect(a.nextRequested()?.id).toBe(first.request.id);
    expect(b.nextRequested()?.id).toBe(second.request.id);

    const claim = a.claim(first.request.id);
    expect(claim).not.toBeNull();
    // A's claim moved A's row off `requested`; B's is still the next one owed.
    expect(a.nextRequested()).toBeNull();
    expect(b.nextRequested()?.id).toBe(second.request.id);
    expect(a.coveredTurnIds().size).toBe(2);
    w.close();
  });
});

// ── evolution/gepa/persistence.ts ────────────────────────────────

describe('two actors, one database: gepa_runs and gepa_candidates', () => {
  test('a caller-minted candidate id belongs to one run of one actor', () => {
    const w = world();
    initGepaTables(w.execRaw);
    const runA = startGepaRun(w.sql, w.a, { target: 'scaffold' });
    const runB = startGepaRun(w.sql, w.b, { target: 'scaffold' });

    const candidate = (source: string) => ({
      id: 'cand-1', parentId: null, source,
      scores: new Map([['i1', 1]]), feedback: new Map<string, string>(),
      aggregateScore: 1, createdAt: 1,
    });
    persistGepaCandidate(w.sql, w.a, { runId: runA, candidate: candidate('from-a'), iteration: 0, accepted: true });
    persistGepaCandidate(w.sql, w.b, { runId: runB, candidate: candidate('from-b'), iteration: 0, accepted: true });

    expect(w.count('gepa_candidates')).toBe(2);
    expect(loadGepaCandidates(w.sql, w.a, runA).map((c) => c.source)).toEqual(['from-a']);
    expect(loadGepaCandidates(w.sql, w.b, runB).map((c) => c.source)).toEqual(['from-b']);
    expect(listGepaRuns(w.sql, w.a).map((r) => r.runId)).toEqual([runA]);
    expect(listGepaRuns(w.sql, w.b).map((r) => r.runId)).toEqual([runB]);
    w.close();
  });
});

// ── identity/schema.ts logs ──────────────────────────────────────

describe('two actors, one database: fibers, evolution_events, executor_output, activity_log', () => {
  test('each log row belongs to the actor that wrote it', () => {
    const w = world();
    initActorTables(w.execRaw, w.sql);

    for (const [actor, mark] of [[w.a, 'a'], [w.b, 'b']] as const) {
      const id = actor.actorId;
      void w.sql`INSERT INTO fibers (actor_id, id, name, snapshot, created_at)
        VALUES (${id}, ${'fib-1'}, ${'advisor-lane'}, ${mark}, 1)`;
      void w.sql`INSERT INTO evolution_events (actor_id, id, type, message, created_at)
        VALUES (${id}, ${'ev-1'}, ${'promotion'}, ${mark}, 1)`;
      void w.sql`INSERT INTO executor_output (actor_id, id, executor, command, stdout, created_at)
        VALUES (${id}, ${'out-1'}, ${'shell'}, ${'ls'}, ${mark}, 1)`;
      void w.sql`INSERT INTO activity_log (actor_id, id, event, detail, elapsed_ms, created_at)
        VALUES (${id}, ${'act-1'}, ${'step'}, ${mark}, 1, 1)`;
    }

    for (const table of ['fibers', 'evolution_events', 'executor_output', 'activity_log']) {
      expect(w.count(table)).toBe(2);
    }
    expect(w.sql<{ snapshot: string }>`SELECT snapshot FROM fibers
      WHERE actor_id = ${w.a.actorId} AND id = ${'fib-1'}`[0]?.snapshot).toBe('a');
    expect(w.sql<{ message: string }>`SELECT message FROM evolution_events
      WHERE actor_id = ${w.b.actorId} AND id = ${'ev-1'}`[0]?.message).toBe('b');
    expect(w.sql<{ stdout: string }>`SELECT stdout FROM executor_output
      WHERE actor_id = ${w.a.actorId} AND id = ${'out-1'}`[0]?.stdout).toBe('a');

    // The real reader over `activity_log`.
    expect(readSubordinateLiveStatus(w.exec, w.a).recentSteps.map((s) => s.summary)).toEqual(['a']);
    expect(readSubordinateLiveStatus(w.exec, w.b).recentSteps.map((s) => s.summary)).toEqual(['b']);
    w.close();
  });
});

// ── orchestrator/terminal-effects.ts ─────────────────────────────

describe('two actors, one database: terminal_effects', () => {
  test('one sequence id is a separate suffix for each actor', async () => {
    const w = world();
    initTerminalEffectTable(w.execRaw);
    // Claim only — the roster write is what the scoping is about, and it is
    // synchronous, so no wake and no effect body is involved.
    const a = new TerminalEffectLedger({
      sql: w.sql, actor: w.a, effects: {}, now: () => 1_000, scheduleRetry: async () => {},
    });
    const b = new TerminalEffectLedger({
      sql: w.sql, actor: w.b, effects: {}, now: () => 1_000, scheduleRetry: async () => {},
    });
    const owed = [{ name: 'turn_record' as const, scope: '', input: null, lane: 'inline' as const }];

    a.claim('turn-1', owed);
    b.claim('turn-1', owed);
    expect(w.count('terminal_effects')).toBe(2);
    expect(a.pendingSequences()).toEqual(['turn-1']);
    expect(b.pendingSequences()).toEqual(['turn-1']);

    // A settles its row directly; B's identically-keyed row is still owed.
    void w.sql`UPDATE terminal_effects SET status = 'completed'
      WHERE actor_id = ${w.a.actorId} AND sequence_id = ${'turn-1'}`;
    expect(a.pendingSequences()).toEqual([]);
    expect(b.pendingSequences()).toEqual(['turn-1']);
    a.prune('turn-1');
    expect(w.count('terminal_effects')).toBe(1);
    expect(b.pendingSequences()).toEqual(['turn-1']);
    w.close();
  });
});

// ── tools/effect-claim.ts ────────────────────────────────────────

describe('two actors, one database: tool_effect_claims', () => {
  test('one call key is claimable by each actor and settles only for its owner', () => {
    const w = world();
    initToolEffectClaimTable(w.execRaw);
    const key = { turnId: 'turn-1', callId: 'call-1', digest: 'digest-1' };

    expect(claimToolEffect(w.sql, w.a, key).kind).toBe('claimed');
    expect(claimToolEffect(w.sql, w.b, key).kind).toBe('claimed');
    expect(w.count('tool_effect_claims')).toBe(2);

    settleToolEffect(w.sql, w.a, key, JSON.stringify('done-by-a'));
    const a = claimToolEffect(w.sql, w.a, key);
    expect(a.kind === 'settled' ? a.result : null).toBe('done-by-a');
    // B's own attempt is still unsettled — not settled by A's result.
    expect(claimToolEffect(w.sql, w.b, key).kind).toBe('indeterminate');

    releaseTurnEffectClaims(w.sql, w.a, 'turn-1');
    expect(w.count('tool_effect_claims')).toBe(1);
    expect(claimToolEffect(w.sql, w.b, key).kind).toBe('indeterminate');
    w.close();
  });
});

// ── safety ───────────────────────────────────────────────────────

describe('two actors, one database: deferred_approvals', () => {
  test('the owner\'s decision for one actor does not answer for the other', () => {
    const w = world();
    initDeferredApprovalsTable(w.execRaw);
    const a = new DeferredApprovalStore(w.sql, w.a);
    const b = new DeferredApprovalStore(w.sql, w.b);
    const action = {
      id: 'appr-1', command: 'rm -rf /tmp/x', executor: 'workspace',
      reason: 'destructive', requestedAt: 1,
    };

    a.create(action);
    b.create(action);
    expect(w.count('deferred_approvals')).toBe(2);

    expect(a.decide('appr-1', 'approved', 5)?.status).toBe('approved');
    expect(a.standing(action.command, action.executor, 6)?.status).toBe('approved');
    expect(b.standing(action.command, action.executor, 6)?.status).toBe('queued');
    expect(b.get('appr-1')?.status).toBe('queued');
    expect(a.listQueued()).toHaveLength(0);
    expect(b.listQueued()).toHaveLength(1);
    w.close();
  });
});

describe('two actors, one database: instruction_approvals', () => {
  test('approvals are per actor within one scope, and a fresh actor starts undecided', () => {
    const w = world();
    initInstructionApprovalsTable(w.execRaw);
    const a = new InstructionApprovalStore(w.sql, w.a, 'owner/ws');
    const b = new InstructionApprovalStore(w.sql, w.b, 'owner/ws');
    const content = 'always deploy to staging';

    a.approve('SKILL.md', instructionDigest(content));
    expect(w.count('instruction_approvals')).toBe(1);
    expect(a.trustOf('SKILL.md', content)).toBe('approved');
    expect(b.trustOf('SKILL.md', content)).toBe('unverified');

    b.approve('SKILL.md', instructionDigest('something else'));
    expect(w.count('instruction_approvals')).toBe(2);
    expect(a.trustOf('SKILL.md', content)).toBe('approved');
    expect(b.trustOf('SKILL.md', content)).toBe('unverified');

    // No carry-over exists to inherit: a file B never decided about stays
    // unverified for B whatever A approved.
    expect(b.get('LEGACY.md')).toBeNull();
    expect(b.trustOf('LEGACY.md', 'legacy')).toBe('unverified');
    expect(a.list().map((r) => r.path)).toEqual(['SKILL.md']);
    expect(b.list().map((r) => r.path)).toEqual(['SKILL.md']);
    w.close();
  });
});

// ── plans/review.ts ──────────────────────────────────────────────

describe('two actors, one database: plan_reviews', () => {
  test('both actors hold plan-1 revision 1, and one approval decides one of them', () => {
    const w = world();
    initPlanReviewTable(w.execRaw);
    const opts = { newId: () => 'plan-1', now: () => 1_000 };
    const a = new PlanReviewStore(w.sql, w.a, opts);
    const b = new PlanReviewStore(w.sql, w.b, opts);
    const edits = [{ start: 1, content: 'do the thing' }];

    expect(a.submit('default', edits).ok).toBe(true);
    expect(b.submit('default', edits).ok).toBe(true);
    expect(w.count('plan_reviews')).toBe(2);

    expect(a.decide('plan-1', 1, 'approve').ok).toBe(true);
    expect(a.getActive('default')?.status).toBe('approved');
    expect(b.getActive('default')?.status).toBe('pending');
    expect(a.listPage('default').items).toHaveLength(1);
    w.close();
  });
});

// ── curriculum/proposer.ts ───────────────────────────────────────

describe('two actors, one database: proposed_tasks', () => {
  test('one proposal id is a row per actor, and a status change stops at the owner', () => {
    const w = world();
    initCurriculumTable(w.execRaw);
    for (const [actor, task] of [[w.a, 'from-a'], [w.b, 'from-b']] as const) {
      void w.sql`INSERT INTO proposed_tasks
          (actor_id, id, task, rationale, predicted_success, targets_skills, proposed_at, status)
        VALUES (${actor.actorId}, ${'prop-1'}, ${task}, ${'why'}, ${0.5}, ${'[]'}, 1, ${'pending'})`;
    }
    expect(w.count('proposed_tasks')).toBe(2);

    const rtA = runtimeFor(w, w.a);
    const rtB = runtimeFor(w, w.b);
    expect(listProposedTasks(rtA).map((p) => p.task)).toEqual(['from-a']);
    expect(listProposedTasks(rtB).map((p) => p.task)).toEqual(['from-b']);

    updateProposedTaskStatus(rtA, 'prop-1', 'completed');
    expect(listProposedTasks(rtA, 'completed')).toHaveLength(1);
    expect(listProposedTasks(rtB, 'completed')).toHaveLength(0);
    expect(listProposedTasks(rtB, 'pending')).toHaveLength(1);
    w.close();
  });
});

// ── prompting/section-store.ts ───────────────────────────────────

describe('two actors, one database: prompt_section_versions and prompt_section_evaluations', () => {
  test('one section id carries a different promoted source per actor', () => {
    const w = world();
    initPromptSectionTables(w.execRaw);
    const section = PROMPT_SECTIONS[0];
    if (section === undefined) throw new Error('the prompt-section registry is empty');

    for (const [actor, source, status] of [
      [w.a, 'a-source', 'current'], [w.b, 'b-source', 'pending'],
    ] as const) {
      void w.sql`INSERT INTO prompt_section_versions
          (actor_id, section_id, version, source, rationale, status, incumbent_bytes, written_at)
        VALUES (${actor.actorId}, ${section.id}, 1, ${source}, ${'because'}, ${status}, 10, 1)`;
    }
    expect(w.count('prompt_section_versions')).toBe(2);

    expect(activePromptSectionOverrides(w.sql, w.a)[section.id]).toBe('a-source');
    expect(activePromptSectionOverrides(w.sql, w.b)[section.id]).toBeUndefined();
    expect(incumbentSectionSource(w.sql, w.a, section)).toBe('a-source');
    expect(incumbentSectionSource(w.sql, w.b, section)).toBe(section.source);
    expect(firstPendingPromptSection(w.sql, w.a)).toBeNull();
    expect(firstPendingPromptSection(w.sql, w.b)).toBe(section.id);
    expect(listPromptSectionVersions(w.sql, w.a)).toHaveLength(1);

    // Trials on the SAME section, version and instance.
    for (const [actor, winner] of [[w.a, 'pending'], [w.b, 'current']] as const) {
      recordPromptSectionTrial(w.sql, actor, {
        sectionId: section.id, pendingVersion: 1, instanceId: 'i1',
        currentScore: 0.4, pendingScore: 0.6, winner, feedback: 'f', now: 1,
      });
    }
    expect(w.count('prompt_section_evaluations')).toBe(2);
    const key = `${section.id}:1`;
    expect(promptSectionTrialRecord(w.sql, w.a).get(key)).toEqual({ wins: 1, losses: 0, ties: 0 });
    expect(promptSectionTrialRecord(w.sql, w.b).get(key)).toEqual({ wins: 0, losses: 1, ties: 0 });

    const pendingB = getPendingPromptSection(w.sql, w.b, section.id);
    if (pendingB === null) throw new Error('B has a pending candidate for this section');
    expect(pendingB.trialsSoFar).toBe(1);
    expect(getPendingPromptSection(w.sql, w.a, section.id)).toBeNull();

    applyPromptSectionDecision(w.sql, w.b, pendingB, 'rollback');
    // A's promoted row is untouched by B's rollback of the same (section, version).
    expect(activePromptSectionOverrides(w.sql, w.a)[section.id]).toBe('a-source');
    w.close();
  });
});

// ── mcts/takes.ts + mcts/schemas.ts ──────────────────────────────

describe('two actors, one database: alternate_takes and search_nodes', () => {
  test('one branch settlement key records a take set for each actor', () => {
    const w = world();
    initTurnOutcomeTables(w.execRaw);
    initAlternateTakesTable(w.execRaw);
    const input = {
      task: 'ship it', turnId: 'turn-1', sessionId: 'default',
      liveText: 'live', branchText: 'branch', now: 1, settlementKey: 'branch-1',
    };

    const setA = recordBranchTakeSet(w.sql, w.a, input);
    const setB = recordBranchTakeSet(w.sql, w.b, input);
    if (setA === null || setB === null) throw new Error('both actors record their own take set');
    expect(w.count('alternate_takes')).toBe(2);
    expect(listAlternateTakeSets(w.sql, w.a)).toHaveLength(1);
    expect(latestAlternateTakeSet(w.sql, w.b)?.id).toBe(setB.id);

    // A replay under the same key returns the row the first attempt wrote.
    expect(recordBranchTakeSet(w.sql, w.a, input)?.id).toBe(setA.id);
    expect(w.count('alternate_takes')).toBe(2);
    w.close();
  });

  test('an unclaimed purge and a claim each stop at the owner', () => {
    const w = world();
    initTurnOutcomeTables(w.execRaw);
    initAlternateTakesTable(w.execRaw);
    for (const [actor, mark] of [[w.a, 'a'], [w.b, 'b']] as const) {
      void w.sql`INSERT INTO alternate_takes
          (actor_id, id, turn_id, session_id, task, source, winner_node_id, chosen_node_id,
           candidates, created_at, picked_at)
        VALUES (${actor.actorId}, ${'take-1'}, ${null}, ${null}, ${mark}, ${'mcts'},
                ${'n-1'}, ${null}, ${'[]'}, 10, ${null})`;
    }
    expect(unclaimedAlternateTakeIds(w.sql, w.a)).toEqual(['take-1']);

    expect(claimAlternateTakesForTurn(w.sql, w.a, {
      turnId: 'turn-1', sessionId: 'default', startedAt: 5,
    })).toBe(1);
    expect(unclaimedAlternateTakeIds(w.sql, w.a)).toEqual([]);
    expect(unclaimedAlternateTakeIds(w.sql, w.b)).toEqual(['take-1']);

    purgeUnclaimedAlternateTakes(w.sql, w.b);
    expect(w.count('alternate_takes')).toBe(1);
    expect(listAlternateTakeSets(w.sql, w.a)).toHaveLength(1);
    w.close();
  });

  test('a pick re-points the picker\'s search nodes and not the sibling\'s', () => {
    const w = world();
    initTurnOutcomeTables(w.execRaw);
    initAlternateTakesTable(w.execRaw);
    initSearchTables(w.execRaw);
    // `recordTakePick` resolves the turn's conversation pair, so the transcript
    // table has to exist — the ledger row it writes quotes what was said.
    initActorTables(w.execRaw, w.sql);

    const candidates = JSON.stringify([
      { nodeId: 'n-1', text: 'winner', score: 0.6, visits: 2, depth: 1 },
      { nodeId: 'n-2', text: 'rival', score: 0.59, visits: 2, depth: 1 },
    ]);
    for (const actor of [w.a, w.b]) {
      for (const nodeId of ['n-1', 'n-2']) {
        void w.sql`INSERT INTO search_nodes
            (actor_id, id, parent_id, root_id, task, action, observation, visits, value, depth, status)
          VALUES (${actor.actorId}, ${nodeId}, ${null}, ${'root-1'}, ${'t'}, ${''}, ${''},
                  2, 0.6, 1, ${'terminal'})`;
      }
      void w.sql`INSERT INTO alternate_takes
          (actor_id, id, turn_id, session_id, task, source, winner_node_id, chosen_node_id,
           candidates, created_at, picked_at)
        VALUES (${actor.actorId}, ${'take-1'}, ${'turn-1'}, ${'default'}, ${'t'}, ${'mcts'},
                ${'n-1'}, ${null}, ${candidates}, 1, ${null})`;
    }
    expect(w.count('search_nodes')).toBe(4);

    const record = recordTakePick(w.sql, w.a, { takeId: 'take-1', nodeId: 'n-2', now: 2 });
    expect(record.changedAnswer).toBe(true);

    const status = (actor: ActorHandle, nodeId: string): string | undefined =>
      w.sql<{ status: string }>`SELECT status FROM search_nodes
        WHERE actor_id = ${actor.actorId} AND id = ${nodeId}`[0]?.status;
    expect(status(w.a, 'n-1')).toBe('pruned');
    expect(status(w.a, 'n-2')).toBe('terminal');
    // B's identically-named nodes never moved.
    expect(status(w.b, 'n-1')).toBe('terminal');
    expect(status(w.b, 'n-2')).toBe('terminal');
    // And the ledger row the pick wrote is A's alone.
    expect(listTurnOutcomes(w.sql, w.a, { outcomes: ['corrected'] })).toHaveLength(1);
    expect(listTurnOutcomes(w.sql, w.b, { outcomes: ['corrected'] })).toHaveLength(0);
    w.close();
  });
});

// ── strategy/records.ts ──────────────────────────────────────────

describe('two actors, one database: exploration_records', () => {
  test('the same artifact under the same objective is a record per actor', () => {
    const w = world();
    initExplorationRecordsTable(w.execRaw);
    const identity = {
      metric: 'reward', unit: 'points', direction: 'maximise' as const,
      scale: 'linear' as const,
      verifierDigest: verifierDigestOf({ kind: 'ratio', spec: { name: 'r' } }, 'source'),
    };
    const write = {
      identity, descriptor: null, artifact: 'program-1', value: 1, detail: 'd',
      measured: null, preset: 'p', label: null, rootId: 'root-1', configDigest: 'cfg',
      depth: 1, branches: 1, floor: null, costUsd: null, costTokens: null, at: 1,
    };
    const open = { kind: 'open' as const };

    expect(recordExploration(w.sql, w.a, { publication: open, write }).kind).toBe('recorded');
    expect(recordExploration(w.sql, w.b, {
      publication: open, write: { ...write, value: 2, detail: 'from-b' },
    }).kind).toBe('recorded');
    expect(w.count('exploration_records')).toBe(2);

    const scope = { identity, floor: null, descriptor: null };
    expect(bestInCell(w.sql, w.a, scope)?.value).toBe(1);
    expect(bestInCell(w.sql, w.b, scope)?.value).toBe(2);
    expect(recordsFor(w.sql, w.a, scope)).toHaveLength(1);
    expect(describeObjective(w.sql, w.a, recordHandleOf(scope)).rows).toBe(1);
    expect(objectiveIdOf(identity)).toBe(recordHandleOf(scope).objectiveId);
    w.close();
  });
});

// ── strategy/swarm-resume.ts ─────────────────────────────────────

describe('two actors, one database: swarm_node_records', () => {
  test('one node id carries a different record for each actor', () => {
    const w = world();
    initSwarmNodeRecords(w.execRaw);
    const record = (conclusion: string): SwarmNodeRecord => ({
      outcome: { kind: 'incomplete', detail: 'the clock stopped it' },
      conclusion, aggregated: [], tokens: null,
    });
    recordSwarmNode(w.sql, w.a, { rootId: 'root-1', nodeId: 'n-1', record: record('a'), now: 1 });
    recordSwarmNode(w.sql, w.b, { rootId: 'root-1', nodeId: 'n-1', record: record('b'), now: 1 });
    expect(w.count('swarm_node_records')).toBe(2);

    expect(readSwarmNodeRecords(w.sql, w.a, 'root-1')).toHaveLength(1);
    expect(readSwarmNodeRecords(w.sql, w.b, 'root-1')).toHaveLength(1);

    markSwarmNodeMerged(w.sql, w.a, 'n-1', 9);
    const merged = (actor: ActorHandle): number | null => w.sql<{ merged_at: number | null }>`
      SELECT merged_at FROM swarm_node_records
      WHERE actor_id = ${actor.actorId} AND node_id = ${'n-1'}`[0]?.merged_at ?? null;
    expect(merged(w.a)).toBe(9);
    expect(merged(w.b)).toBeNull();
    w.close();
  });
});

// ── experience/imports.ts ────────────────────────────────────────

describe('two actors, one database: imported_experience', () => {
  test('both actors adopt the same library entry, and each settles only its own', () => {
    const w = world();
    initImportedExperienceTable(w.execRaw);
    const entry = {
      id: 'lib-1', kind: 'fact' as const, key: 'deploy_target',
      title: 'deploy target', evidence: 'used twice', sourceWorkspace: 'other',
      publishedAt: 1,
      payload: { kind: 'fact' as const, key: 'deploy_target', value: 'x.workers.dev', confidence: 0.9 },
    };

    const rtA = runtimeFor(w, w.a);
    const rtB = runtimeFor(w, w.b);
    expect(stageImport(rtA, entry, 1).ok).toBe(true);
    // The same library id: admitted for B too, because "already imported here"
    // is a question about THIS actor's adopted set.
    expect(stageImport(rtB, entry, 1).ok).toBe(true);
    expect(w.count('imported_experience')).toBe(2);
    // And a second attempt by the SAME actor is still refused.
    expect(stageImport(rtA, entry, 1).ok).toBe(false);

    bindPendingImports(w.sql, w.a, 'turn-1');
    expect(listImportedExperience(w.sql, w.a)[0]?.turnIds).toEqual(['turn-1']);
    expect(listImportedExperience(w.sql, w.b)[0]?.turnIds).toEqual([]);
    w.close();
  });
});

// ── mission-budget.ts ────────────────────────────────────────────

describe('two actors, one database: mission_budget', () => {
  test('one mission label is a separate cumulative ledger per actor', () => {
    const w = world();
    const a = new MissionBudgetLedger(w.sql, w.a, w.execRaw);
    const b = new MissionBudgetLedger(w.sql, w.b, w.execRaw);

    a.declare('nightly', { usd: 1 }, null, 1);
    b.declare('nightly', { usd: 1 }, null, 1);
    expect(w.count('mission_budget')).toBe(2);

    a.debit('nightly', { tokens: 100, usd: 0.5, blendedTokens: 0, calls: 1, spawns: 0 });
    expect(a.get('nightly')?.usd).toBe(0.5);
    expect(b.get('nightly')?.usd).toBe(0);

    a.markExhausted('nightly', 7);
    expect(a.get('nightly')?.exhaustedAt).toBe(7);
    expect(b.get('nightly')?.exhaustedAt).toBeNull();
    expect(listMissionSpend(w.sql, w.b).map((s) => s.spent.usd)).toEqual([0]);
    w.close();
  });
});

// ── subordinates ─────────────────────────────────────────────────

describe('two actors, one database: actor_subordinates', () => {
  test('two parents each hire a "reviewer" and neither can dismiss the other\'s', () => {
    const w = world();
    const a = new SubordinateRosterStore(w.exec, w.a);
    const b = new SubordinateRosterStore(w.exec, w.b);
    a.ensureSchema();
    b.ensureSchema();
    const entry = {
      name: 'reviewer', actorReference: null, birth: null, deleteRequested: false,
      createdBy: 'orchestrator' as const, status: 'idle' as const, currentTask: null,
      createdAt: 1, dismissedAt: null, lifetime: 'durable' as const, taskEventId: null,
    };

    a.create(entry);
    b.create(entry);
    expect(w.count('actor_subordinates')).toBe(2);

    a.assign('reviewer', 'review the diff');
    expect(a.get('reviewer')?.status).toBe('working');
    expect(b.get('reviewer')?.status).toBe('idle');

    a.dismiss('reviewer', 5);
    expect(a.list()).toHaveLength(0);
    expect(b.list().map((r) => r.name)).toEqual(['reviewer']);
    a.remove('reviewer');
    expect(w.count('actor_subordinates')).toBe(1);
    w.close();
  });
});

describe('two actors, one database: subordinate_identity', () => {
  test('the singleton row is per actor, not per database', () => {
    const w = world();
    const a = new SubordinateIdentityStore(w.exec, w.a);
    const b = new SubordinateIdentityStore(w.exec, w.b);
    a.ensureSchema();
    b.ensureSchema();

    a.seed({
      name: 'reviewer', mission: 'review', parentWorkspace: 'ws', ownerUserId: 'u',
      depth: 1, lifetime: 'durable',
    });
    b.seed({
      name: 'scout', mission: 'scout', parentWorkspace: 'ws', ownerUserId: 'u',
      depth: 2, lifetime: 'task',
    });
    expect(w.count('subordinate_identity')).toBe(2);
    expect(a.read()?.name).toBe('reviewer');
    expect(b.read()?.name).toBe('scout');
    expect(b.read()?.depth).toBe(2);
    w.close();
  });
});

// ── events/hub ───────────────────────────────────────────────────

describe('two actors, one database: agent_log', () => {
  test('one upstream dedupe key admits an event for EACH actor', () => {
    const w = world();
    initEventsHubTables(w.exec);
    const a = new EventLog(w.exec, w.a);
    const b = new EventLog(w.exec, w.b);
    const descriptor = {
      ingress: 'timer_alarm' as const,
      variant: 'timer' as const,
      payload: { trigger_id: 'trg-1', scheduled_fire_at: 1_000 },
      trigger_creator_trust: 'owner' as const,
    };

    const first = a.publish({ descriptor, now: 1_000 });
    const second = b.publish({ descriptor, now: 1_000 });
    // BOTH admitted. A table-wide unique dedupe index would have swallowed the
    // second actor's event as a duplicate of the first actor's row.
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(true);
    expect(first.id).not.toBe(second.id);
    expect(w.count('agent_log')).toBe(2);

    // Each drain sees only its own.
    expect(a.pending().map((e) => e.id)).toEqual([first.id]);
    expect(b.pending().map((e) => e.id)).toEqual([second.id]);
    expect(a.get(second.id)).toBeNull();
    expect(a.idForDedupeKey('timer:trg-1:1000')).toBe(first.id);
    expect(b.idForDedupeKey('timer:trg-1:1000')).toBe(second.id);

    // And a genuine replay WITHIN one actor is still deduped.
    expect(a.publish({ descriptor, now: 1_000 }).admitted).toBe(false);
    expect(w.count('agent_log')).toBe(2);

    a.markConsumed(first.id, 'evt-turn-1', 0, 2_000);
    expect(a.pending()).toHaveLength(0);
    expect(b.pending()).toHaveLength(1);
    expect(a.hasOpenDrainLease()).toBe(true);
    expect(b.hasOpenDrainLease()).toBe(false);
    w.close();
  });

  test('an audit row and its turn steps belong to the actor that appended them', () => {
    const w = world();
    initEventsHubTables(w.exec);
    const a = new EventLog(w.exec, w.a);
    const b = new EventLog(w.exec, w.b);
    for (const [log, mark] of [[a, 'a'], [b, 'b']] as const) {
      log.appendNonEventRow({
        kind: 'phase', turn_id: 'turn-1', step_idx: null, parent_id: null,
        trace_id: 'trace-1', payload: { phase: mark }, now: 1,
      });
      log.appendNonEventRow({
        kind: 'step', turn_id: 'turn-1', step_idx: 0, parent_id: null,
        trace_id: 'trace-1', payload: { text: mark }, now: 2,
      });
    }
    expect(w.count('agent_log')).toBe(4);
    expect(a.currentPhase('turn-1')?.phase).toBe('a');
    expect(b.currentPhase('turn-1')?.phase).toBe('b');
    expect(a.turnSteps('turn-1')).toHaveLength(1);
    expect(b.turnSteps('turn-1')).toHaveLength(1);
    w.close();
  });
});

describe('two actors, one database: reply_channels', () => {
  test('one event id opens a channel per actor and one abort closes one of them', () => {
    const w = world();
    initEventsHubTables(w.exec);
    const a = new ReplyChannelStore(w.exec, w.a);
    const b = new ReplyChannelStore(w.exec, w.b);
    const opts = {
      event_id: 'evt-1', kind: 'peer_back' as const, holder_addr: 'peer',
      payload_policy: 'full' as const,
    };

    const idA = a.open(opts, 1_000);
    const idB = b.open(opts, 1_000);
    if (idA === null || idB === null) throw new Error('a peer_back channel is always persisted');
    expect(w.count('reply_channels')).toBe(2);

    expect(a.findOpenByEvent('evt-1')?.id).toBe(idA);
    expect(b.findOpenByEvent('evt-1')?.id).toBe(idB);
    expect(a.get(idB)).toBeNull();

    a.abort(idA, 2_000, 'socket closed');
    expect(a.findOpenByEvent('evt-1')).toBeNull();
    expect(b.findOpenByEvent('evt-1')?.id).toBe(idB);
    w.close();
  });
});

describe('two actors, one database: triggers', () => {
  test('pausing one actor\'s triggers leaves the other actor\'s firing', async () => {
    const w = world();
    initEventsHubTables(w.exec);
    const alarm = { scheduleAt: async () => {} };
    const a = new TriggerRegistry(w.exec, w.a, alarm);
    const b = new TriggerRegistry(w.exec, w.b, alarm);
    const spec = {
      kind: 'timer_cron' as const, spec: { cron: '0 * * * *' },
      creator_trust: 'owner' as const, next_fire_at: 1_000,
    };

    await a.register(spec, 1);
    await b.register(spec, 1);
    expect(w.count('triggers')).toBe(2);
    expect(a.due(2_000)).toHaveLength(1);
    expect(b.due(2_000)).toHaveLength(1);

    expect(a.pauseAll(5)).toBe(1);
    expect(a.due(2_000)).toHaveLength(0);
    expect(b.due(2_000)).toHaveLength(1);

    expect(b.revokeAll(6)).toBe(1);
    expect(a.list({ state: 'paused' })).toHaveLength(1);
    expect(b.list({ state: 'revoked' })).toHaveLength(1);
    w.close();
  });
});

// ── read-models/workspace-diff.ts ────────────────────────────────

describe('two actors, one database: vfs_baseline', () => {
  test('one actor re-baselining does not deactivate the other\'s generation', async () => {
    const w = world();
    initWorkspaceBaselineTable(w.execRaw);
    // An EMPTY plane on purpose: what this proves is that the generation FLIP is
    // per owner, and the flip is a single statement over the whole table. A file
    // would add rows to both actors' snapshots and change nothing about it.
    const vfs = createMemoryVfs().vfs;
    const rtA = runtimeFor(w, w.a, vfs);
    const rtB = runtimeFor(w, w.b, vfs);

    await resetWorkspaceBaseline(rtA);
    const activeA = w.sql<{ generation: string }>`SELECT generation FROM vfs_baseline
      WHERE actor_id = ${w.a.actorId} AND active = 1 LIMIT 1`[0]?.generation;
    if (activeA === undefined) throw new Error('A captured a baseline generation');

    // B captures its own baseline. Without the owner on the flip, this would
    // have deactivated A's rows and A's next diff would report the whole
    // workspace as newly added.
    await resetWorkspaceBaseline(rtB);
    const stillActiveA = w.sql<{ generation: string }>`SELECT generation FROM vfs_baseline
      WHERE actor_id = ${w.a.actorId} AND active = 1 LIMIT 1`[0]?.generation;
    expect(stillActiveA).toBe(activeA);

    expect((await getWorkspaceDiff(rtA)).files).toHaveLength(0);
    expect((await getWorkspaceDiff(rtB)).files).toHaveLength(0);
    w.close();
  });
});

// ── the refusal ──────────────────────────────────────────────────

describe('a handle whose validation throws is refused before the statement runs', () => {
  test('every bound store refuses, and the table is unchanged', () => {
    const w = world();
    initTurnOutcomeTables(w.execRaw);
    initCompletedTurnTable(w.execRaw);
    initEffectTombstoneTable(w.execRaw);
    initToolEffectClaimTable(w.execRaw);
    initDeferredApprovalsTable(w.execRaw);
    initInstructionApprovalsTable(w.execRaw);
    initPlanReviewTable(w.execRaw);
    initRefinementTables(w.execRaw);
    initGepaTables(w.execRaw);
    initExplorationRecordsTable(w.execRaw);
    initSwarmNodeRecords(w.execRaw);
    initEventsHubTables(w.exec);

    const window = createCompletedTurnStore(w.sql, w.revocable);
    const approvals = new DeferredApprovalStore(w.sql, w.revocable);
    const plans = new PlanReviewStore(w.sql, w.revocable, { newId: () => 'plan-1', now: () => 1 });
    const refinements = createRefinementStore(w.sql, w.revocable);
    const events = new EventLog(w.exec, w.revocable);
    const channels = new ReplyChannelStore(w.exec, w.revocable);

    // Revoked AFTER construction: the store exists, and it is the per-statement
    // check that refuses — not a failure to build one.
    w.revoke();

    // `() => void`, not `() => unknown`: each attempt's contract is the write
    // it tries, never a value — the loop below only asserts that it throws.
    const attempts: ReadonlyArray<readonly [string, () => void]> = [
      ['turn_outcomes', () => recordTurnOutcome(w.sql, w.revocable, {
        turnId: 't', outcome: 'accepted', confidence: 1, source: 'explicit',
        userMessage: 'u', assistantResponse: 'a',
      })],
      ['lessons', () => recordLesson(w.sql, w.revocable, {
        turnIds: [], text: 'x', source: 'import', status: 'provisional',
      })],
      ['outcome_labels', () => recordOutcomeLabels(w.sql, w.revocable, {
        labeler: 'x', labels: [{ outcomeId: 'o', label: 'accepted' }],
      })],
      ['outcome_ensemble_labels', () => recordEnsembleLabels(w.sql, w.revocable, {
        model: 'm', labels: [{ outcomeId: 'o', label: 'accepted' }],
      })],
      ['completed_turns', () => window.append({
        userMessage: 'u', assistantResponse: 'a', toolCalls: [], steps: 1,
        durationMs: 1, feedback: null, hadError: false,
      }, { awaitsFollowup: false, id: 'row-1', now: 1 })],
      ['effect_tombstones', () => recordEffectDone(w.sql, w.revocable, 's', 'k')],
      ['tool_effect_claims', () => claimToolEffect(w.sql, w.revocable, {
        turnId: 't', callId: 'c', digest: 'd',
      })],
      ['deferred_approvals', () => approvals.create({
        id: 'appr-1', command: 'c', executor: 'e', reason: 'r', requestedAt: 1,
      })],
      ['instruction_approvals', () => new InstructionApprovalStore(
        w.sql, w.revocable, 'scope',
      ).approve('SKILL.md', 'digest')],
      ['plan_reviews', () => plans.submit('default', [{ start: 1, content: 'plan' }])],
      ['refinement_requests', () => refinements.open({
        trigger: 'explicit', scope: 'workspace', turnIds: [], now: 1,
      })],
      ['gepa_runs', () => startGepaRun(w.sql, w.revocable, { target: 'scaffold' })],
      ['exploration_records', () => recordExploration(w.sql, w.revocable, {
        publication: { kind: 'open' },
        write: {
          identity: {
            metric: 'm', unit: 'u', direction: 'maximise', scale: 'linear',
            verifierDigest: 'v',
          },
          descriptor: null, artifact: 'x', value: 1, detail: 'd', measured: null,
          preset: 'p', label: null, rootId: 'r', configDigest: 'c', depth: 1,
          branches: 1, floor: null, costUsd: null, costTokens: null, at: 1,
        },
      })],
      ['swarm_node_records', () => recordSwarmNode(w.sql, w.revocable, {
        rootId: 'r', nodeId: 'n',
        record: {
          outcome: { kind: 'incomplete', detail: 'cut' },
          conclusion: null, aggregated: [], tokens: null,
        },
        now: 1,
      })],
      ['agent_log', () => events.publish({
        descriptor: {
          ingress: 'timer_alarm', variant: 'timer',
          payload: { trigger_id: 'trg-1', scheduled_fire_at: 1 },
          trigger_creator_trust: 'owner',
        },
        now: 1,
      })],
      ['reply_channels', () => channels.open({
        event_id: 'evt-1', kind: 'peer_back', holder_addr: 'p', payload_policy: 'full',
      }, 1)],
    ];

    for (const [table, attempt] of attempts) {
      const before = w.count(table);
      expect(attempt).toThrow();
      expect(w.count(table)).toBe(before);
    }
    w.close();
  });
});
