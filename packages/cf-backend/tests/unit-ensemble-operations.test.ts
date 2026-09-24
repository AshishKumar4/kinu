/** Every ensemble judge call writes a durable start/end operation pair beside its `model_call` row. */

import { describe, expect, test } from 'bun:test';
import {
  actorScaffoldPath,
  MAIN_AGENT,
  recordOutcomeLabels,
  recordTurnOutcome,
  renderSoulMarkdown,
  RunEventRecorder,
  WORKSPACE_RUN_ID,
  type RunEvent,
} from '@kinu.run/core';
import { sqlOver, present } from '@kinu.run/test-utils';
import { openWorkspaceMainActor } from '@kinu.run/core';
import { chatSessionTurns, declareShadowCandidate, orchestratorHarness, workspaceFiles } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { MockLanguageModelV3 } from 'ai/test';
import { answeringGateway } from './helpers/platform-gateway';
import { createTestUserDO, testOwner } from './helpers/user-do';

/** Two judges the platform gateway serves; every call it answers carries one prompt and one completion token. */
const JUDGES = ['ai-gateway/workers-ai/@cf/judge/a', 'ai-gateway/workers-ai/@cf/judge/b'] as const;

const GATEWAY_USAGE = { input: 1, output: 1, cacheRead: 0, reasoning: 0 };

async function ensembleHarness() {
  const harness = orchestratorHarness(undefined, { aiGateway: answeringGateway('{"verdict":"accepted"}') });

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

  return { harness, sql, actor };
}

const operationsOf = (recorder: RunEventRecorder) =>
  recorder.read(WORKSPACE_RUN_ID).flatMap((event): Array<Extract<RunEvent, { type: 'model_operation' }>> =>
    event.type === 'model_operation' ? [event] : []);

describe('runOutcomeEnsemble — the judges write their operation lifecycle', () => {
  test('a scaffold decision cannot collide with later hosted model operations', async () => {
    const { harness, sql, actor } = await ensembleHarness();
    const agent = harness.agent;
    const first = await agent.runOutcomeEnsemble([...JUDGES]);
    expect(first.run?.judged.map((row) => row.stored)).toEqual([3, 3]);
    declareShadowCandidate(harness.db);
    await workspaceFiles(agent).writeFile(`${actorScaffoldPath({ kind: 'main', storageKey: MAIN_AGENT })}.v1`,
      'async function* run(rt, task) { yield { type: "chunk", data: "candidate" }; }');
    expect(await agent.applyScaffoldDecision('promote')).toMatchObject({ ok: true, action: 'promote' });

    const later = [3, 4, 5].map((index) => recordTurnOutcome(sql, actor, {
      turnId: `turn-${index}`, outcome: 'accepted', confidence: 0.8, source: 'classifier',
      userMessage: `request ${index}`, assistantResponse: `answer ${index}`, followup: '', scaffoldVersion: 1,
      now: 1_700_000_000_000 + index * 60_000,
    }));

    recordOutcomeLabels(sql, actor, {
      labeler: 'owner', labels: later.map((outcomeId) => ({ outcomeId, label: 'accepted' })), now: 1_700_100_000_000,
    });
    const second = await agent.runOutcomeEnsemble([...JUDGES]);
    expect(second.run?.judged.map((row) => row.stored)).toEqual([3, 3]);
    const retained = await agent.getRunEvents(WORKSPACE_RUN_ID);

    expect(retained.filter((event) => event.type === 'model_operation')).toHaveLength(24);
    expect(retained.filter((event) => event.type === 'model_call')).toHaveLength(12);
    expect(retained.filter((event) => event.type === 'scaffold_promotion')).toHaveLength(1);
    expect(new Set(retained.map((event) => event.eventIndex)).size).toBe(37);
  });

  test('every judge call leaves start/end rows joined by operationId, with usage', async () => {
    const { harness, sql } = await ensembleHarness();
    const result = await harness.agent.runOutcomeEnsemble([...JUDGES]);

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
      expect(end.usage).toEqual(GATEWAY_USAGE);
      expect(end.source).toBe('judge');
      expect(end.op).toBe('complete');
      expect(new Set(rows.map((r) => r.spec))).toEqual(new Set([rows[0].spec]));
    }

    expect(operations.map((r) => r.spec).sort((a, b) => String(a).localeCompare(String(b))))
      .toEqual([...Array<string>(6).fill(JUDGES[0]), ...Array<string>(6).fill(JUDGES[1])]);

    const calls = recorder.read(WORKSPACE_RUN_ID)
      .filter((event): event is Extract<RunEvent, { type: 'model_call' }> => event.type === 'model_call');

    expect(calls).toHaveLength(6);
    expect(calls.every((c) => c.source === 'judge')).toBe(true);
    expect(calls.every((c) => c.usage !== undefined)).toBe(true);
  });
});

