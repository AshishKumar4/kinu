/**
 * A HEADLESS actor learns on the step clock and on nothing else.
 *
 * A head, a swarm node and a hosted subordinate all run `runHeadInference` over
 * a hosted actor whose engine is ENABLED — that is how both backends host them.
 * The loop registers the orchestrator's turn extension, so the in-episode
 * clock ticks (crafted-tool fitness, execution recoveries), and it records no
 * turn into the evolution window, so the turn review, the session reflection
 * and the lifetime pass are never entered. This suite is the guard on that
 * decision: the first test would fail the day the loop, or the session under
 * it, starts recording a headless turn.
 *
 * The negative half is checked against a POSITIVE CONTROL on the very same
 * turn: handed to the actor's own `recordTurn` — what a full actor's
 * `turn_record` effect does — that turn is graded `corrected` by the execution
 * verdict and reflected into a lesson. So the assertion is not "the engine was
 * off" or "the turn carried nothing to learn from"; it is that the headless
 * loop declines to enter the channel a full actor would.
 */
import { describe, expect, test } from 'bun:test';
import { createTestRuntime, scriptedTurnModel } from '@kinu.run/test-utils';
import type { LanguageModel } from 'ai';
import { jsonSchema, tool } from 'ai';
import { hostedSeatsOver } from './helpers-actor-host';
import { runHeadInference, HeadCapture } from '../src/heads/head-inference';
import type { HeadInput } from '../src/heads/types';
import { defaultLoopOrigin } from '../src/scaffold/bootstrap';
import { executionVerdict, listLessons, listTurnOutcomes } from '../src/evolution/outcomes';
import { listRecoveryFindings } from '../src/evolution/recovery';
import { snapshotCompletedTurn } from '../src/orchestrator/turn-lifecycle';
import { CONSECUTIVE_FAILURES_BEFORE_STEER } from '../src/orchestrator/turn-steering';
import type { LLM } from '../src/types/primitives';
import type { SqlExecutor } from '../src/types/primitives';

const REFLECTION_PROMPT = 'should be done differently';

function headInput(): HeadInput {
  return {
    id: 'h1', rootId: 'r1', parentId: null, depth: 0,
    task: 'probe the parser', rationale: 'cover the lexer angle',
    mode: 'build',
    inheritedContext: [{ id: 'm1', role: 'user', content: 'the prior user message', createdAt: 1 }],
    budget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: 2_000_000_000_000 },
    mergeStrategy: 'synthesize',
    loop: defaultLoopOrigin('head'),
  };
}

/** The reflection model call, counted: the one call turn-level learning spends. */
function reflectingLlm() {
  let reflections = 0;

  const llm: LLM = {
    async *stream() { yield ''; },
    async complete(prompt) {
      if (!prompt.includes(REFLECTION_PROMPT)) return '';
      reflections += 1;

      return 'When a probe call throws, change its arguments before calling it again.';
    },
  };

  return { llm, reflections: () => reflections };
}

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 7, text: 7, reasoning: undefined },
};

/** `calls` probe invocations, each with its own arguments, then one closing
 *  text step. */
function probingHead(calls: number): LanguageModel {
  let step = 0;

  return scriptedTurnModel({ doGenerate: async () => {
    const index = step++;

    if (index < calls) return {
      content: [{ type: 'tool-call', toolCallId: `probe-${String(index)}`, toolName: 'probe', input: JSON.stringify({ n: index }) }],
      finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [],
    };

    return {
      content: [{ type: 'text', text: 'the probe never settled' }],
      finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [],
    };
  } });
}

const PROBE_SCHEMA = jsonSchema<{ n: number }>({ type: 'object', properties: { n: { type: 'number' } }, required: ['n'] });

function windowRows(sql: SqlExecutor, actorId: string): number {
  return sql<{ n: number }>`SELECT COUNT(*) AS n FROM completed_turns WHERE actor_id = ${actorId}`[0]?.n ?? 0;
}

