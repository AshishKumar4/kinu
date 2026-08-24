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
  BUILTIN_PROFILE_CATALOG,
  createProviderRegistry,
  profileCatalogDigest,
  recordOutcomeLabels,
  recordTurnOutcome,
  resolveTurnProfile,
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

/** `MODEL_ROUTE_POLICY.fast` is the `tiny` tier, so the naming pass must resolve
 *  THIS spec and no other. Given a distinct value from the chat and deep tiers
 *  so a wrong route names a different model rather than accidentally agreeing.
 *
 *  The effort is explicit and deliberately implausible for a naming pass: an
 *  assertion against a DEFAULT effort would pass whether or not the tier's own
 *  assignment was read, which is the thing the old hardcoded effort got wrong. */
const TINY_MODEL = 'fake-a/m1';
const TINY_EFFORT = 'high' as const;

function titleProfile() {
  const catalog = {
    ...BUILTIN_PROFILE_CATALOG,
    tiers: {
      default: { model: 'fake-chat/m1' },
      tiny: { model: TINY_MODEL, reasoningEffort: TINY_EFFORT },
      deep: { model: 'fake-deep/m1' },
    },
  };
  return resolveTurnProfile({
    envelope: {
      authority: { kind: 'account', accountId: 'acct-1' },
      version: 1,
      digest: profileCatalogDigest(catalog),
      catalog,
    },
    provider: {
      revision: 'rev-1',
      availableModels: ['fake-chat/m1', TINY_MODEL, 'fake-deep/m1'],
    },
    roleId: 'general',
    workMode: 'build',
    availableTools: [],
    activeSkills: [],
  });
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

describe('suggestWorkspaceTitle — the fast-model naming pass', () => {
  test('the title call runs the TINY tier and files a start/end pair under fast', async () => {
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
    // Only MODEL CONSTRUCTION is substituted. `modelForSource('fast')` runs its
    // real body — `resolveModelRoute` against the profile below, then this
    // resolver — so the route and the spec it returns are the production ones.
    // `resolved` records what the route asked for, which is the assertion with
    // teeth: the old wiring called `getModelForReview()`, the account-wide DEEP
    // tier, while filing the spend as `fast`.
    const resolved: Array<{ spec: string | null | undefined; effort: string }> = [];
    Object.assign(harness.agent, {
      routingProfile: async () => titleProfile(),
      ownedModelServices: {
        resolveModelWithEffort: (spec: string | null | undefined, effort: string) => {
          resolved.push({ spec, effort });
          return { model: titleModel, providerOptions: undefined };
        },
      },
    });

    // Driven through the harness accessor for the same call
    // maybeAutoTitleWorkspace wires into applyWorkspaceTitle's `suggest` slot.
    const title = await harness.agent.harnessSuggestWorkspaceTitle('track launches');
    expect(title).toBe('Mission Control');

    // `fast` routes to `tiny`, and the effort is the tier's own.
    expect(resolved).toEqual([{ spec: TINY_MODEL, effort: TINY_EFFORT }]);

    const operations = operationsOf(new RunEventRecorder(sqlOver(harness.db)));
    expect(operations.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(operations[0]!.operationId).toBe(operations[1]!.operationId);
    expect(operations.every((e) => e.source === 'fast' && e.op === 'complete')).toBe(true);
    expect(operations[1]!.outcome).toBe('ok');
    expect(operations[1]!.usage).toEqual({ input: 41, output: 7 });
    // The spec is KNOWN now, and that is the fix: the route resolved it from the
    // profile, so it is the same string the model was built from. It used to be
    // absent because the seam resolved a model behind a cache and could not say
    // which one — leaving the one row that prices the call unpriceable.
    expect(operations.every((e) => e.spec === TINY_MODEL)).toBe(true);
  });
});
