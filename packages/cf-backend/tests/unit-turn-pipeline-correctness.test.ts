import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { describe, expect, setSystemTime, test } from 'bun:test';
import { KinuError } from '@kinu.run/core/obs';
import {
  MERGE_POLICY_BINDING, mergePolicyProfile, present, scriptedTurnModel, toolExecute,
} from '@kinu.run/test-utils';
import {
  MergeOutputSchema, DEFAULT_WORKERS_AI_MODEL_SPEC, DYNAMIC_CONTEXT_OPEN_TAG, mcpToolKey, type JsonValue,
  type ReasoningEffort, type ResolvedTurnProfile,
  LiveWorkers,
} from '@kinu.run/core';
import {
  hostedExplorationHarness, hostedMainActor, improvementLanesRan,
  mainDatabase, orchestratorHarness, reactivateOrchestratorHarness, catalogTurn, gatewayWorkspace, GATEWAY_CATALOG,
  chatSessionTurns, driveUntil, tapDiagnostics, until, type ActorHarness, type HarnessOrchestratorAgent, workspaceFiles,
  workspaceMainActor, type RecordedUserPlaneCalls,
} from './helpers/actor-harness';
import { answeringGateway, chatCompletion, GATEWAY_MODEL, stubAiBinding } from './helpers/platform-gateway';
import type { ScriptedAnswer } from './helpers/turn-harness';
import { createRecordingLogger } from '@kinu.run/core/obs';
import { createHeadRuntime } from '../src/head-runtime';
import type { HostedActorSeams } from '../src/hosted-actors';
import type { ModelMessage, ToolSet } from 'ai';
import { jsonSchema, tool } from 'ai';
import * as v from 'valibot';

/** Role plus flattened text, so string content and a single text part compare equal. */
function spoken(messages: readonly ModelMessage[]): { role: string; text: string }[] {
  return messages.map((message) => ({
    role: message.role,
    text: v.is(v.string(), message.content)
      ? message.content
      : message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''),
  }));
}

function isDynamicContextBlock(message: ModelMessage): boolean {
  if (message.role !== 'user') return false;
  const { content } = message;

  return !Array.isArray(content) && content.includes('<dynamic_context');
}

/** Drive tools via `toolExecute`: `v.function()` erases the signature, dropping the SDK's `options` argument. */
const RoleResultSchema = v.object({ role: v.string() });


/** Fails loud on any member access: a merge must never reach the exploration substrate. */
const noExplorationHost: HostedActorSeams = new Proxy(Object.create(null), {
  get: (_target, key) => {
    throw new Error(`the head merge reached the exploration substrate: ${String(key)}`);
  },
});