describe('a headless actor runs the step clock only', () => {
  test('a head turn ending in a failed acting call enters no conversational timescale; the same turn recorded by a full actor does', async () => {
    const { llm, reflections } = reflectingLlm();
    const { rt, testSql } = createTestRuntime({ llm });
    const seats = hostedSeatsOver({ rt, db: testSql.db, autoEvolve: true });
    const seat = await seats.seat('head-under-test', 'head');
    const actor = seat.actor.handle;
    const capture = new HeadCapture();

    const report = await runHeadInference(headInput(), {
      actor: seat.actor, runId: seat.runId, profile: seat.profile, dynamic: seat.dynamic,
      model: probingHead(1),
      tools: { probe: tool({ inputSchema: PROBE_SCHEMA, execute: async (): Promise<{ ok: boolean }> => { throw new Error('probe exploded'); } }) },
      capture, isAborted: () => false, workspaceLayout: 'shared-workspace',
    });

    expect(report.status).toBe('completed');

    // The evidence the root's own headless channel grades on IS on this turn:
    // its last acting call failed, which `executionVerdict` reads as `failed`.
    const acc = seat.actor.session.orchestrator.acc;
    expect(executionVerdict({ hadError: acc.hadError, toolCalls: acc.toolCalls })).toBe('failed');

    // And none of it reached the conversational ledgers, nor cost a model call.
    expect(windowRows(rt.storage.sql, actor.actorId)).toBe(0);
    expect(listTurnOutcomes(rt.storage.sql, actor)).toHaveLength(0);
    expect(listLessons(rt.storage.sql, actor)).toHaveLength(0);
    expect(reflections()).toBe(0);

    // CONTROL. The same turn, recorded as a full actor's `turn_record` effect
    // records it, is graded by the execution verdict and reflected into a
    // provisional lesson — so the zeros above are the loop's decision, not an
    // engine that was off or a turn with nothing to learn from.
    const turn = snapshotCompletedTurn(acc, {
      userMessage: 'probe the parser', assistantResponse: report.summary,
      turnId: 'h1', sessionId: 'default', origin: 'programmatic',
    });

    seat.actor.session.orchestrator.recordTurn(turn, 'conversation');
    await seat.actor.session.orchestrator.settleEvolution();
    expect(windowRows(rt.storage.sql, actor.actorId)).toBe(1);
    expect(listTurnOutcomes(rt.storage.sql, actor).map((row) => [row.outcome, row.source]))
      .toEqual([['corrected', 'execution']]);
    expect(listLessons(rt.storage.sql, actor).map((lesson) => [lesson.source, lesson.status]))
      .toEqual([['turn_reflection', 'provisional']]);
    expect(reflections()).toBe(1);
  });

  test('the step clock ticks for a head, under its own actor, and its rows go with it at retirement', async () => {
    const { llm, reflections } = reflectingLlm();
    const { rt, testSql } = createTestRuntime({ llm });
    const seats = hostedSeatsOver({ rt, db: testSql.db, autoEvolve: true });
    const seat = await seats.seat('recovering-head', 'head');
    const actor = seat.actor.handle;

    // A steer-worthy failure streak broken by a CHANGED call that ran clean —
    // the execution recovery the step clock records mid-episode.
    const failing = CONSECUTIVE_FAILURES_BEFORE_STEER;

    const report = await runHeadInference(headInput(), {
      actor: seat.actor, runId: seat.runId, profile: seat.profile, dynamic: seat.dynamic,
      model: probingHead(failing + 1),
      tools: { probe: tool({ inputSchema: PROBE_SCHEMA, execute: async ({ n }) => {
        if (n < failing) throw new Error(`probe ${String(n)} exploded`);

        return { ok: true };
      } }) },
      capture: new HeadCapture(), isAborted: () => false, workspaceLayout: 'shared-workspace',
    });

    expect(report.status).toBe('completed');

    const findings = listRecoveryFindings(rt.storage.sql, actor);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('probe');
    expect(listLessons(rt.storage.sql, actor).map((lesson) => lesson.source)).toEqual(['execution_recovery']);
    // Under the head's OWN actor id: the root holds none of it.
    expect(listLessons(rt.storage.sql, rt.actor)).toHaveLength(0);
    // Still no conversational timescale: a clean ending is not an outcome row
    // either, and no reflection was asked for.
    expect(listTurnOutcomes(rt.storage.sql, actor)).toHaveLength(0);
    expect(reflections()).toBe(0);

    // Retirement is where a head's rows go. `keepHistory: false` is what every
    // exploration retirement passes, and the purge walks every actor-scoped
    // table — the lessons ledger included.
    const main = seats.directory.main();
    await seats.host.retire(
      { actorId: main.actorId, workspaceId: main.workspaceId, parentActorId: main.parentActorId },
      { reference: seat.actor.reference, name: seat.actor.record.name, destroy: true },
    );
    expect(rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM lessons WHERE actor_id = ${actor.actorId}`[0]?.n).toBe(0);
  });
});
