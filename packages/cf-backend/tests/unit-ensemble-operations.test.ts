/** Every ensemble judge call writes a durable start/end operation pair beside its `model_call` row. */

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
import { sqlOver, present } from '@kinu.run/test-utils';
import { openWorkspaceMainActor } from '@kinu.run/core';
import { declareShadowCandidate, orchestratorHarness } from './helpers/actor-harness';
import type { AgentProviderRegistry } from '../src/providers/agent-registry';

function scriptedModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 41, noCache: 41, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 7, text: 7, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

function judgeModel(): MockLanguageModelV3 {
  return scriptedModel('{"verdict":"accepted"}');
}

/** Explicit specs skip candidate surveying, so only resolveModel + normalizeSpecSync are reached. */
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

/** Distinct from the chat and deep tiers, with a non-default effort, so a wrong route or a hardcoded effort
 *  cannot agree by accident. */
const FAST_MODEL = 'fake-a/m1';

const FAST_EFFORT = 'high' as const;

function titleProfile() {
  const catalog = {
    ...BUILTIN_PROFILE_CATALOG,
    tiers: {
      default: { model: 'fake-chat/m1' },
      fast: { model: FAST_MODEL, reasoningEffort: FAST_EFFORT },
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
      availableModels: ['fake-chat/m1', FAST_MODEL, 'fake-deep/m1'],
    },
    roleId: 'task',
    workMode: 'build',
    availableTools: [],
    activeSkills: [],
  });
}

async function ensembleHarness() {
  const harness = orchestratorHarness();
  // The production method reads owned model services, which have no provider under bun; everything after
  // resolution is the real path.
  harness.agent.overrideProviderRegistry(judgeRegistry([
    ['fake-a/m1', judgeModel()],
    ['fake-b/m1', judgeModel()],
  ]));

  // Outcome rows are actor-scoped so one actor's grading cannot read or exhaust another's.
  const sql = sqlOver(harness.db);
  const actor = openWorkspaceMainActor(sql);

  for (let i = 0; i < 3; i++) {
    recordTurnOutcome(sql, actor, {
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

  const ids = sql<{ id: string }>`SELECT id FROM turn_outcomes WHERE actor_id = ${actor.actorId} ORDER BY created_at`;
  expect(ids.length).toBe(3);
  recordOutcomeLabels(sql, actor, {
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
  test('a scaffold decision cannot collide with later hosted model operations', async () => {
    const { harness } = await ensembleHarness();
    const agent = harness.agent;
    const runtime = agent.observeRuntime();
    const first = await agent.runOutcomeEnsemble(['fake-a/m1', 'fake-b/m1']);
    expect(first.run?.judged.map((row) => row.stored)).toEqual([3, 3]);
    declareShadowCandidate(harness.db);
    await runtime.storage.vfs.writeFile(`${runtime.identity.scaffold.path}.v1`,
      'async function* run(rt, task) { yield { type: "chunk", data: "candidate" }; }');
    expect(await agent.applyScaffoldDecision('promote')).toMatchObject({ ok: true, action: 'promote' });

    const later = [3, 4, 5].map((index) => recordTurnOutcome(runtime.storage.sql, runtime.actor, {
      turnId: `turn-${index}`, outcome: 'accepted', confidence: 0.8, source: 'classifier',
      userMessage: `request ${index}`, assistantResponse: `answer ${index}`, followup: '', scaffoldVersion: 1,
      now: 1_700_000_000_000 + index * 60_000,
    }));

    recordOutcomeLabels(runtime.storage.sql, runtime.actor, {
      labeler: 'owner', labels: later.map((outcomeId) => ({ outcomeId, label: 'accepted' })), now: 1_700_100_000_000,
    });
    const second = await agent.runOutcomeEnsemble(['fake-a/m1', 'fake-b/m1']);
    expect(second.run?.judged.map((row) => row.stored)).toEqual([3, 3]);
    const retained = await agent.getRunEvents(WORKSPACE_RUN_ID);

    expect(retained.filter((event) => event.type === 'model_operation')).toHaveLength(24);
    expect(retained.filter((event) => event.type === 'model_call')).toHaveLength(12);
    expect(retained.filter((event) => event.type === 'scaffold_promotion')).toHaveLength(1);
    expect(new Set(retained.map((event) => event.eventIndex)).size).toBe(37);
  });

  test('every judge call leaves start/end rows joined by operationId, with usage', async () => {
    const { harness, sql } = await ensembleHarness();
    const result = await harness.agent.runOutcomeEnsemble(['fake-a/m1', 'fake-b/m1']);

    expect(result.run?.judged.map((j) => j.stored)).toEqual([3, 3]);
    expect(result.gap).toBeNull();

    const recorder = new RunEventRecorder(sql, openWorkspaceMainActor(sql));
    const operations = operationsOf(recorder);
    expect(operations).toHaveLength(12); // 6 calls × (start + end)

    const byId = new Map<string, typeof operations>();

    for (const row of operations) {
      byId.set(row.operationId, [...(byId.get(row.operationId) ?? []), row]);
    }

    expect(byId.size).toBe(6);

    for (const [operationId, rows] of byId) {
      expect(rows.map((r) => r.phase).sort()).toEqual(['end', 'start']);
      const end = present(rows.find((r) => r.phase === 'end'), `the end row of operation ${operationId}`);
      expect(end.operationId).toBe(operationId);
      expect(end.outcome).toBe('ok');
      expect(end.usage).toEqual({ input: 41, output: 7 });
      expect(end.source).toBe('judge');
      expect(end.op).toBe('complete');
      expect(new Set(rows.map((r) => r.spec))).toEqual(new Set([rows[0].spec]));
    }

    expect(operations.map((r) => r.spec).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      'fake-a/m1', 'fake-a/m1', 'fake-a/m1', 'fake-a/m1', 'fake-a/m1', 'fake-a/m1',
      'fake-b/m1', 'fake-b/m1', 'fake-b/m1', 'fake-b/m1', 'fake-b/m1', 'fake-b/m1',
    ]);

    const calls = recorder.read(WORKSPACE_RUN_ID)
      .filter((event): event is Extract<RunEvent, { type: 'model_call' }> => event.type === 'model_call');

    expect(calls).toHaveLength(6);
    expect(calls.every((c) => c.source === 'judge')).toBe(true);
    expect(calls.every((c) => c.usage !== undefined)).toBe(true);
  });
});

describe('suggestWorkspaceTitle — the fast-model naming pass', () => {
  test('the title call runs the FAST tier and files a start/end pair under fast', async () => {
    const harness = orchestratorHarness();

    const titleModel = scriptedModel('{"title":"Mission Control"}');

    // Only model construction is substituted: `modelForSource('fast')` runs its real route resolution.
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

    const title = await harness.agent.harnessSuggestWorkspaceTitle('track launches');
    expect(title).toBe('Mission Control');

    expect(resolved).toEqual([{ spec: FAST_MODEL, effort: FAST_EFFORT }]);

    const ensembleSql = sqlOver(harness.db);
    const operations = operationsOf(new RunEventRecorder(ensembleSql, openWorkspaceMainActor(ensembleSql)));
    expect(operations.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(operations[0].operationId).toBe(operations[1].operationId);
    expect(operations.every((e) => e.source === 'fast' && e.op === 'complete')).toBe(true);
    expect(operations[1].outcome).toBe('ok');
    expect(operations[1].usage).toEqual({ input: 41, output: 7 });
    // The route resolved the spec, so the pricing row names the model actually built.
    expect(operations.every((e) => e.spec === FAST_MODEL)).toBe(true);
  });
});
