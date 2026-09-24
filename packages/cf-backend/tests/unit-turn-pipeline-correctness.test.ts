import { describe, expect, setSystemTime, test } from 'bun:test';
import { KinuError } from '@kinu.run/core/obs';
import {
  MERGE_POLICY_BINDING, mergePolicyProfile, scriptedTurnModel, sqlOver, toolExecute,
} from '@kinu.run/test-utils';
import {
  MergeOutputSchema, listQueuedShadowTrials, DEFAULT_WORKERS_AI_MODEL_SPEC, DYNAMIC_CONTEXT_OPEN_TAG,
  type ReasoningEffort, type ResolvedTurnProfile,
} from '@kinu.run/core';
import {
  declareShadowCandidate, hostedExplorationHarness, hostedMainActor, improvementLanesRan,
  orchestratorHarness, reactivateOrchestratorHarness,
  chatSessionTurns, tapDiagnostics, until, type ActorHarness, type HarnessOrchestratorAgent, workspaceFiles,
  workspaceMainActor,
} from './helpers/actor-harness';
import { socketConnection } from './helpers/bindings';
import { answeringGateway, GATEWAY_MODEL } from './helpers/platform-gateway';
import type { ScriptedAnswer } from './helpers/turn-harness';
import { createRecordingLogger } from '@kinu.run/core/obs';
import { createHeadRuntime } from '../src/head-runtime';
import type { ExplorationHostSeams } from '../src/exploration-hosting';
import type { ModelMessage, ToolSet, UIMessage } from 'ai';
import { jsonSchema, streamText, tool } from 'ai';
import * as v from 'valibot';