describe('suggestWorkspaceTitle — the fast-model naming pass', () => {
  /** A fast tier distinct from the chat tier, with a non-default effort, so a wrong route or a
   *  hardcoded effort cannot agree by accident. */
  const FAST_MODEL = 'workers-ai/@cf/harness/fast';

  const FAST_EFFORT = 'high' as const;

  const TITLE_USAGE = {
    inputTokens: { total: 41, noCache: 41, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 7, text: 7, reasoning: undefined },
  };

  test('the genesis title call runs the FAST tier and files a start/end pair under fast', async () => {
    const user = createTestUserDO();
    const owner = await testOwner();
    const workspace = 'quiet-maple-a1b2c3d4';
    await user.userDO.registerWorkspace(owner, workspace, 'Track launches', { purpose: 'track launches', nameOrigin: 'auto' });
    await user.userDO.ensureWorkspaceCapability(workspace, null);
    const capability = present(user.installed.get(workspace), 'the workspace capability');
    const harness = orchestratorHarness(undefined, { userDO: user.userDO, workspace });
    harness.agent.harnessInstallCatalog({
      tiers: { fast: { model: FAST_MODEL, reasoningEffort: FAST_EFFORT } }, availableModels: [FAST_MODEL],
    });
    await harness.agent.installWorkspaceCapability(capability);
    await harness.agent.setSoul(renderSoulMarkdown({ name: 'Track launches', mission: 'track launches' }));
    // The call's options as the naming model received them: the route's effort rides the provider options.
    const received: unknown[] = [];
    harness.agent.sideModelFactory = () => new MockLanguageModelV3({
      doGenerate: async (options) => {
        received.push(options.providerOptions);

        return {
          content: [{ type: 'text', text: '{"title":"Mission Control"}' }],
          finishReason: { unified: 'stop', raw: undefined }, usage: TITLE_USAGE, warnings: [],
        };
      },
    });

    const turns = chatSessionTurns(harness.agent);
    const next = turns.park();
    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });
    await next;
    await turns.settle({ messageId: 'a-genesis', text: 'ok' });
    await joinHarnessFibers();

    expect(await user.userDO.getWorkspaceTitle(owner, workspace)).toEqual({ displayName: 'Mission Control', nameOrigin: 'auto' });
    expect(JSON.stringify(received)).toContain(FAST_EFFORT);
    const sql = sqlOver(harness.db);

    const operations = operationsOf(new RunEventRecorder(sql, openWorkspaceMainActor(sql)))
      .filter((event) => event.source === 'fast');

    expect(operations.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(operations[0].operationId).toBe(operations[1].operationId);
    expect(operations.every((e) => e.op === 'complete')).toBe(true);
    expect(operations[1].outcome).toBe('ok');
    expect(operations[1].usage).toEqual({ input: 41, output: 7 });
    // The route resolved the fast tier, so the pricing row names the model it routed.
    expect(operations.every((e) => e.spec === FAST_MODEL)).toBe(true);
    harness.db.close();
    user.close();
  });
});