/** Valid JSON merge answer; the scripted factory also answers `doStream`. */
const MERGE_ANSWER_MODEL = scriptedTurnModel({
  doGenerate: () => ({
    content: [{
      type: 'text' as const,
      text: '{"narrative":"Both heads agree the parser is sound.","selected_decisions":[],'
        + '"unresolved_questions":[],"recommendations":["ship it"]}',
    }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: {
      inputTokens: { total: 41, noCache: 41, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 7, text: 7, reasoning: undefined },
    },
    warnings: [],
  }),
});

/** A second judge route differing in both model and effort, so neither can pass alone. */
const REBOUND_JUDGE = {
  model: 'fake/deep-rebound', reasoningEffort: 'low', fallbacks: [],
} satisfies { model: string; reasoningEffort: ReasoningEffort; fallbacks: readonly string[] };

/** `judge` is a fixed-tier producer, so its route is `profile.tiers.deep`. */
function reboundJudgeRoute(profile: ResolvedTurnProfile): ResolvedTurnProfile {
  return { ...profile, tiers: { ...profile.tiers, deep: REBOUND_JUDGE } };
}

describe('turn-pipeline correctness wiring', () => {
  test('a detached hosted tool retains profile A after release and admission of profile B', async () => {
    const { agent } = orchestratorHarness();
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const seen: Array<ReasoningEffort | null> = [];

    // Named as a builtin: a turn sends only the tools its profile admits, and a stray name is none of them.
    const tools = { file: tool({
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false }),
      execute: async () => {
        // The status the tab reads, asked from inside the detached tool's own context.
        seen.push((await agent.getAgentStatus()).reasoningEffort);
        started.resolve();
        await held.promise;
        seen.push((await agent.getAgentStatus()).reasoningEffort);

        return 'settled';
      },
    }) };

    const admit = (effort: ReasoningEffort) => {
      agent.harnessInstallCatalog({ tiers: { default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC, reasoningEffort: effort } } });

      return chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: effort }],
        tools });
    };

    const turnA = await admit('low');
    const probe = turnA?.tools?.file;

    if (!probe) throw new Error('the admitted tool is missing');

    const invoke = toolExecute<Record<string, never>, unknown>(probe);
    const detached = invoke({});
    await started.promise;
    await chatSessionTurns(agent).settle({ messageId: 'profile-A', text: 'detached', requestId: 'profile-A' });
    await admit('high');
    expect((await agent.getAgentStatus()).reasoningEffort).toBe('high');
    held.resolve();
    await detached;

    expect(seen).toEqual(['low', 'low']);
  });

  test('the turn prompt carries the loaded SOUL', async () => {
    // `beforeTurn` refreshes the soul only when nothing is cached.
    const harness = orchestratorHarness();
    const agent = harness.agent;
    await agent.setSoul('You are Atlas. Preserve the owner\'s exact requirements.');

    const config = await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'summarise this file' }] });

    expect(config?.system ?? '').toContain('You are Atlas. Preserve the owner\'s exact requirements.');
  });

  test('the second turn\'s request carries the message that started it, after the first', async () => {
    // Measured on deployed a90ddda79 (bench-artifacts/first-run-flash-1789196459812/every-tool): the
    // second turn's request held only the first turn's user message.
    const harness = orchestratorHarness();
    const agent = harness.agent;
    const first: ModelMessage = { role: 'user', content: 'first: list your tools' };
    const reply: ModelMessage = { role: 'assistant', content: [{ type: 'text', text: 'eval, shell, file' }] };
    const second: ModelMessage = { role: 'user', content: 'second: now use each one' };

    const turn = (messages: ModelMessage[]) => ({ messages });

    const opening = await chatSessionTurns(agent).prepare(turn([first]));

    expect(opening?.messages?.filter((message) => message.role === 'user')).toEqual([first]);

    await chatSessionTurns(agent).settle({ messageId: 'a-1', text: 'eval, shell, file', requestId: 'req-1' });

    const following = await chatSessionTurns(agent).prepare(turn([first, reply, second]));
    const request = following?.messages ?? [];

    // Both halves, in order: a bare `toContain` would pass with only the second message.
    expect(request.filter((message) => message.role === 'user')).toEqual([first, second]);
    expect(request.filter((message) => message.role === 'assistant')).toEqual([reply]);
  });

  test('a managed context edit reaches the hosted request and retained trial together', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    const first: ModelMessage = { role: 'user', content: 'use the OLD premise' };
    const reply: ModelMessage = { role: 'assistant', content: 'answer' };
    const next: ModelMessage = { role: 'user', content: 'follow-up input' };

    const turn = (messages: ModelMessage[]) => ({ messages });

    await chatSessionTurns(agent).prepare(turn([first]));
    await chatSessionTurns(agent).settle({ messageId: 'edited-answer-1', text: 'answer', requestId: 'edited-req-1' });
    // The agent edits its own working context with its file tool; a stale edit's refusal is core's
    // (unit-context-plane.test.ts).

    const file = toolExecute<{ op: string; path: string; edits?: { old_text: string; new_text: string }[] }, unknown>(
      agent.getTools().file,
    );

    await file({ op: 'read', path: '/context/working.jsonl' });
    expect(await file({
      op: 'edit', path: '/context/working.jsonl', edits: [{ old_text: 'OLD premise', new_text: 'NEW premise' }],
    })).toMatchObject({ applied: [expect.objectContaining({ line: expect.any(Number) })] });
    const prepared = await chatSessionTurns(agent).prepare(turn([first, reply, next]));
    await chatSessionTurns(agent).settle({ messageId: 'edited-answer-2', text: 'second answer', requestId: 'edited-req-2' });

    if (prepared?.messages === undefined) throw new Error('the turn did not retain its request');
    expect(prepared.messages[0]).toEqual({ role: 'user', content: 'use the NEW premise' });
  });

  test('a catalog the turn cannot reach runs on builtins; any other failure is the turn\'s own', async () => {
    // An unreachable catalog degrades to builtins; a denied caller is a fault and fails the turn.
    const turn = {
      system: 'sys',
      messages: [{ role: 'user' as const, content: 'hello' }],
      tools: {} satisfies ToolSet,
      model: 'harness-model',
      continuation: false,
      body: {},
    };

    const unreachable = orchestratorHarness({
      warmConnections: [], failWarm: null, titles: [],
      failDescriptors: new Error('socket hang up'),
    });

    await unreachable.agent.setSoul('You are Vesta. Answer on the tools you hold.');
    const config = await chatSessionTurns(unreachable.agent).prepare(turn);
    expect(config?.system ?? '').toContain('You are Vesta. Answer on the tools you hold.');

    const denied = orchestratorHarness({
      warmConnections: [], failWarm: null, titles: [],
      failDescriptors: new KinuError('denied', 'the caller holds no capability'),
    });

    await expect(chatSessionTurns(denied.agent).prepare(turn)).rejects.toMatchObject({ code: 'denied' });
  });

  test('the admission count and the submitted model resolve ONE spec, not two', async () => {
    // A `@cf/…` id names no provider: parsed raw, admission would count it against provider `@cf`
    // while the request went to Workers AI.
    const { agent } = orchestratorHarness();
    agent.harnessInstallCatalog({
      tiers: { default: { model: '@cf/zai-org/glm-5.3' } },
      availableModels: ['@cf/zai-org/glm-5.3'],
    });
    const logger = createRecordingLogger();
    const restore = tapDiagnostics(logger);

    try {
      await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'hello' }] });
    } finally {
      restore();
    }

    expect(logger.emitted.filter((line) => line.event === 'admission.uncounted').map((line) => line.fields.provider))
      .toEqual(['workers-ai']);
  });

  test('a pinned model is the model the next turn\'s request names', async () => {
    // The turn runs on the `setModel` pin, not the role tier's account default.
    const pinned = 'ai-gateway/workers-ai/@cf/harness/pinned';
    const served: string[] = [];

    const harness = gatewayWorkspace(stubAiBinding((run) => {
      served.push(JSON.stringify(run.query));

      return chatCompletion(run, 'Noted.');
    }));

    harness.agent.harnessInstallCatalog({ ...GATEWAY_CATALOG, availableModels: [GATEWAY_MODEL, pinned] });
    harness.agent.harnessCatalogModels({ [pinned]: { contextWindow: 128_000 } });
    expect(await harness.agent.setModel(pinned)).toEqual({ ok: true, spec: pinned });
    await catalogTurn(harness.agent, 'hello');

    expect(await harness.agent.getAgentStatus()).toMatchObject({ tierId: 'default', model: pinned, reasoningEffort: 'medium' });
    // What the binding was asked for, read where the request left.
    expect(served.at(-1)).toContain('@cf/harness/pinned');
  });

  test('a model set mid-turn sizes the next request, not the one in flight', async () => {
    // Each request resolves its model once; the turn in flight keeps the window it was composed with.
    const other = 'ai-gateway/workers-ai/@cf/harness/other';
    let switched: Promise<unknown> | null = null;

    const harness = gatewayWorkspace(stubAiBinding((run) => {
      switched ??= harness.agent.setModel(other);

      return chatCompletion(run, 'Noted.');
    }));

    harness.agent.harnessInstallCatalog({ ...GATEWAY_CATALOG, availableModels: [GATEWAY_MODEL, other] });
    harness.agent.harnessCatalogModels({ [GATEWAY_MODEL]: { contextWindow: 100_000 }, [other]: { contextWindow: 200_000 } });
    await harness.agent.setModel(GATEWAY_MODEL);
    await catalogTurn(harness.agent, 'Remember the word heron.');
    await switched;
    await catalogTurn(harness.agent, 'And the word egret.');

    // The pin's own measure, then the two turns.
    const windows = mainDatabase(harness).query<{ window: number }, []>(
      "SELECT json_extract(payload, '$.contextWindow') AS window FROM run_events WHERE type = 'context_admitted' ORDER BY rowid",
    ).all();

    expect(windows.map((row) => row.window)).toEqual([100_000, 100_000, 200_000]);
  });

  // 2026-09-29 (review of d35c1060fe): the request's catalog was bound to the workspace default before the turn's
  // profile chose its tier, so a turn on a smaller or larger tier model was admitted against the default's window.
  test("a turn on a tier's own model is admitted against that model's window", async () => {
    const deep = 'ai-gateway/workers-ai/@cf/harness/deep';
    const served: string[] = [];

    const harness = gatewayWorkspace(stubAiBinding((run) => {
      served.push(JSON.stringify(run.query));

      return chatCompletion(run, 'Noted.');
    }));

    harness.agent.harnessInstallCatalog({
      ...GATEWAY_CATALOG, tiers: { ...GATEWAY_CATALOG.tiers, default: { model: GATEWAY_MODEL }, deep: { model: deep } },
      availableModels: [GATEWAY_MODEL, deep],
    });
    harness.agent.harnessCatalogModels({ [GATEWAY_MODEL]: { contextWindow: 1_000_000 }, [deep]: { contextWindow: 128_000 } });
    workspaceMainActor(harness.db).config.setAssignedTier('deep');
    await catalogTurn(harness.agent, 'Remember the word heron.');

    const windows = mainDatabase(harness).query<{ window: number }, []>(
      "SELECT json_extract(payload, '$.contextWindow') AS window FROM run_events WHERE type = 'context_admitted' ORDER BY rowid",
    ).all();

    expect(served.at(-1)).toContain('@cf/harness/deep');
    expect(windows.at(-1)?.window).toBe(128_000);
  });

  test("a hosted actor's snapshot reports the effective model and the tier source that chose it", async () => {
    // Defends: the snapshot reported the child's own (never-set) config pin, and (measured 2026-09-18) a
    // workspace pinned to one model answered an added agent's pane on another. The snapshot and the
    // hosted turn resolve one profile (`hostedActorProfile`). Added via `createSubordinateAgent` so the
    // roster row is the one a real add writes.
    const workspace = orchestratorHarness();
    workspace.agent.harnessInstallCatalog({
      tiers: { default: { model: 'workers-ai/account-default' } },
      availableModels: ['workers-ai/account-default', 'workers-ai/pinned-model'],
    });
    await workspace.agent.setModel('workers-ai/pinned-model');
    // An added agent inherits the workspace's purpose, so it needs one.
    await workspace.agent.setSoul('# Purpose\n\nShip the deploy gates.');

    const added = await workspace.agent.createSubordinateAgent();

    const pinned = await workspace.agent.getActorSnapshot(added.name);
    expect(pinned.model).toEqual({ model: 'workers-ai/pinned-model', source: 'workspace' });

    // Unpinned: the role's tier, with source `role`.
    workspace.db.prepare("DELETE FROM actor_config WHERE key = 'model'").run();

    const unpinned = await workspace.agent.getActorSnapshot(added.name);
    expect(unpinned.model).toEqual({ model: 'workers-ai/account-default', source: 'role' });
  });

  test("an unpinned workspace reports the account's default before its first turn, and its next turn runs on it", async () => {
    const workspace = orchestratorHarness();
    workspace.agent.harnessInstallCatalog({
      tiers: { default: { model: 'workers-ai/account-default' } },
      availableModels: ['workers-ai/account-default'],
    });

    const status = await workspace.agent.getAgentStatus();
    expect(status.model).toBe('workers-ai/account-default');
    expect(workspace.agent.getModel()).toMatchObject({ modelId: 'account-default' });
  });

  test("a hire runs at its tier's own effort, else at the effort its parent runs at", async () => {
    // Before, the workspace's effort overrode a hire's tier; a tier that declares an effort is the owner's choice for the role.
    const workspace = orchestratorHarness();
    workspace.agent.harnessInstallCatalog({
      tiers: { default: { model: 'workers-ai/account-default' }, fast: { model: 'workers-ai/account-default', reasoningEffort: 'medium' } },
      availableModels: ['workers-ai/account-default'],
    });
    await workspace.agent.setSoul('# Purpose\n\nShip the deploy gates.');
    await workspace.agent.setReasoningEffort('xhigh');

    const effortAs = async (role: string) => {
      const added = await workspace.agent.createSubordinateAgent();
      workspace.db.prepare("INSERT OR REPLACE INTO actor_config (actor_id, key, value) VALUES (?, 'role_selection', ?)")
        .run(added.subordinate.actorId, role);

      return (await workspace.agent.getActorSnapshot(added.name)).reasoningEffort;
    };

    expect(await effortAs('task')).toBe('xhigh');
    expect(await effortAs('researcher')).toBe('medium');
  });

  test('an agent the owner adds by hand runs the general role on the account default model', async () => {
    // m1421: an added agent came up on a flash model; one the owner adds inherits the general role and the default.
    const workspace = orchestratorHarness();
    await workspace.agent.setSoul('# Purpose\n\nShip the deploy gates.');

    const added = await workspace.agent.createSubordinateAgent();
    const snapshot = await workspace.agent.getActorSnapshot(added.name);

    expect({ role: snapshot.role, model: snapshot.model }).toEqual({
      role: 'task', model: { model: DEFAULT_WORKERS_AI_MODEL_SPEC, source: 'role' },
    });
  });

  test('hosted heads run on the registered workspace identity, never a self-named filesystem', async () => {
    // A self-named head would derive a second, empty filesystem; bytes the root wrote must be the head's.
    const workspace = orchestratorHarness();
    await hostedMainActor(workspace);
    const rootFiles = workspaceFiles(workspace.agent);
    await writeText(rootFiles, '/home/main/shared-proof.md', 'registered workspace bytes');
    const head = await hostedExplorationHarness(workspace, 'head-a1');
    expect(head.actor.record.origin).toBe('swarm');
    const headFiles = head.actor.runtime.storage.vfs;
    expect(await readText(headFiles, '/home/main/shared-proof.md'))
      .toBe('registered workspace bytes');
  });

  test('the dynamic-context ledger rides the shared STEP pipeline, not the turn assembly', async () => {
    // Per step: the state changes mid-turn and a prepareStep override never feeds the next step's
    // input. Driven, because a source scan cannot tell a live weave from a dead one.
    const { agent } = orchestratorHarness();
    const handed: ModelMessage[] = [{ role: 'user', content: 'deploy the api' }];

    const turn = await chatSessionTurns(agent).prepare({ messages: handed });

    const admitted = turn?.messages ?? handed;

    expect(admitted.filter(isDynamicContextBlock)).toHaveLength(0);
    // The request the model was sent, as the turn's own step pipeline built it.
    expect((turn?.prompt ?? []).filter(isDynamicContextBlock)).toHaveLength(1);
  });

  test('root mode facts describe submit_plan on the actual provider surface', async () => {
    // A plain build turn is the static doctrine's default, so its block states no mode.
    const cases: readonly { mode: 'build' | 'plan'; installed: boolean; available: boolean; facts: string | null }[] = [
      { mode: 'build', installed: true, available: false, facts: null },
      { mode: 'plan', installed: true, available: true, facts: 'Mode: plan; submit_plan: available.' },
      { mode: 'plan', installed: false, available: false, facts: 'Mode: plan; submit_plan: unavailable.' },
    ];

    for (const { mode, installed, available, facts } of cases) {
      const { agent } = orchestratorHarness();
      agent.harnessDrivingUserMessage(`Run the ${mode} turn`, { kinuMode: mode });

      const handed: ModelMessage[] = [{ role: 'user', content: `Run the ${mode} turn` }];

      const turn = await chatSessionTurns(agent).prepare({ messages: handed, tools: installed ? agent.getTools() : {} });

      if (!turn) throw new Error('the root turn must prepare a configuration');
      // The provider call the turn made: its tool surface and its prompt.
      expect(turn.activeTools?.includes('submit_plan') ?? false).toBe(available);
      // The facts ride the turn's dynamic-context block, which sits before the person's request.
      const block = turn.prompt.find((message) => message.role === 'user' && JSON.stringify(message).includes(DYNAMIC_CONTEXT_OPEN_TAG));
      expect(/Mode: [a-z]+; submit_plan: [a-z]+\./u.exec(JSON.stringify(block ?? null))?.[0] ?? null).toBe(facts);
    }
  });

  // MCP tools differ per workspace, so as native definitions they split the tools prefix between workspaces.
  test('an MCP tool is no native definition and no system prompt line: eval calls it, and the dynamic block declares it', async () => {
    const mcp: NonNullable<RecordedUserPlaneCalls['mcp']> = {
      descriptors: [{
        serverId: 'srv-1', serverName: 'tracker', name: 'find_issue', toolKey: mcpToolKey('tracker', 'find_issue'),
        description: 'Find an issue by title.', readOnly: true,
        inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      }],
      calls: [],
      answer: { id: 'ISSUE-7' },
    };

    const userPlane: RecordedUserPlaneCalls = { warmConnections: [], failWarm: null, titles: [], turnCancels: [], mcp };
    const { agent } = orchestratorHarness(userPlane);
    const key = 'mcp_tracker_find_issue';
    const prepared = await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'find the login issue' }] });

    if (!prepared) throw new Error('the turn must prepare a configuration');
    expect(prepared.activeTools).toContain('eval');
    expect(prepared.activeTools).not.toContain(key);
    expect(JSON.stringify(prepared.system)).not.toContain(key);

    const said = spoken(prepared.prompt ?? []).map((message) => message.text).join('\n');
    // Declared to the model by the name eval calls it by, with the server's own description.
    expect(said).toContain(`tools[${JSON.stringify(key)}]`);
    expect(said).toContain('Find an issue by title.');

    const evaluated = await toolExecute<JsonValue, JsonValue>(present(prepared.tools.eval, 'eval'))({
      code: `return await tools[${JSON.stringify(key)}]({ title: 'login' });`,
    });

    expect(JSON.stringify(evaluated)).toContain('ISSUE-7');
    expect(mcp.calls).toEqual([{ tool: 'find_issue', args: { title: 'login' } }]);
  });

  // A body in the system prompt rewrote the cached prefix on the turn it arrived and again on the next.
  test('a /skill turn leaves the system prompt alone and carries the body just before the request', async () => {
    const plain = await chatSessionTurns(orchestratorHarness().agent).prepare({ messages: [{ role: 'user', content: 'build a board' }] });
    const invoked = await chatSessionTurns(orchestratorHarness().agent).prepare({ messages: [{ role: 'user', content: '/slates build a board' }] });

    if (!plain || !invoked) throw new Error('both turns must prepare a configuration');
    expect(invoked.system).toBe(plain.system);
    expect(JSON.stringify(invoked.system)).not.toContain('### slates');

    // The request the model was sent, as the turn's own step pipeline built it.
    const said = spoken(invoked.prompt ?? []).filter((message) => message.role === 'user');

    expect(said.at(-1)?.text).toBe('/slates build a board');
    expect(said.at(-2)?.text).toContain('### slates (explicit /slates)');
  });

  test("the turn request carries the tier's reasoning effort as its provider's option", async () => {
    // Two tiers that differ only in effort, so a constant or a chat-model default fails one of them.
    const efforts: Array<ReasoningEffort | undefined> = [];

    for (const effort of ['low', 'high'] as const) {
      const { agent } = orchestratorHarness();
      agent.harnessInstallCatalog({ tiers: { default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC, reasoningEffort: effort } } });
      const turn = await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: effort }] });

      const options = v.parse(
        v.object({ workersAi: v.object({ reasoningEffort: v.picklist(['low', 'medium', 'high']) }) }),
        turn?.providerOptions,
      );

      efforts.push(options.workersAi.reasoningEffort);
    }

    expect(efforts).toEqual(['low', 'high']);
  });
  // Output caps are owned by the gate below; this is driven because a source scan cannot tell
  // a spent effort from a shadowed one.
  test('an auxiliary call binds the route it resolved — the model AND that route\'s own effort', async () => {
    // Driven twice under routes that differ on both axes, so a constant effort that matches the
    // first route still fails.
    const asked: Array<{ spec: string | null | undefined; effort: ReasoningEffort | null }> = [];
    let profile = mergePolicyProfile();

    const runtime = createHeadRuntime({
      host: noExplorationHost,
      workers: new LiveWorkers(),
      models: {
        resolveModelWithEffort: (spec, effort) => {
          asked.push({ spec, effort });

          return { model: MERGE_ANSWER_MODEL, provider: 'mock', providerOptions: undefined };
        },
      },
      profile: async () => profile,
      reportModelCall: () => undefined,
    });

    await runtime.mergeLLM('merge the first pair of heads', MergeOutputSchema);
    profile = reboundJudgeRoute(profile);
    await runtime.mergeLLM('merge the second pair of heads', MergeOutputSchema);

    // The first ask is `MERGE_POLICY_BINDING`, shared with the local backend's suite.
    expect(asked).toEqual([
      MERGE_POLICY_BINDING,
      { spec: REBOUND_JUDGE.model, effort: REBOUND_JUDGE.reasoningEffort },
    ]);
  });

  test('a clear from the tab empties the conversation and its compaction plan; a refused clear touches neither', async () => {
    // The transcript clears first, so a clear it refuses (a turn is running) resets nothing after it.
    const harness = orchestratorHarness();
    const { agent, db } = harness;

    // Main's compaction plan is its own isolate's, kept under its own key.
    const plan = (): string | null => mainDatabase(harness).query<{ plan_json: string | null }, []>(
      'SELECT plan_json FROM compaction_state',
    ).get()?.plan_json ?? null;

    const clear = () => agent.clearConversation();

    await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'deploy the api' }] });
    mainDatabase(harness).prepare('INSERT OR REPLACE INTO compaction_state (actor_id, session_key, plan_json) VALUES (?, ?, ?)')
      .run(workspaceMainActor(db).actorId, workspaceMainActor(db).actorId, '{"stored":"plan"}');

    await expect(clear()).rejects.toMatchObject({ code: 'denied' });
    expect(plan()).toBe('{"stored":"plan"}');

    await chatSessionTurns(agent).settle({ messageId: 'a-clear', text: 'deployed' });
    await clear();

    expect((await agent.getChatHistoryPage({ limit: 10 })).items).toEqual([]);
    expect(plan()).toBeNull();
  });

  test('an INTERRUPTED turn is complete through every reader, with no projection write', async () => {
    // Defends: forking from a shown message gave `fork point not found` because readers used a
    // projection that skipped unreconciled turns. All readers use the canonical store.
    const harness = orchestratorHarness();
    chatSessionTurns(harness.agent).open('u-live');
    await chatSessionTurns(harness.agent).settle({ messageId: 'a-live', text: 'partial answer', requestId: 'req-interrupted', status: 'aborted' });

    // The pane-era projection tables must not exist at all.
    const projections = harness.db.prepare<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('actor_messages', 'assistant_messages')`,
    ).all();

    expect(projections).toEqual([]);

    const page = await harness.agent.getChatHistoryPage({ limit: 10 });
    expect(page.items.map((entry) => entry.id)).toEqual(['u-live', 'a-live']);
    expect(page.items[1].content).toBe('partial answer');
  });

  test('an ABORTED turn is still recorded as evidence', async () => {
    // Defends: failed cloud turns skipped the review buffer and `onTurnEnd` (the CLI reached both).
    // Ordering is pinned in core's unit-core-adapter-seams; this asserts the durable row.
    const harness = orchestratorHarness();
    await chatSessionTurns(harness.agent).prepare({ messages: [{ role: 'user', content: 'start the deploy' }] });

    await chatSessionTurns(harness.agent).settle({ messageId: 'a-cut', text: 'partial', requestId: 'req-cut', status: 'aborted' });

    // The turn's own partial answer, so another turn's row cannot pass a bare count.
    const recorded = harness.db.prepare<{ turn: string }, []>(
      `SELECT turn FROM completed_turns`,
    ).all();

    expect(recorded, 'an aborted turn left no evidence row').toHaveLength(1);
    expect(recorded[0].turn).toContain('partial');
  });

  test('a queued drain is driven by its own words and answered by the model', async () => {
    const drained = orchestratorHarness();
    drained.agent.harnessDrivingUserMessage('the drain text', { kinuEvent: 'event_drain', drainTurnId: 'drain-1' });
    const parked = await chatSessionTurns(drained.agent).prepare({ messages: [{ role: 'user', content: 'the drain text' }] });
    expect(parked?.messages.at(-1)).toEqual({ role: 'user', content: 'the drain text' });
    await chatSessionTurns(drained.agent).settle({ messageId: 'a-9', text: 'the answer' });
    const rows = (await drained.agent.getChatHistoryPage({ limit: 10 })).items;
    // The pane draws a drain's words as a system entry, not as the operator speaking.
    expect(rows.at(-2)).toMatchObject({ role: 'system', content: 'the drain text', metadata: expect.objectContaining({ drainTurnId: 'drain-1' }) });
    expect(rows.at(-1)).toMatchObject({ role: 'assistant', content: 'the answer' });
  });

  test("a queued drain's reply survives eviction and closes the batch it answered", async () => {
    // The drain identity is part of the reply effect's recorded input, not a per-activation stash.
    const harness = orchestratorHarness();
    harness.db.prepare(
      `INSERT INTO agent_log
         (actor_id, id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
          trust, priority, payload_visibility, payload, received_at,
          dedupe_key, consumed_at)
       VALUES (?, 'ev-1', 'event', 'drain-1', 0, NULL, 'tr-1', 'webhook_bearer', 'webhook',
               'authenticated', 'normal', 'full', ?, 1, NULL, ?)`,
    ).run(workspaceMainActor(harness.db).actorId, JSON.stringify({
      webhook_id: 'hook-1', http_method: 'POST', http_headers: {}, body: { text: 'a build finished' },
      delivery_id: 'delivery-1',
    }), Date.now());
    harness.db.run(`CREATE TRIGGER refuse_lease_close BEFORE UPDATE OF consumed_at ON agent_log
      WHEN NEW.consumed_at IS NULL BEGIN SELECT RAISE(ABORT, 'storage refused the lease close'); END`);
    harness.agent.harnessDrivingUserMessage('the drain text', { kinuEvent: 'event_drain', drainTurnId: 'drain-1' });
    await chatSessionTurns(harness.agent).prepare({ messages: [{ role: 'user', content: 'the drain text' }] });
    await chatSessionTurns(harness.agent).settle({ messageId: 'a-drain', text: 'the answer' });
    const logger = createRecordingLogger();
    const restore = tapDiagnostics(logger);

    try {
      // The alarm frame dispatches the owed reply.
      await harness.agent.terminalRetryPass();
    } finally {
      restore();
    }

    const leased = () => harness.db.query<{ turn_id: string | null; consumed_at: number | null }, []>(
      "SELECT turn_id, consumed_at FROM agent_log WHERE id = 'ev-1'",
    ).get();

    expect(harness.db.query<{ status: string }, []>(
      "SELECT status FROM terminal_effects WHERE effect_key = 'v1:event_reply:drain-1'",
    ).all()).toEqual([{ status: 'pending' }]);
    expect(logger.emitted.filter((line) => line.event === 'turn.terminal_effect_failed').map((line) => line.cause))
      .toEqual([expect.stringContaining('storage refused the lease close')]);
    expect(leased()?.consumed_at).not.toBeNull();

    harness.db.run('DROP TRIGGER refuse_lease_close');
    const restarted = await reactivateOrchestratorHarness(harness.db);
    // The wake the failure armed, reached: past the effect's backoff.
    setSystemTime(new Date(Date.now() + 60 * 60_000));

    try {
      await restarted.agent.terminalRetryPass();
    } finally {
      setSystemTime();
    }

    expect(leased()).toEqual({ turn_id: 'drain-1', consumed_at: null });
  });

  test('a stopped turn seals its run as aborted, not as an error', async () => {
    // Run-end vocabulary is core's `classifyRunEnd`; a backend-picked status once sealed a Stop as 'error'.
    const harness = orchestratorHarness();
    await chatSessionTurns(harness.agent).prepare({ messages: [{ role: 'user', content: 'deploy the api' }] });
    await chatSessionTurns(harness.agent).settle({ messageId: 'a-stop', text: 'partial', status: 'aborted' });

    const ends = mainDatabase(harness).query<{ payload: string }, []>("SELECT payload FROM run_events WHERE type = 'run_end'").all()
      .map((row) => v.parse(v.object({ reason: v.string() }), JSON.parse(row.payload)).reason);

    expect(ends).toEqual(['aborted']);
  });

  // Observed on the TurnConfig, not source text; the axes' metadata keys are core's (unit-prompt.test.ts).
  test('the role rides the cacheable prefix; provenance never does', async () => {
    const { agent } = orchestratorHarness();

    const config = await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'summarise this file' }] });

    const system = config?.system ?? '';
    // Role is a prefix fact: it changes only on a deliberate agent event.
    expect(system).toContain('## Role: Task (task)');
    // Provenance flips mid-session, so it rides the dynamic context, never system placement.
    expect(system).not.toContain('Fetch its result first');
    expect(system).not.toContain('## Why this turn runs');
  });

  test('the turn prompt advertises the temporary rung the child substrate always wires', async () => {
    // Every cf actor wires the temporary rung, and `TurnConfig.system` is the prompt the model gets.
    const { agent } = orchestratorHarness();

    const config = await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'summarise this file' }] });

    expect(config?.system ?? '').toContain('`hire` with `lifetime:"task"`');
  });

  test('the role the agent set is in the next prompt the DO builds', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;

    const turn = (content: string) => chatSessionTurns(agent).prepare({ messages: [{ role: 'user' as const, content }] });

    await turn('open the turn');
    const setMode = toolExecute<{ op: 'switchRole'; role: string }, unknown>(agent.getTools().tasks);
    const result = v.parse(RoleResultSchema, await setMode({ op: 'switchRole', role: 'auditor' }));
    expect(result.role).toBe('auditor');
    // Settle first: a second message during a running turn would splice into it.
    await chatSessionTurns(agent).settle({ messageId: 'role-set-answer', text: 'switched' });
    const config = await turn('audit this change');
    expect(config?.system).toContain('## Role: Auditor (auditor)');
  });

  test('a fresh multi-part ask gets NO delegation nudge at step 0', async () => {
    // No turn-start delegation hint: that pressure sent a simple diagnosis into a three-node swarm on 2026-09-03.
    const { agent } = orchestratorHarness();
    const messages: ModelMessage[] = [{ role: 'user', content: 'add caching to the api and update the docs' }];

    const turn = await chatSessionTurns(agent).prepare({ messages });
    const rendered = JSON.stringify(turn?.prompt ?? []);

    // Positive control: the step pipeline ran, so an absent nudge is not an absent step.
    expect(rendered).toContain('<dynamic_context');
    expect(rendered).not.toContain('Runtime steering');
    expect(rendered).not.toContain('action=swarm');
  });


});

describe('improvement_lanes — one verdict gates the improvement lanes', () => {
  // Driven through settled turns, with the review answered at the platform gateway; both verdicts are
  // one core decision (`improvementLanesOpen`).
  const NOTE = JSON.stringify({
    note: 'the staging cluster was never named', severity: 'nit', class: 'wrong-work',
  });

  /** Advisor reviews switched on in the stored config, every tier served by the gateway. */
  function advisorHarness(): ActorHarness<HarnessOrchestratorAgent> {
    const harness = orchestratorHarness(undefined, { aiGateway: answeringGateway(NOTE) });
    harness.agent.harnessInstallCatalog({
      tiers: { default: { model: GATEWAY_MODEL }, deep: { model: GATEWAY_MODEL }, fast: { model: GATEWAY_MODEL } },
      availableModels: [GATEWAY_MODEL],
    });
    workspaceMainActor(harness.db).config.setAdvisorEnabled(true);

    return harness;
  }

  const advisors = (harness: ActorHarness<HarnessOrchestratorAgent>) => harness.db.query<{ origin: string; tab: number; input: number; lifetime: string }, []>(
    "SELECT origin, tab, input, lifetime FROM workspace_actors WHERE name = 'ask-advisor' OR name LIKE 'ask-advisor-%'",
  ).all();

  /** Notes once the lanes ran and every hired advisor's delegated turn has drained. */
  async function settled(harness: ActorHarness<HarnessOrchestratorAgent>, answer: ScriptedAnswer): Promise<number> {
    const { messageId } = await chatSessionTurns(harness.agent).settle(answer);
    await until(() => improvementLanesRan(harness.db, messageId), 'the improvement lanes ran');

    if (advisors(harness).length > 0) await driveUntil(harness, 'the advisor answered', () => notes(harness) > 0);

    return notes(harness);
  }

  const notes = (harness: ActorHarness<HarnessOrchestratorAgent>): number => harness.db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM evolution_events WHERE type = 'advisor_note'",
  ).get()?.n ?? 0;

  test('a completed build turn earns its review, from an advisor agent of its own', async () => {
    const harness = advisorHarness();
    await chatSessionTurns(harness.agent).prepare({ messages: [{ role: 'user', content: 'deploy the api' }] });
    expect(await settled(harness, { messageId: 'a-build', text: 'deployed' })).toBe(1);
    // The reviewer is a background agent, listed with the others: view-only, no tab, one task.
    expect(advisors(harness)).toEqual([{ origin: 'evolution', tab: 0, input: 0, lifetime: 'task' }]);
  });

  test('a FAILED build turn feeds no lane', async () => {
    const harness = advisorHarness();
    await chatSessionTurns(harness.agent).prepare({ messages: [{ role: 'user', content: 'deploy the api' }] });
    expect(await settled(harness, { messageId: 'a-failed', status: 'error', error: 'provider exploded' })).toBe(0);
  });

  test('a completed PLAN turn feeds no lane', async () => {
    const harness = advisorHarness();
    harness.agent.harnessDrivingUserMessage('Plan the deploy.', { kinuMode: 'plan' });
    await chatSessionTurns(harness.agent).prepare({ messages: [{ role: 'user', content: 'Plan the deploy.' }] });
    expect(await settled(harness, { messageId: 'a-plan', text: 'the plan' })).toBe(0);
  });

  test('an ABORTED build turn feeds no lane', async () => {
    const harness = advisorHarness();
    await chatSessionTurns(harness.agent).prepare({ messages: [{ role: 'user', content: 'deploy the api' }] });
    expect(await settled(harness, { messageId: 'a-cut', text: 'partial', status: 'aborted' })).toBe(0);
  });
});