/** Awaited: with I/O-bound extensions registered the step pipeline returns a Promise. */
async function stepMessages(
  agent: HarnessOrchestratorAgent, stepNumber: number, messages: readonly ModelMessage[],
): Promise<ModelMessage[]> {
  return [...await chatSessionTurns(agent).step(stepNumber, messages)];
}

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
const noExplorationHost: ExplorationHostSeams = new Proxy(Object.create(null), {
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

    const tools = { probe: tool({
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
    const probe = turnA?.tools?.probe;

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
    // Measured on deployed 234ed5d7d (bench-artifacts/first-run-flash-1789196459812/every-tool): the
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

    const file = toolExecute<{ action: string; path: string; edits?: { old_text: string; new_text: string }[] }, unknown>(
      agent.getTools().file,
    );

    await file({ action: 'read', path: '/context/working.jsonl' });
    expect(await file({
      action: 'edit', path: '/context/working.jsonl', edits: [{ old_text: 'OLD premise', new_text: 'NEW premise' }],
    })).toMatchObject({ ok: true });
    declareShadowCandidate(harness.db);
    workspaceMainActor(harness.db).config.setShadowSampleRate(1);
    const prepared = await chatSessionTurns(agent).prepare(turn([first, reply, next]));
    await chatSessionTurns(agent).settle({ messageId: 'edited-answer-2', text: 'second answer', requestId: 'edited-req-2' });
    const trial = listQueuedShadowTrials(sqlOver(harness.db), workspaceMainActor(harness.db), 1)[0];

    if (trial === undefined || prepared?.messages === undefined) throw new Error('the turn did not retain its request and trial');
    expect(prepared.messages[0]).toEqual({ role: 'user', content: 'use the NEW premise' });
    // The trial retains the called request (history plus dynamic block); compared on role and text.
    expect(spoken(trial.context)).toEqual(spoken(prepared.prompt));
    expect(trial.context.filter((message) => message.content === 'follow-up input')).toHaveLength(1);
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
    const harness = orchestratorHarness();
    const agent = harness.agent;
    agent.harnessInstallCatalog({
      tiers: { default: { model: 'workers-ai/account-default' } },
      availableModels: ['workers-ai/account-default', 'workers-ai/pinned-model'],
    });

    const pinned = await agent.setModel('workers-ai/pinned-model');
    expect(pinned).toEqual({ ok: true, spec: 'workers-ai/pinned-model' });

    const config = await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'hello' }] });

    expect(await agent.getAgentStatus()).toMatchObject({
      tierId: 'default', model: 'workers-ai/pinned-model', reasoningEffort: 'medium',
    });
    // The request's model is the memoized instance for the pinned spec.
    const request = v.safeParse(v.object({ model: v.unknown() }), config ?? {});
    expect(request.success && request.output.model).toBe(agent.getModel());
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
    await rootFiles.writeFile('/home/main/shared-proof.md', 'registered workspace bytes');
    const head = await hostedExplorationHarness(workspace, 'head', 'head-a1');
    expect(head.actor.record.kind).toBe('head');
    const headFiles = head.actor.runtime.storage.vfs;
    expect(await headFiles.readFile('/home/main/shared-proof.md', { encoding: 'utf8' }))
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
    expect((await stepMessages(agent, 0, admitted)).filter(isDynamicContextBlock)).toHaveLength(1);
    expect((await stepMessages(agent, 4, admitted)).filter(isDynamicContextBlock)).toHaveLength(1);
  });

  test('root mode facts describe submit_plan on the actual provider surface', async () => {
    const cases: readonly { mode: 'build' | 'plan'; installed: boolean; available: boolean }[] = [
      { mode: 'build', installed: true, available: false },
      { mode: 'plan', installed: true, available: true },
      { mode: 'plan', installed: false, available: false },
    ];

    for (const { mode, installed, available } of cases) {
      const { agent } = orchestratorHarness();
      agent.harnessDrivingUserMessage(`Run the ${mode} turn`, { kinuMode: mode });

      const model = scriptedTurnModel({ doGenerate: () => ({
        content: [{ type: 'text', text: 'done' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
      }) });

      agent.modelFactory = () => model;
      const handed: ModelMessage[] = [{ role: 'user', content: `Run the ${mode} turn` }];

      const turn = await chatSessionTurns(agent).prepare({ messages: handed, tools: installed ? agent.getTools() : {} });

      if (!turn) throw new Error('the root turn must prepare a configuration');
      const messages = await stepMessages(agent, 0, turn.messages ?? handed);
      await streamText({ model, system: turn.system, messages, tools: turn.tools, activeTools: turn.activeTools === undefined ? undefined : [...turn.activeTools] }).text;

      expect(model.doStreamCalls).toHaveLength(1);
      const request = model.doStreamCalls[0];
      expect(request?.tools?.some((entry) => entry.name === 'submit_plan') ?? false).toBe(available);
      // The facts ride the turn's dynamic-context block, which sits before the person's request.
      const block = request?.prompt.find((message) => message.role === 'user' && JSON.stringify(message).includes(DYNAMIC_CONTEXT_OPEN_TAG));
      expect(JSON.stringify(block)).toContain(`Mode: ${mode}; submit_plan: ${available ? 'available' : 'unavailable'}.`);
    }
  });

  test('a rejected new preparation cannot reuse a previous turn dynamic snapshot', async () => {
    const { agent } = orchestratorHarness();
    const handed: ModelMessage[] = [{ role: 'user', content: 'prepare one turn' }];
    const context = { system: 'sys', messages: handed, tools: {}, model: 'harness-model', continuation: false, body: {} };
    const turn = await chatSessionTurns(agent).prepare(context);
    const admitted = turn?.messages ?? handed;

    expect((await stepMessages(agent, 0, admitted)).filter(isDynamicContextBlock)).toHaveLength(1);
    // Settle first: the loop runs one turn at a time, so this preparation is a new turn.
    await chatSessionTurns(agent).settle({ messageId: 'prepared-answer', text: 'done' });
    const abort = new AbortController();
    abort.abort(new Error('rejected preparation'));
    await expect(chatSessionTurns(agent).prepare({ ...context, signal: abort.signal })).rejects.toThrow('rejected preparation');
    await expect(stepMessages(agent, 0, admitted)).rejects.toThrow('a model step requires a prepared profile and tool surface');
  });

  test("the turn request carries the tier's reasoning effort as its provider's option", async () => {
    // Two tiers that differ only in effort, so a constant or a chat-model default fails one of them.
    const efforts: Array<ReasoningEffort | undefined> = [];

    for (const effort of ['low', 'high'] as const) {
      const { agent } = orchestratorHarness();
      agent.harnessInstallCatalog({ tiers: { default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC, reasoningEffort: effort } } });
      const turn = await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: effort }] });

      const options = v.parse(
        v.object({ 'workers-ai': v.object({ reasoningEffort: v.picklist(['low', 'medium', 'high']) }) }),
        turn?.providerOptions,
      );

      efforts.push(options['workers-ai'].reasoningEffort);
    }

    expect(efforts).toEqual(['low', 'high']);
  });
  // Output caps are owned by the gate below; this is driven because a source scan cannot tell
  // a spent effort from a shadowed one.
  test('an auxiliary call binds the route it resolved — the model AND that route\'s own effort', async () => {
    // Driven twice under routes that differ on both axes, so a constant effort that matches the
    // first route still fails.
    const asked: Array<{ spec: string | null | undefined; effort: ReasoningEffort }> = [];
    let profile = mergePolicyProfile();

    const runtime = createHeadRuntime({
      host: noExplorationHost,
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

    const plan = (): string | null => db.query<{ plan_json: string | null }, []>(
      'SELECT plan_json FROM compaction_state',
    ).get()?.plan_json ?? null;

    const clear = () => agent.onMessage(
      socketConnection({ id: 'tab-1', send: () => {} }),
      JSON.stringify({ type: 'cf_agent_chat_clear' }),
    );

    await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'deploy the api' }] });
    db.prepare('INSERT INTO compaction_state (actor_id, session_key, plan_json) VALUES (?, ?, ?)')
      .run(workspaceMainActor(db).actorId, agent.name, '{"stored":"plan"}');

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

  // Core's `creditedTurnId` decides; this pins that the orchestrator honours it. A completed plan
  // turn is not an answer the captures competed against, so it purges them (as the CLI does).
  describe('mid-turn captures are credited to the turn only when it answered', () => {
    /** Seeds one unclaimed take set inside the turn's window, under this actor (claim and purge are `actor_id`-scoped). */
    function settleOneTurn(mode: 'plan' | 'build'): ActorHarness<HarnessOrchestratorAgent> {
      const harness = orchestratorHarness();
      harness.db.prepare(
        `INSERT INTO alternate_takes
           (actor_id, id, turn_id, session_id, task, source, winner_node_id, chosen_node_id,
            candidates, created_at, picked_at)
         VALUES (?, 'take-1', NULL, NULL, 'pick a strategy', 'mcts', 'win', NULL, ?, ?, NULL)`,
      ).run(
        workspaceMainActor(harness.db).actorId,
        JSON.stringify([
          { nodeId: 'win', text: 'go with approach A', score: 0.9, visits: 3, depth: 1 },
          { nodeId: 'alt', text: 'go with approach B', score: 0.86, visits: 2, depth: 1 },
        ]),
        Date.now() + 1_000,
      );

      // The roster reads the composer's mode off the driving message.
      harness.agent.harnessDrivingUserMessage(`${mode} this`, { kinuMode: mode });

      return harness;
    }

    const settled: UIMessage = {
      id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: 'the answer' }],
    };

    test('a completed build turn claims them', async () => {
      const harness = settleOneTurn('build');
      await chatSessionTurns(harness.agent).settle({ messageId: settled.id, parts: settled.parts, requestId: 'req-build' });
      expect(harness.db.query('SELECT turn_id, session_id FROM alternate_takes').get())
        .toMatchObject({ turn_id: 'a-1', session_id: 'default' });
    });

    test('a completed PLAN turn purges them', async () => {
      const harness = settleOneTurn('plan');
      // Positive control for the absence below: the seeded row did land.
      expect(harness.db.query('SELECT COUNT(*) AS n FROM alternate_takes').get())
        .toMatchObject({ n: 1 });
      await chatSessionTurns(harness.agent).settle({ messageId: settled.id, parts: settled.parts, requestId: 'req-plan' });
      expect(harness.db.query('SELECT COUNT(*) AS n FROM alternate_takes').get())
        .toMatchObject({ n: 0 });
    });
  });

  // `onStart`'s sweep re-pends every open lease, so the settle must close a lease for every drain
  // path, and only once the answer is durable.
  describe('a settled turn closes the delivery leases it answered, and only those', () => {
    /** A webhook event received and not yet drained, under this actor: the alarm owes it a drain. */
    function pendingDelivery(harness: ActorHarness<HarnessOrchestratorAgent>): void {
      harness.db.prepare(
        `INSERT INTO agent_log
           (actor_id, id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
            trust, priority, payload_visibility, payload, received_at,
            schema_version, dedupe_key, consumed_at)
         VALUES (?, 'ev-1', 'event', NULL, 0, NULL, 'tr-1', 'webhook_bearer', 'webhook',
                 'authenticated', 'normal', 'full', ?, 1, 1, NULL, NULL)`,
      ).run(workspaceMainActor(harness.db).actorId, JSON.stringify({
        webhook_id: 'hook-1',
        http_method: 'POST',
        http_headers: { 'content-type': 'application/json' },
        body: { text: 'a build finished' },
        delivery_id: 'delivery-1',
      }));
    }

    /** The lease after the detached dispatch reports; bounded so the must-stay-open cases still fail. */
    async function settledLease(
      harness: ActorHarness<HarnessOrchestratorAgent>,
    ): Promise<{ turn_id: string | null; consumed_at: number | null }> {
      for (let tick = 0; tick < 50 && lease(harness).consumed_at !== null; tick++) {
        await Bun.sleep(1);
      }

      return lease(harness);
    }

    function lease(harness: ActorHarness<HarnessOrchestratorAgent>): { turn_id: string | null; consumed_at: number | null } {
      return v.parse(
        v.object({ turn_id: v.nullable(v.string()), consumed_at: v.nullable(v.number()) }),
        harness.db.query('SELECT turn_id, consumed_at FROM agent_log WHERE id = \'ev-1\'').get(),
      );
    }

    /** The alarm drains the pending events into the live turn, and the step boundary absorbs them.
     *  Returns the turn the drain bound them to. */
    async function spliceDrain(harness: ActorHarness<HarnessOrchestratorAgent>): Promise<string> {
      await chatSessionTurns(harness.agent).prepare({ messages: [{ role: 'user', content: 'a live turn' }] });
      // The platform's alarm dispatches this callback; its drain phase is owed to the pending event.
      await harness.agent._kinuTimerTick();
      const bound = lease(harness);

      if (bound.turn_id === null || bound.consumed_at === null) throw new Error('the alarm did not drain the pending event');
      await chatSessionTurns(harness.agent).step(0, []);

      return bound.turn_id;
    }

    test('a spliced drain settles once, and the activation sweep will not redeliver it', async () => {
      const harness = orchestratorHarness();
      pendingDelivery(harness);
      const bound = await spliceDrain(harness);

      await chatSessionTurns(harness.agent).settle({ messageId: 'a-1', text: 'the answer', requestId: 'req-spliced' });

      // Answered: lease closed, binding kept, so no drain selects it again.
      expect(await settledLease(harness)).toEqual({ turn_id: bound, consumed_at: null });
      expect(harness.db.query(
        `SELECT COUNT(*) AS n FROM agent_log WHERE kind = 'event' AND consumed_at IS NOT NULL`,
      ).get()).toMatchObject({ n: 0 });
    });

    test('a reply that fails mid-dispatch stays owed with that failure, not as an open channel', async () => {
      const harness = orchestratorHarness();
      const actorId = workspaceMainActor(harness.db).actorId;
      pendingDelivery(harness);
      // A mail in the same drain, with its thread still open: the answer owes it a reply.
      harness.db.prepare(
        `INSERT INTO agent_log
           (actor_id, id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
            trust, priority, payload_visibility, payload, received_at,
            schema_version, dedupe_key, consumed_at)
         VALUES (?, 'ev-mail', 'event', NULL, 0, NULL, 'tr-2', 'email_inbound', 'email',
                 'authenticated', 'normal', 'full', ?, 1, 1, NULL, NULL)`,
      ).run(actorId, JSON.stringify({
        from: 'owner@example.com', to: 'agent@example.com', subject: 'the build', body_text: 'did it pass?',
        message_id: null, in_reply_to: null, references: null, attachments: [],
      }));
      harness.db.prepare(
        `INSERT INTO reply_channels (actor_id, id, event_id, kind, holder_addr, ttl_expires_at, created_at, updated_at)
         VALUES (?, 'ch-mail', 'ev-mail', 'email_thread', ?, ?, 1, 1)`,
      ).run(actorId, JSON.stringify({
        to: 'owner@example.com', from: 'agent@example.com', subject: 'the build', message_id: null, references: null,
      }), Date.now() + 3_600_000);
      harness.db.run(`CREATE TRIGGER refuse_reply_record BEFORE INSERT ON agent_log
        WHEN NEW.kind = 'reply_attempt' BEGIN SELECT RAISE(ABORT, 'storage refused the reply record'); END`);
      const bound = await spliceDrain(harness);

      await chatSessionTurns(harness.agent).settle({ messageId: 'a-mail', text: 'the answer', requestId: 'req-mail' });

      const owed = () => harness.db.query<{ status: string; outcome: string | null }, [string]>(
        'SELECT status, outcome FROM terminal_effects WHERE effect_key LIKE ?',
      ).all(`%:event_reply:${bound}`);

      await until(() => owed().some((row) => row.outcome !== null), 'the reply effect reported its outcome');
      expect(owed()).toEqual([{ status: 'pending', outcome: expect.stringContaining('storage refused the reply record') }]);
    });

    test('a turn with no durable answer leaves the delivery recoverable', async () => {
      const harness = orchestratorHarness();
      pendingDelivery(harness);
      const bound = await spliceDrain(harness);

      // The commit failed, so the delivery is still owed; the seam re-queues the drain as its own turn.
      await expect(chatSessionTurns(harness.agent).settle({ messageId: 'a-nodurable', text: 'the answer', requestId: 'req-nodurable', persistFails: true }))
        .rejects.toThrow('could not be written');

      const runs = harness.db.query('SELECT run_id, type, payload FROM run_events WHERE type IN (\'run_start\', \'run_end\') ORDER BY rowid').all()
        .map((row) => v.parse(v.object({ run_id: v.string(), type: v.string(), payload: v.string() }), row))
        .map((row) => [row.type, v.parse(v.object({ caused_by: v.optional(v.string()), reason: v.optional(v.string()) }), JSON.parse(row.payload))]);

      expect(runs).toEqual([
        ['run_start', { caused_by: 'chat' }], ['run_end', { reason: 'error' }],
        ['run_start', { caused_by: 'event_drain' }], ['run_end', { reason: 'completed' }],
      ]);
      expect(await settledLease(harness)).toEqual({ turn_id: bound, consumed_at: null });
    });

    test('a failed turn leaves the delivery recoverable', async () => {
      const harness = orchestratorHarness();
      pendingDelivery(harness);
      const bound = await spliceDrain(harness);
      const taken = lease(harness).consumed_at;

      await chatSessionTurns(harness.agent).settle({ messageId: 'a-3', requestId: 'req-failed', status: 'error', error: 'provider exploded' });

      expect(await settledLease(harness)).toEqual({ turn_id: bound, consumed_at: taken });
    });
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
          schema_version, dedupe_key, consumed_at)
       VALUES (?, 'ev-1', 'event', 'drain-1', 0, NULL, 'tr-1', 'webhook_bearer', 'webhook',
               'authenticated', 'normal', 'full', ?, 1, 1, NULL, ?)`,
    ).run(workspaceMainActor(harness.db).actorId, JSON.stringify({
      webhook_id: 'hook-1', http_method: 'POST', http_headers: {}, body: { text: 'a build finished' },
      delivery_id: 'delivery-1',
    }), Date.now());
    harness.db.run(`CREATE TRIGGER refuse_lease_close BEFORE UPDATE OF consumed_at ON agent_log
      WHEN NEW.consumed_at IS NULL BEGIN SELECT RAISE(ABORT, 'storage refused the lease close'); END`);
    harness.agent.harnessDrivingUserMessage('the drain text', { kinuEvent: 'event_drain', drainTurnId: 'drain-1' });
    await chatSessionTurns(harness.agent).prepare({ messages: [{ role: 'user', content: 'the drain text' }] });
    await chatSessionTurns(harness.agent).settle({ messageId: 'a-drain', text: 'the answer' });
    // The alarm frame dispatches the owed reply.
    await harness.agent.terminalRetryPass();

    const leased = () => harness.db.query<{ turn_id: string | null; consumed_at: number | null }, []>(
      "SELECT turn_id, consumed_at FROM agent_log WHERE id = 'ev-1'",
    ).get();

    expect(harness.db.query<{ status: string; outcome: string | null }, []>(
      "SELECT status, outcome FROM terminal_effects WHERE effect_key = 'v1:event_reply:drain-1'",
    ).all()).toEqual([{ status: 'pending', outcome: expect.stringContaining('storage refused the lease close') }]);
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

    const ends = harness.db.query<{ payload: string }, []>("SELECT payload FROM run_events WHERE type = 'run_end'").all()
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
    // Provenance flips mid-session, so it rides `turnLocalTail`, never system placement.
    expect(system).not.toContain('the referenced job result first');
    expect(system).not.toContain('Background-resume');
  });

  test('the turn prompt advertises the temporary rung the child substrate always wires', async () => {
    // Every cf actor wires the temporary rung, and `TurnConfig.system` is the prompt the model gets.
    const { agent } = orchestratorHarness();

    const config = await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'summarise this file' }] });

    expect(config?.system ?? '').toContain('`hire` with `lifetime:"task"` runs one agent for one question');
  });

  test('the role the agent set is in the next prompt the DO builds', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;

    const turn = (content: string) => chatSessionTurns(agent).prepare({ messages: [{ role: 'user' as const, content }] });

    await turn('open the turn');
    const setMode = toolExecute<{ action: 'mode'; role: string }, unknown>(agent.getTools().tasks);
    const result = v.parse(RoleResultSchema, await setMode({ action: 'mode', role: 'auditor' }));
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
    const rendered = JSON.stringify(await stepMessages(agent, 0, turn?.messages ?? messages));

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

  async function settled(harness: ActorHarness<HarnessOrchestratorAgent>, answer: ScriptedAnswer): Promise<number> {
    const { messageId } = await chatSessionTurns(harness.agent).settle(answer);
    await until(() => improvementLanesRan(harness.db, messageId), 'the improvement lanes ran');

    return harness.db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM evolution_events WHERE type = 'advisor_note'",
    ).get()?.n ?? 0;
  }

  test('a completed build turn earns its review', async () => {
    const harness = advisorHarness();
    await chatSessionTurns(harness.agent).prepare({ messages: [{ role: 'user', content: 'deploy the api' }] });
    expect(await settled(harness, { messageId: 'a-build', text: 'deployed' })).toBe(1);
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
