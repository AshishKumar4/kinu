// The quality curve: a scaffold promotion makes one point for the promoted version, scored by the same rollout, criterion
// and judge GEPA uses. A version GEPA proposed keeps GEPA's held-out score; a failed scoring is a point with its reason.
// Real promotion, GEPA and drain over a real ledger; the model, rollouts and judge are scripted and counted.
import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import type { ChatEvent } from '../src/chat';
import {
  applyScaffoldDecision, getPendingScaffold, listScaffoldScores, modifyScaffold, recordTurnOutcome,
  runDueScaffoldEvaluations, runScaffoldGepaOptimization, type ScaffoldControl,
} from '../src/index';
import type { AgentRuntime } from '../src/types/agent-runtime';
import { createEvalExecutor, createTestRuntime, storesFor } from './helpers';
import { RunEventRecorder } from '../src/events/recorder';
import { unpricedLedgerSink } from '../src/events/model-call-event';

const SEED_SCAFFOLD = `async function* run(rt, task) {
  await host.defaultInference();
}`;

const CANDIDATE_SCAFFOLD = `async function* run(rt, task) {
  await host.defaultInference();
  await host.emit({ type: 'text_delta', text: 'and here is the correction you asked for' });
}`;

const RATIONALE = 'Answer the correction the user asked for after the default reply, which the ledger keeps missing.';

interface CountedControl {
  readonly control: ScaffoldControl;
  readonly rollouts: () => number;
  readonly verdicts: () => number;
}

/** The judge favours the candidate's correction; `judge` replaces it when a test needs it to fail. */
function countedControl(rt: AgentRuntime, judge?: ScaffoldControl['judge']): CountedControl {
  let rollouts = 0;
  let verdicts = 0;
  const events = new RunEventRecorder(rt.storage.sql, rt.actor);

  const control: ScaffoldControl = {
    rt,
    events,
    reportModelCall: unpricedLedgerSink(events),
    sql: rt.storage.sql,
    history: storesFor(rt).history,
    config: { getShadowSampleRate: () => 1, getAutoPromoteScaffold: () => false, getGepaEvalBudget: () => 8 },
    surface: () => {
      rollouts++;

      return {
        llmStream: async function* () { yield { type: 'text-delta', delta: '' } satisfies ChatEvent; },
        defaultInference: async function* () { yield { value: { type: 'text-delta', delta: 'an answer' } }; },
      };
    },
    model: () => new MockLanguageModelV3({
      provider: 'fake',
      modelId: 'fake-reflection',
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: CANDIDATE_SCAFFOLD }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 7, text: 7, reasoning: undefined },
        },
        warnings: [],
      }),
    }),
    judge: async (request) => {
      verdicts++;

      if (judge !== undefined) return judge(request);
      const corrected = request.prompt.includes('the correction you asked for');

      return v.parse(request.schema, { score: corrected ? 0.9 : 0.1, feedback: corrected ? 'addressed it' : 'missed it' });
    },
  };

  return { control, rollouts: () => rollouts, verdicts: () => verdicts };
}

async function ledgeredRuntime(): Promise<AgentRuntime> {
  const { rt } = createTestRuntime();
  rt.executor = createEvalExecutor();
  await rt.identity.scaffold.write(SEED_SCAFFOLD);

  for (let i = 0; i < 3; i++) {
    recordTurnOutcome(rt.storage.sql, rt.actor, {
      turnId: `bad-${i}`, outcome: 'corrected', confidence: 1, source: 'classifier',
      userMessage: `failure #${i}: the summary skipped the conclusions`, assistantResponse: 'the wrong summary',
      followup: 'no, summarise the conclusions', now: 1_000 + i,
    });
  }

  for (let i = 0; i < 2; i++) {
    recordTurnOutcome(rt.storage.sql, rt.actor, {
      turnId: `ok-${i}`, outcome: 'accepted', confidence: 1, source: 'classifier',
      userMessage: `guard #${i}: list the files under docs`, assistantResponse: 'a.txt, b.txt', now: 2_000 + i,
    });
  }

  return rt;
}

async function promoted(control: ScaffoldControl): Promise<number> {
  const decided = await applyScaffoldDecision(control, 'promote');

  if (!decided.ok) throw new Error(`promotion refused: ${decided.error}`);
  expect(decided.action).toBe('promote');

  return decided.newCurrentVersion;
}

describe('the quality curve', () => {
  test('a promotion makes one point for the promoted version, replayed once', async () => {
    const rt = await ledgeredRuntime();
    const counted = countedControl(rt);
    const proposed = await modifyScaffold(rt, RATIONALE, CANDIDATE_SCAFFOLD);
    expect(proposed.ok).toBe(true);
    const version = await promoted(counted.control);

    await runDueScaffoldEvaluations(counted.control);
    const replayed = counted.rollouts();
    await runDueScaffoldEvaluations(counted.control);

    const [point, ...rest] = listScaffoldScores(rt.storage.sql, rt.actor);
    expect(rest).toEqual([]);
    expect(point).toMatchObject({ version, source: 'replay', failure: null, direction: 'reached' });
    expect(point?.interval?.n).toBe(5);
    expect(point?.interval?.mean).toBeCloseTo(0.9, 5);
    expect({ replayed, after: counted.rollouts(), verdicts: counted.verdicts() }).toEqual({ replayed: 5, after: 5, verdicts: 5 });
  });

  test('a version GEPA proposed keeps the held-out score GEPA measured, with no new rollout', async () => {
    const rt = await ledgeredRuntime();
    const counted = countedControl(rt);
    const gepa = await runScaffoldGepaOptimization(counted.control, { maxIterations: 1, evalSize: 8, maxMetricCalls: 200 });
    expect(gepa).toMatchObject({ ok: true, proposed: true });
    expect(getPendingScaffold(rt.storage.sql, rt.actor)?.version).toBe(gepa.pendingVersion ?? -1);

    const version = await promoted(counted.control);
    const before = { rollouts: counted.rollouts(), verdicts: counted.verdicts() };
    await runDueScaffoldEvaluations(counted.control);

    expect({ rollouts: counted.rollouts(), verdicts: counted.verdicts() }).toEqual(before);
    const [point] = listScaffoldScores(rt.storage.sql, rt.actor);
    expect(point).toMatchObject({ version, source: 'gepa', interval: gepa.bestScore });
  });

  test('a scoring that fails is a point with its reason, never run again', async () => {
    const rt = await ledgeredRuntime();

    const counted = countedControl(rt, async () => {
      throw new Error('the judge model is not configured');
    });

    await modifyScaffold(rt, RATIONALE, CANDIDATE_SCAFFOLD);
    const version = await promoted(counted.control);

    await runDueScaffoldEvaluations(counted.control);
    const judged = counted.verdicts();
    await runDueScaffoldEvaluations(counted.control);

    const [point, ...rest] = listScaffoldScores(rt.storage.sql, rt.actor);
    expect(rest).toEqual([]);
    expect(point).toMatchObject({ version, interval: null, direction: null });
    expect(point?.failure).toContain('the judge model is not configured');
    expect({ judged, after: counted.verdicts() }).toEqual({ judged: 1, after: 1 });
  });
});
