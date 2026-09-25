/** A headless actor learns only on the step clock; a positive control on the same turn shows the root would learn from it. */
import { REAL_CLOCK } from '../src/types/clock';
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
import { actorReferenceOf } from '../src/identity/actor-handle';
import { ADVISOR_HEADER, type AdvisorSeverity } from '../src/advisor/review';

const REFLECTION_PROMPT = 'should be done differently';

function headInput(): HeadInput {
  return {
    id: 'h1', rootId: 'r1', parentId: null, depth: 0,
    task: 'probe the parser', rationale: 'cover the lexer angle',
    mode: 'build',
    inheritedContext: [{ id: 'm1', role: 'user', content: 'the prior user message', createdAt: 1 }],
    budget: { maxDepth: 2, spawnedAt: 2_000_000_000_000 },
    mergeStrategy: 'synthesize',
    loop: defaultLoopOrigin('head'),
  };
}

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
  const severities: readonly AdvisorSeverity[] = ['nit', 'concern', 'blocker'];

  for (const severity of severities) {
    test(`${severity} advice reaches its actor; only blockers reach its parent`, async () => {
      const { rt, testSql } = createTestRuntime();
      rt.actor.config.setAdvisorEnabled(true);
      rt.actor.config.setAdvisorMinSeverity('nit');
      const prompts: string[] = [];
      const note = 'The failing parser probe was reported as successful. Check its exit status.';
      rt.advisorLlm = {
        async *stream() { yield ''; },
        complete: async (prompt) => {
          prompts.push(prompt);

          return JSON.stringify({ note, severity, class: 'wrong-work' });
        },
      };
      await rt.storage.vfs.writeFile('ADVISOR.md', 'Watch parser outcomes.');
      const seats = hostedSeatsOver({ rt, db: testSql.db, autoEvolve: true });
      const requests: string[] = [];

      const model = scriptedTurnModel({
        doGenerate: async (options) => {
          requests.push(JSON.stringify(options.prompt));

          return {
            content: [{ type: 'text', text: 'The parser probe succeeded.' }],
            finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [],
          };
        },
      });

      for (const name of ['one', 'two']) {
        const seat = await seats.seat(name, 'subordinate');
        const before = windowRows(rt.storage.sql, rt.actor.actorId);

        const report = await runHeadInference(headInput(), {
          actor: seat.actor, runId: seat.runId, profile: seat.profile, dynamic: seat.dynamic,
          model, tools: {}, capture: new HeadCapture(), clock: REAL_CLOCK, isAborted: () => false,
          workspaceLayout: 'shared-workspace',
        });

        expect(report.status).toBe('completed');
        expect(windowRows(rt.storage.sql, seat.actor.handle.actorId)).toBe(0);
        expect(windowRows(rt.storage.sql, rt.actor.actorId)).toBe(before);

        const notes = rt.storage.sql<{ message: string }>`SELECT message FROM evolution_events
          WHERE actor_id = ${seat.actor.handle.actorId} AND type = 'advisor_note'`;

        expect(notes).toEqual([{ message: note }]);
      }

      expect(requests).toHaveLength(4);
      expect(requests[1]).toContain(ADVISOR_HEADER);
      expect(requests[3]).toContain(note);
      expect(prompts).toHaveLength(4);
      expect(prompts.every((prompt) => prompt.includes('Watch parser outcomes.'))).toBe(true);
      const parentAdvice = seats.enqueued.filter((turn) => turn.metadata?.kinuEvent === 'advisor');
      expect(parentAdvice).toHaveLength(severity === 'blocker' ? 2 : 0);

      if (severity === 'blocker') {
        expect(parentAdvice.map((turn) => turn.idempotencyKey)).toHaveLength(2);
        expect(new Set(parentAdvice.map((turn) => turn.idempotencyKey)).size).toBe(2);
        expect(parentAdvice[0]?.text).toContain('[Actor one]');
      }
    });
  }

  test('a head turn enters no conversational timescale; the same evidence recorded by the root does', async () => {
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
      capture, clock: REAL_CLOCK, isAborted: () => false, workspaceLayout: 'shared-workspace',
    });

    expect(report.status).toBe('completed');

    const acc = seat.actor.session.orchestrator.acc;
    expect(executionVerdict({ hadError: acc.hadError, toolCalls: acc.toolCalls })).toBe('failed');

    expect(windowRows(rt.storage.sql, actor.actorId)).toBe(0);
    expect(listTurnOutcomes(rt.storage.sql, actor)).toHaveLength(0);
    expect(listLessons(rt.storage.sql, actor)).toHaveLength(0);
    expect(reflections()).toBe(0);

    // Control: the same turn recorded as `turn_record` does yield a lesson, so the zeros above are the loop's decision.
    const turn = snapshotCompletedTurn(acc, {
      userMessage: 'probe the parser', assistantResponse: report.summary,
      turnId: 'h1', sessionId: 'default', origin: 'programmatic',
    });

    const root = await seats.host.acquire(actorReferenceOf(rt.actor));
    root.session.orchestrator.recordTurn(turn, 'conversation');
    await root.session.orchestrator.settleEvolution();
    expect(windowRows(rt.storage.sql, actor.actorId)).toBe(0);
    expect(windowRows(rt.storage.sql, root.handle.actorId)).toBe(1);
    expect(listTurnOutcomes(rt.storage.sql, root.handle).map((row) => [row.outcome, row.source]))
      .toEqual([['corrected', 'execution']]);
    expect(listLessons(rt.storage.sql, root.handle).map((lesson) => [lesson.source, lesson.status]))
      .toEqual([['turn_reflection', 'provisional']]);
    expect(reflections()).toBe(1);
  });

  test('the step clock ticks for a head, under its own actor, and its rows go with it at retirement', async () => {
    const { llm, reflections } = reflectingLlm();
    const { rt, testSql } = createTestRuntime({ llm });
    const seats = hostedSeatsOver({ rt, db: testSql.db, autoEvolve: true });
    const seat = await seats.seat('recovering-head', 'head');
    const actor = seat.actor.handle;

    const failing = CONSECUTIVE_FAILURES_BEFORE_STEER;

    const report = await runHeadInference(headInput(), {
      actor: seat.actor, runId: seat.runId, profile: seat.profile, dynamic: seat.dynamic,
      model: probingHead(failing + 1),
      tools: { probe: tool({ inputSchema: PROBE_SCHEMA, execute: async ({ n }) => {
        if (n < failing) throw new Error(`probe ${String(n)} exploded`);

        return { ok: true };
      } }) },
      capture: new HeadCapture(), clock: REAL_CLOCK, isAborted: () => false, workspaceLayout: 'shared-workspace',
    });

    expect(report.status).toBe('completed');

    const findings = listRecoveryFindings(rt.storage.sql, actor);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('probe');
    expect(listLessons(rt.storage.sql, actor).map((lesson) => lesson.source)).toEqual(['execution_recovery']);
    expect(listLessons(rt.storage.sql, rt.actor)).toHaveLength(0);
    expect(listTurnOutcomes(rt.storage.sql, actor)).toHaveLength(0);
    expect(reflections()).toBe(0);

    // `keepHistory: false` purges every actor-scoped table, the lessons ledger included.
    const main = seats.directory.main();
    await seats.host.retire(
      { actorId: main.actorId, workspaceId: main.workspaceId, parentActorId: main.parentActorId },
      { reference: seat.actor.reference, name: seat.actor.record.name, destroy: true, interrupt: true },
    );
    expect(rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM lessons WHERE actor_id = ${actor.actorId}`[0]?.n).toBe(0);
  });
});
