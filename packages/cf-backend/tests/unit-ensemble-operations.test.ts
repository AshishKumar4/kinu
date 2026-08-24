/**
 * The outcome-ensemble judges' operation lifecycle, end to end through the
 * real OrchestratorAgent.
 *
 * `runOutcomeEnsemble` wires each judge's completion LLM with BOTH sinks —
 * the cost report and the operation lifecycle. This proves the second lands:
 * every judge call writes a durable start/end pair joined by operationId into
 * the workspace log, beside the `model_call` row that was always there.
 */

import { describe, expect, test } from 'bun:test';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import {
  createProviderRegistry,
  recordOutcomeLabels,
  recordTurnOutcome,
  RunEventRecorder,
  WORKSPACE_RUN_ID,
  type RunEvent,
} from '@kinu.run/core';
import { sqlOver } from '@kinu.run/test-utils';
import { orchestratorHarness } from './helpers/actor-harness';
import type { AgentProviderRegistry } from '../src/providers/agent-registry';

/** A scripted judge model: answers a valid verdict, reports real usage. */
function judgeModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: '{"verdict":"accepted"}' }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 41, noCache: 41, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 7, text: 7, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

/** A registry whose fake-family specs resolve to scripted judges. Only
 *  resolveModel + normalizeSpecSync are reached on this path: explicit specs
 *  skip candidate surveying entirely. */
function judgeRegistry(
  models: ReadonlyArray<readonly [spec: string, model: LanguageModel]>,
): AgentProviderRegistry {
  const bySpec = new Map(models);
  return {
    registry: createProviderRegistry(),
    deps: { env: {}, getAuth: async () => null, hasCredential: async () => false },
    resolveModel: (spec) => {
      const model = bySpec.get(spec);
      if (!model) throw new Error(`no judge for ${spec}`);
      return model;
    },
    normalizeSpecSync: (spec) => spec ?? 'test/model',
  };
}

async function ensembleHarness() {
  const harness = orchestratorHarness();
  // Instance-level seam override: the production method reads the owned
  // model services, which under bun have no provider to resolve. Everything
  // downstream of resolution — the LLM construction, both sinks — is the
  // real production path.
  Object.assign(harness.agent, {
    providerRegistry: (): AgentProviderRegistry => judgeRegistry([
      ['fake-a/m1', judgeModel()],
      ['fake-b/m1', judgeModel()],
    ]),
  });

  // A hand-labeled ledger: what the panel stands in for.
  const sql = sqlOver(harness.db);
  for (let i = 0; i < 3; i++) {
    recordTurnOutcome(sql, {
      turnId: `turn-${i}`,
      outcome: 'accepted',
      confidence: 0.8,
      source: 'classifier',
      userMessage: `request ${i}`,
      assistantResponse: `answer ${i}`,
      followup: '',
      scaffoldVersion: 1,
      now: 1_700_000_000_000 + i * 60_000,
    });
  }
  const ids = sql<{ id: string }>`SELECT id FROM turn_outcomes ORDER BY created_at`;
  recordOutcomeLabels(sql, {
    labeler: 'owner',
    labels: ids.map((row) => ({ outcomeId: row.id, label: 'accepted' })),
    now: 1_700_100_000_000,
  });
  return { harness, sql };
}

const operationsOf = (recorder: RunEventRecorder) =>
  recorder.read(WORKSPACE_RUN_ID).flatMap((event): Array<Extract<RunEvent, { type: 'model_operation' }>> =>
    event.type === 'model_operation' ? [event] : []);

describe('runOutcomeEnsemble — the judges write their operation lifecycle', () => {
  test('every judge call leaves start/end rows joined by operationId, with usage', async () => {
    const { harness, sql } = await ensembleHarness();
    const result = await harness.agent.runOutcomeEnsemble(['fake-a/m1', 'fake-b/m1']);

    // The panel actually ran: three turns × two judges.
    expect(result.run?.judged.map((j) => j.stored)).toEqual([3, 3]);
    expect(result.gap).toBeNull();

    const recorder = new RunEventRecorder(sql);
    const operations = operationsOf(recorder);
    expect(operations).toHaveLength(12); // 6 calls × (start + end)

    const byId = new Map<string, typeof operations>();
    for (const row of operations) {
      byId.set(row.operationId, [...(byId.get(row.operationId) ?? []), row]);
    }
    expect(byId.size).toBe(6);

    for (const [operationId, rows] of byId) {
      expect(rows.map((r) => r.phase).sort()).toEqual(['end', 'start']);
      const end = rows.find((r) => r.phase === 'end')!;
      expect(end.operationId).toBe(operationId);
      expect(end.outcome).toBe('ok');
      expect(end.usage).toEqual({ input: 41, output: 7 });
      expect(end.source).toBe('judge');
      expect(end.op).toBe('complete');
      // Both rows of one operation name the same judge spec.
      expect(new Set(rows.map((r) => r.spec))).toEqual(new Set([rows[0]!.spec]));
    }
    // Both families ran: six of the twelve operation rows name each judge.
    expect(operations.map((r) => r.spec).sort()).toEqual([
      'fake-a/m1', 'fake-a/m1', 'fake-a/m1', 'fake-a/m1', 'fake-a/m1', 'fake-a/m1',
      'fake-b/m1', 'fake-b/m1', 'fake-b/m1', 'fake-b/m1', 'fake-b/m1', 'fake-b/m1',
    ]);

    // The cost reporting beside the lifecycle is unchanged: one model_call
    // per judge call, still filed under the judge label.
    const calls = recorder.read(WORKSPACE_RUN_ID)
      .filter((event): event is Extract<RunEvent, { type: 'model_call' }> => event.type === 'model_call');
    expect(calls).toHaveLength(6);
    expect(calls.every((c) => c.source === 'judge')).toBe(true);
    expect(calls.every((c) => c.usage !== undefined)).toBe(true);
  });
});

describe('suggestWorkspaceTitle — the fast-model naming pass writes its lifecycle', () => {
  test('the title call leaves a start/end pair filed under fast, beside its cost row', async () => {
    const harness = orchestratorHarness();
    const titleModel = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: '{"title":"Mission Control"}' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 41, noCache: 41, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 7, text: 7, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    Object.assign(harness.agent, {
      providerRegistry: (): AgentProviderRegistry => judgeRegistry([['fake-a/m1', titleModel]]),
      getModelForReview: async () => titleModel,
    });

    // Driven through the harness accessor for the same call
    // maybeAutoTitleWorkspace wires into applyWorkspaceTitle's `suggest` slot.
    const title = await harness.agent.harnessSuggestWorkspaceTitle('track launches');
    expect(title).toBe('Mission Control');

    const operations = operationsOf(new RunEventRecorder(sqlOver(harness.db)));
    expect(operations.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(operations[0]!.operationId).toBe(operations[1]!.operationId);
    expect(operations.every((e) => e.source === 'fast' && e.op === 'complete')).toBe(true);
    expect(operations[1]!.outcome).toBe('ok');
    expect(operations[1]!.usage).toEqual({ input: 41, output: 7 });
    // This seam resolves the model behind a cache and knows no spec.
    expect(operations.every((e) => e.spec === undefined)).toBe(true);
  });
});
