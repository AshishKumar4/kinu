import { describe, expect, test } from 'bun:test';
import { KinuError } from '@kinu.run/core/obs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MERGE_POLICY_BINDING, memberBody, mergePolicyProfile, scriptedTurnModel, toolExecute,
} from '@kinu.run/test-utils';
import {
  MergeOutputSchema, WORKSPACE_RUN_ID, listQueuedShadowTrials,
  DEFAULT_WORKERS_AI_MODEL_SPEC,
  type CompletedTurn, type ReasoningEffort, type ResolvedTurnProfile,
} from '@kinu.run/core';
import {
  declareShadowCandidate, hostedExplorationHarness, hostedMainActor, hostedSubordinateHarness,
  orchestratorHarness, reactivateOrchestratorHarness, chatSessionTurns,
  type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { createHeadRuntime } from '../src/head-runtime';
import { joinHarnessFibers } from './helpers/agents-sdk';
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

const actor = readFileSync(join(import.meta.dir, '..', 'src', 'actor-agent.ts'), 'utf8');

const source = readFileSync(join(import.meta.dir, '..', 'src', 'orchestrator.ts'), 'utf8');

const headRuntime = readFileSync(join(import.meta.dir, '..', 'src', 'head-runtime.ts'), 'utf8');

const takePick = readFileSync(join(import.meta.dir, '..', '..', 'core', 'src', 'read-models', 'evolution-views.ts'), 'utf8');

const exploration = readFileSync(join(import.meta.dir, '..', 'src', 'exploration-hosting.ts'), 'utf8');

const loop = readFileSync(join(import.meta.dir, '..', '..', 'core', 'src', 'orchestrator', 'chat-session.ts'), 'utf8');

const chatRunner = readFileSync(join(import.meta.dir, '..', '..', 'core', 'src', 'chat.ts'), 'utf8');

const transport = readFileSync(join(import.meta.dir, '..', 'src', 'chat-transport.ts'), 'utf8');

/** cf-backend callers of core's `reasoningEffortOptions`, so a second derivation shows up as a new entry. */
function effortDerivationSites(): string[] {
  const sites: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && readFileSync(path, 'utf8').includes('reasoningEffortOptions(')) {
        sites.push(entry.name);
      }
    }
  };

  walk(join(import.meta.dir, '..', 'src'));

  return sites.sort();
}

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
  model: 'fake/deep-rebound', reasoningEffort: 'low',
} satisfies { model: string; reasoningEffort: ReasoningEffort };

/** `judge` is a fixed-tier producer, so its route is `profile.tiers.deep`. */
function reboundJudgeRoute(profile: ResolvedTurnProfile): ResolvedTurnProfile {
  return { ...profile, tiers: { ...profile.tiers, deep: REBOUND_JUDGE } };
}

describe('turn-pipeline correctness wiring', () => {
  test('a detached hosted tool retains profile A after release and admission of profile B', async () => {
    const { agent } = orchestratorHarness();
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const seen: Array<ReasoningEffort | undefined> = [];

    const tools = { probe: tool({
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false }),
      execute: async () => {
        seen.push(agent.observeResolvedTurnProfile()?.tier.reasoningEffort);
        started.resolve();
        await held.promise;
        seen.push(agent.observeResolvedTurnProfile()?.tier.reasoningEffort);

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
    expect(agent.observeResolvedTurnProfile()).toBeNull();
    await admit('high');
    expect(agent.observeResolvedTurnProfile()?.tier.reasoningEffort).toBe('high');
    held.resolve();
    await detached;

    expect(seen).toEqual(['low', 'low']);
  });

  test('the turn prompt carries the loaded SOUL', async () => {
    // `beforeTurn` refreshes the soul only when nothing is cached.
    const harness = orchestratorHarness();
    const agent = harness.agent;
    agent.setObservedSoul('You are Atlas. Preserve the owner\'s exact requirements.');

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
    const runtime = agent.observeRuntime();
    const first: ModelMessage = { role: 'user', content: 'use the OLD premise' };
    const reply: ModelMessage = { role: 'assistant', content: 'answer' };
    const next: ModelMessage = { role: 'user', content: 'follow-up input' };

    const turn = (messages: ModelMessage[]) => ({ messages });

    await chatSessionTurns(agent).prepare(turn([first]));
    await chatSessionTurns(agent).settle({ messageId: 'edited-answer-1', text: 'answer', requestId: 'edited-req-1' });
    const document = v.parse(v.string(), await runtime.storage.vfs.readFile('/context/working.jsonl', { encoding: 'utf8' }));
    await runtime.storage.vfs.writeFile('/context/working.jsonl', document.replace('OLD premise', 'NEW premise'));
    await expect(runtime.storage.vfs.writeFile('/context/working.jsonl', document)).rejects.toThrow(/revision|stale|changed/i);
    declareShadowCandidate(runtime);
    runtime.actor.config.setShadowSampleRate(1);
    const prepared = await chatSessionTurns(agent).prepare(turn([first, reply, next]));
    await chatSessionTurns(agent).settle({ messageId: 'edited-answer-2', text: 'second answer', requestId: 'edited-req-2' });
    const trial = listQueuedShadowTrials(runtime.storage.sql, runtime.actor, 1)[0];

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

    unreachable.agent.setObservedSoul('You are Vesta. Answer on the tools you hold.');
    const config = await chatSessionTurns(unreachable.agent).prepare(turn);
    expect(config?.system ?? '').toContain('You are Vesta. Answer on the tools you hold.');

    const denied = orchestratorHarness({
      warmConnections: [], failWarm: null, titles: [],
      failDescriptors: new KinuError('denied', 'the caller holds no capability'),
    });

    await expect(chatSessionTurns(denied.agent).prepare(turn)).rejects.toMatchObject({ code: 'denied' });
  });

  test('the admission count and the submitted model resolve ONE spec, not two', () => {
    // Source pin: both call sites must parse the normalized spec (bare ids and `@cf/…` break
    // `parseModelSpec`); the harness has no seam to observe which provider counted.
    const assembleTurn = memberBody(actor, 'private async assembleTurn(input: TurnAssemblyInput): Promise<AssembledTurn>');
    expect(assembleTurn).toContain('parseModelSpec(providers.normalizeSpecSync(profile.tier.model))');
    expect(assembleTurn).not.toContain('parseModelSpec(profile.tier.model)');
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

    expect(agent.observeResolvedTurnProfile()?.tier).toEqual({
      id: 'default', source: 'workspace', model: 'workers-ai/pinned-model',
      reasoningEffort: 'medium',
    });
    // The request's model is the memoized instance for the pinned spec.
    const request = v.safeParse(v.object({ model: v.unknown() }), config ?? {});
    expect(request.success && request.output.model).toBe(agent.getModel());
  });

  test("a hosted actor's turn runs on the workspace's pinned model too", async () => {
    // Measured 2026-09-18 on a local dev build: a workspace pinned to `openai-compat/fake-live`
    // answered an added agent's pane on `workers-ai/@cf/zai-org/glm-5.3`.
    const workspace = orchestratorHarness();
    workspace.agent.harnessInstallCatalog({
      tiers: { default: { model: 'workers-ai/account-default' } },
      availableModels: ['workers-ai/account-default', 'workers-ai/pinned-model'],
    });
    await workspace.agent.setModel('workers-ai/pinned-model');

    const hire = await hostedSubordinateHarness(workspace, {
      name: 'task-pinned', displayName: '', nameOrigin: 'auto', mission: 'work the brief',
    });

    expect(await workspace.agent.observeHostedActorProfile(hire.actor)).toMatchObject({
      tier: {
        id: 'default', source: 'workspace', model: 'workers-ai/pinned-model',
        reasoningEffort: 'medium',
      },
    });
  });

  test("a hosted actor's snapshot reports the effective model and the tier source that chose it", async () => {
    // Defends: the snapshot reported the child's own (never-set) config pin. Added via
    // `createSubordinateAgent` so the roster row is the one a real add writes.
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

  test('hosted heads run on the registered workspace identity, never a self-named filesystem', async () => {
    // A self-named head would derive a second, empty filesystem; bytes the root wrote must be the head's.
    const workspace = orchestratorHarness();
    await hostedMainActor(workspace);
    const rootFiles = workspace.agent.observeRuntime().storage.vfs;
    await rootFiles.writeFile('/home/main/shared-proof.md', 'registered workspace bytes');
    const head = await hostedExplorationHarness(workspace, 'head', 'head-a1');
    expect(head.actor.record.kind).toBe('head');
    const headFiles = head.actor.runtime.storage.vfs;
    expect(await headFiles.readFile('/home/main/shared-proof.md', { encoding: 'utf8' }))
      .toBe('registered workspace bytes');
    // The seam carries no name of its own; the only names are the directory's.
    expect(exploration).not.toContain('sharedParent');
    expect(exploration).not.toContain('facetIdentity');
    expect(exploration).not.toContain('setSharedParent');
    expect(exploration).not.toContain('spawnHeadFacet');
    expect(headRuntime).not.toContain('createAgentProviderRegistry');
  });

  test('the head runtime constructor receives this actor\'s operation sink', () => {
    // A head's non-turn calls must land in the root's operation ledger, not facet SQLite.
    const rootRuntime = memberBody(actor, 'protected getCFHeadRuntime()');
    expect(rootRuntime).toContain('operations: this.modelOperations');
    expect(headRuntime).toContain('operations?: ModelOperationSink');
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

      expect(agent.observeResolvedTurnProfile()?.allowedTools).toContain('submit_plan');
      expect(model.doStreamCalls).toHaveLength(1);
      const request = model.doStreamCalls[0];
      expect(request?.tools?.some((entry) => entry.name === 'submit_plan') ?? false).toBe(available);
      expect(JSON.stringify(request?.prompt.filter((message) => message.role === 'user').at(-1)))
        .toContain(`Mode: ${mode}; submit_plan: ${available ? 'available' : 'unavailable'}.`);
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

  test('the turn assembly derives the profile reasoning effort, and the chat runner merges it with the cache options', () => {
    const assembly = actor.slice(
      actor.indexOf('private async assembleTurn(input: TurnAssemblyInput)'),
      actor.indexOf('protected dynamicContextSnapshot('),
    );

    expect(assembly).toContain('profile.tier.reasoningEffort');
    // Both sites read the one normalised parse (a raw parse yields `@cf` or throws on bare ids).
    expect(assembly).toContain('tierModel.provider');
    expect(assembly).not.toContain('parseModelSpec(profile.tier.model)');
    expect(assembly).toContain('reasoningEffortOptions');

    // The one provider-options merge is the chat runner's, by provider namespace.
    const prepare = actor.slice(
      actor.indexOf('protected async prepareTurn(item: ChatTurnInput'),
      actor.indexOf('private async assembleTurn(input: TurnAssemblyInput)'),
    );

    expect(prepare).toContain('if (assembled.reasoningOptions) liveTurn.providerOptions = assembled.reasoningOptions;');
    expect(prepare).toContain('providerId: assembled.promptModel.provider');
    expect(chatRunner).toContain('const providerOptions = mergeProviderOptions(cache.providerOptions, opts.providerOptions);');
    expect(actor).not.toContain('mergeProviderOptions(');
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

          return { model: MERGE_ANSWER_MODEL, providerOptions: undefined };
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

  // Whole-backend scan: `gate:duplication` misses three-line re-derivations and
  // `gate:capability-parity` checks wiring, so no gate owns this.
  test('one place in this backend turns a reasoning-effort level into provider options', () => {
    // A new entry is a second derivation, e.g. options from the chat model applied to another provider.
    expect(effortDerivationSites()).toEqual([
      'actor-agent.ts',
      'owned-model-services.ts',
      'runtime.ts',
    ]);
  });

  // Owner directive: no output caps (reasoning models spend budget thinking); cost is set by effort.
  // Adapters that must send one (`@ai-sdk/anthropic` `max_tokens`) use the model's own maximum.
  // Context admission's reserve is `ModelWindow.modelOutputLimit`, so this gate stays strict.
  test('no production source names an output-token cap', () => {
    const root = join(import.meta.dir, '..', '..');
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(path);
        } else if (/\.tsx?$/.test(entry.name)) {
          const text = readFileSync(path, 'utf8');

          for (const [line] of text.matchAll(/^.*\bmaxOutputTokens\b.*$/gm)) {
            offenders.push(`${path.slice(root.length + 1)}: ${line}`);
          }
        }
      }
    };

    for (const pkg of readdirSync(root, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = join(root, pkg.name, 'src');

      if (existsSync(src)) walk(src);
    }

    expect(offenders).toEqual([]);
  });

  test('CHAT_CLEAR resets the dynamic-context ledger and durable compaction plan after the transcript is cleared', () => {
    // Order: transcript first, then the ledger, then the durable plan.
    expect(transport).toContain("case 'clear': {");
    expect(transport).toContain('await this.wire.clear();');
    expect(actor).toContain('clear: () => this.clearConversation(),');

    const clear = actor.slice(
      actor.indexOf('private async clearConversation(): Promise<void> {'),
      actor.indexOf('private async readTurnInputs(tools: ToolSet)'),
    );

    const transcript = clear.indexOf('this.stores.history.clearConversation(CHAT_SESSION_ID,');
    const reset = clear.indexOf('this.actorSession.dynamic.reset()');
    const clearPlan = clear.indexOf('this.compactionState.plans.save(this.name, null)');
    expect(transcript).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(transcript);
    expect(clearPlan).toBeGreaterThan(reset);
  });

  test('the settle spine runs FIRST and hands the turn status to the one delivery seam', () => {
    // Signal disposition is core's (unit-signals.test.ts); this backend must settle the inbox before
    // anything can throw or return early, with the durability-inclusive verdict.
    const run = loop.slice(loop.indexOf('private async runTurn(item: QueueItem'));
    const settle = run.indexOf('const settled = this.actorSession.orchestrator.inbox.settle({ completed: durable });');
    const failureBranch = run.indexOf("if (!('committed' in commit)) {");
    const terminal = run.indexOf('await this.ports.terminal().settle({');
    expect(settle).toBeGreaterThan(-1);
    expect(failureBranch).toBeGreaterThan(settle);
    expect(terminal).toBeGreaterThan(failureBranch);
    expect(run).toContain("const durable = runError === null && 'committed' in commit;");
    // No second re-delivery path on this side — the seam owns it.
    expect(actor).not.toContain('reenqueue');
    expect(source).not.toContain('reenqueue');
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
    // What `beforeTurn` establishes for a turn with no durable identity.
    harness.agent.declareTurnEvolutionGate();

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
        harness.agent.observeRuntime().actor.actorId,
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
    /** Live stamp: activation reconcile sweeps leases past a grace, so a 1970 stamp would test the sweep. */
    const LEASE_TAKEN_AT = Date.now();

    /** An admitted event bound to `turnId` with its lease open, seeded under this actor; the spliced
     *  case demands a change, so a wrong-owner seed fails there. */
    function boundDelivery(harness: ActorHarness<HarnessOrchestratorAgent>, turnId: string): void {
      harness.db.prepare(
        `INSERT INTO agent_log
           (actor_id, id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
            trust, priority, payload_visibility, payload, received_at,
            schema_version, dedupe_key, consumed_at)
         VALUES (?, 'ev-1', 'event', ?, 0, NULL, 'tr-1', 'webhook_bearer', 'webhook',
                 'authenticated', 'normal', 'full', ?, 1, 1, NULL, ?)`,
      ).run(harness.agent.observeRuntime().actor.actorId, turnId, JSON.stringify({
        webhook_id: 'hook-1',
        http_method: 'POST',
        http_headers: { 'content-type': 'application/json' },
        body: { text: 'a build finished' },
        delivery_id: 'delivery-1',
      }), LEASE_TAKEN_AT);
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

    /** Splice a drain into the live turn as the reactor does; the step boundary absorbs it. */
    async function spliceDrain(
      harness: ActorHarness<HarnessOrchestratorAgent>, replyTurnId: string,
    ): Promise<void> {
      await harness.agent.declareTurnInFlight(true);

      const inbox = harness.agent.observeOrch().inbox;
      expect(await inbox.send({ kind: 'event_drain', text: 'a build finished', replyTurnId }))
        .toBe('mid-turn');
      await inbox.prepareStep({ stepNumber: 0, messages: [] });
    }

    test('a spliced drain settles once, and the activation sweep will not redeliver it', async () => {
      const harness = orchestratorHarness();
      boundDelivery(harness, 'evt-spliced');
      await spliceDrain(harness, 'evt-spliced');

      await chatSessionTurns(harness.agent).settle({ messageId: 'a-1', text: 'the answer', requestId: 'req-spliced' });

      // Answered: lease closed, binding kept, so no drain selects it again.
      expect(await settledLease(harness)).toEqual({ turn_id: 'evt-spliced', consumed_at: null });
      expect(harness.db.query(
        `SELECT COUNT(*) AS n FROM agent_log WHERE kind = 'event' AND consumed_at IS NOT NULL`,
      ).get()).toMatchObject({ n: 0 });
    });

    test('a reply that fails mid-dispatch stays owed with that failure, not as an open channel', async () => {
      const harness = orchestratorHarness();
      const actorId = harness.agent.observeRuntime().actor.actorId;
      boundDelivery(harness, 'evt-mail');
      // A mail on the same drain, with its thread still open: the answer owes it a reply.
      harness.db.prepare(
        `INSERT INTO agent_log
           (actor_id, id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
            trust, priority, payload_visibility, payload, received_at,
            schema_version, dedupe_key, consumed_at)
         VALUES (?, 'ev-mail', 'event', 'evt-mail', 0, NULL, 'tr-2', 'email_inbound', 'email',
                 'authenticated', 'normal', 'full', ?, 1, 1, NULL, ?)`,
      ).run(actorId, JSON.stringify({
        from: 'owner@example.com', to: 'agent@example.com', subject: 'the build', body_text: 'did it pass?',
        message_id: null, in_reply_to: null, references: null, attachments: [],
      }), LEASE_TAKEN_AT);
      harness.db.prepare(
        `INSERT INTO reply_channels (actor_id, id, event_id, kind, holder_addr, ttl_expires_at, created_at, updated_at)
         VALUES (?, 'ch-mail', 'ev-mail', 'email_thread', ?, ?, 1, 1)`,
      ).run(actorId, JSON.stringify({
        to: 'owner@example.com', from: 'agent@example.com', subject: 'the build', message_id: null, references: null,
      }), LEASE_TAKEN_AT + 3_600_000);
      harness.db.run(`CREATE TRIGGER refuse_reply_record BEFORE INSERT ON agent_log
        WHEN NEW.kind = 'reply_attempt' BEGIN SELECT RAISE(ABORT, 'storage refused the reply record'); END`);
      await spliceDrain(harness, 'evt-mail');

      await chatSessionTurns(harness.agent).settle({ messageId: 'a-mail', text: 'the answer', requestId: 'req-mail' });
      await harness.agent.harnessTerminalReported();
      await joinHarnessFibers();

      expect(harness.db.query(
        "SELECT status, outcome FROM terminal_effects WHERE effect_key LIKE '%:event_reply:evt-mail'",
      ).all()).toEqual([{ status: 'pending', outcome: expect.stringContaining('storage refused the reply record') }]);
    });

    test('a turn with no durable answer leaves the delivery recoverable', async () => {
      const harness = orchestratorHarness();
      boundDelivery(harness, 'evt-nodurable');
      await spliceDrain(harness, 'evt-nodurable');

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
      expect(await settledLease(harness)).toEqual({ turn_id: 'evt-nodurable', consumed_at: null });
    });

    test('a failed turn leaves the delivery recoverable', async () => {
      const harness = orchestratorHarness();
      boundDelivery(harness, 'evt-failed');
      await spliceDrain(harness, 'evt-failed');

      await chatSessionTurns(harness.agent).settle({ messageId: 'a-3', requestId: 'req-failed', status: 'error', error: 'provider exploded' });

      expect(await settledLease(harness)).toEqual({
        turn_id: 'evt-failed', consumed_at: LEASE_TAKEN_AT,
      });
    });
  });

  test('a queued drain is driven by its own words and answered by the model', async () => {
    const drained = orchestratorHarness();
    drained.agent.harnessDrivingUserMessage('the drain text', { kinuEvent: 'event_drain', drainTurnId: 'drain-1' });
    const parked = await chatSessionTurns(drained.agent).prepare({ messages: [{ role: 'user', content: 'the drain text' }] });
    expect(parked?.messages.at(-1)).toEqual({ role: 'user', content: 'the drain text' });
    await chatSessionTurns(drained.agent).settle({ messageId: 'a-9', text: 'the answer' });
    const rows = (await drained.agent.harnessTranscript.history());
    expect(rows.at(-2)).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'the drain text' }], metadata: expect.objectContaining({ drainTurnId: 'drain-1' }) });
    expect(rows.at(-1)).toMatchObject({ role: 'assistant', parts: expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'the answer' })]) });
  });

  test('standalone drain identity survives the turn\'s own continuation until reply settlement', () => {
    // The drain identity is part of the reply effect's recorded input, so it survives eviction;
    // registered for queued drains only (spliced ones are reported per absorbed signal).
    const replyEffect = source.slice(
      source.indexOf('event_reply: terminalEffect({'),
      source.indexOf('branches: terminalEffect({'),
    );

    expect(replyEffect).toContain('drainTurnId: v.string()');
    // The request id is recorded too, so a later replay re-registers under the same identity.
    expect(replyEffect).toContain('requestId: v.string()');
    expect(replyEffect).toContain('await this.completeEventBatch(drainTurnId, answer)');
    // No per-activation stash: the durable item and the recorded input are the witnesses.
    expect(actor).not.toContain('_pendingDrainReplyTurns');
    expect(source).not.toContain('_pendingDrainReplyTurns');
    expect(loop).toContain('private answeredDeliveries(item: QueueItem): ReadonlySet<string> {');
  });

  test('nothing on this backend seals a run reason of its own', () => {
    // `classifyRunEnd` owns run-end vocabulary (driven in core's unit-core-adapter-seams.test.ts);
    // a backend-picked status string once sealed a user Stop as 'error'.
    expect(loop).toContain('closeTurnRun(this.eventRecorder,');
    expect(actor).not.toContain('reason: result.status');
    expect(source).not.toContain('reason: result.status');
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
    const harness = orchestratorHarness();
    const agent = harness.agent;
    const orch = agent.observeOrch();
    const extension = orch.turnExtension;

    if (!extension.prepareStep) throw new Error('Expected turn steering prepareStep extension');

    await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'add caching to the api and update the docs' }] });
    const messages = [{ role: 'user' as const, content: 'add caching to the api and update the docs' }];
    const stepped = await extension.prepareStep({ stepNumber: 0, messages });
    const rendered = JSON.stringify(stepped ?? messages);
    expect(rendered).not.toContain('Runtime steering');
    expect(rendered).not.toContain('action=swarm');
    expect(orch.steering.snapshot()).toEqual([]);
  });


  test('pickAlternateTake returns false unless the awaited delivery actually landed', () => {
    // One core implementation both transports call.
    const pick = takePick.slice(takePick.indexOf('export async function pickAlternateTake('));
    expect(pick).toContain('let continuationQueued = false');
    expect(pick).toContain('const outcome = await deps.inbox.send');
    expect(pick).toContain("continuationQueued = outcome !== 'undelivered'");
    expect(pick).not.toContain('continuationQueued = true');
    expect(source).toContain('await pickAlternateTake(');
  });
});

describe('improvement_lanes — one verdict gates the improvement lanes', () => {
  // Driven through the claimed effect; both verdicts are one core decision (`improvementLanesOpen`).
  const NOTE = JSON.stringify({
    note: 'the staging cluster was never named', severity: 'nit', class: 'wrong-work',
  });

  const turnOf = (): CompletedTurn => ({
    userMessage: 'q', assistantResponse: 'a', toolCalls: [], durationMs: 1, steps: 1,
    hadError: false, feedback: null, turnId: 'spine-turn', sessionId: 'default', origin: 'user',
  });

  function advisorHarness() {
    const harness = orchestratorHarness();
    harness.agent.harnessAdvisorsOn(NOTE);

    return harness;
  }

  async function noLaneFor(status: 'error' | 'aborted'): Promise<void> {
    const { agent } = advisorHarness();
    await agent.harnessSettleSpine({ status, turn: turnOf() });
    expect(agent.harnessAdvisorNotes()).toBe(0);
  }

  test('a completed build turn earns its review', async () => {
    const { agent } = advisorHarness();
    await agent.harnessSettleSpine({ status: 'completed', turn: turnOf() });
    // The review rides a detached durable fiber; join them rather than guessing at the clock.
    await agent.harnessJoinDetachedFibers();
    expect(agent.harnessAdvisorNotes()).toBe(1);
  });

  test('a FAILED build turn feeds no lane', () => noLaneFor('error'));

  test('a completed PLAN turn feeds no lane', async () => {
    const { agent } = advisorHarness();
    agent.observeOrch().beginTurn(Date.now(), { kinuMode: 'plan' });
    // The effect reads the mode from its row: a cold replay has no live turn, and defaulting to build leaks plans.
    await agent.harnessSettleSpine({ status: 'completed', turn: turnOf(), workMode: 'plan' });
    expect(agent.harnessAdvisorNotes()).toBe(0);
  });

  test('an ABORTED build turn feeds no lane', () => noLaneFor('aborted'));
});

/**
 * Shadow trials hit the live tool surface, so their claims are keyed on the rollout scope: the ambient
 * turn is the last checkpoint while queued and `_workspace` after the isolate dies.
 */
describe('a recoverable rollout claims its tool calls on the rollout', () => {
  /** A claimed capability on this actor's own storage, observable without a network. */
  const RECALL = { action: 'recall', key: 'trial-probe' };

  test('the scope is the claim identity, not whatever turn is ambient', async () => {
    const harness = orchestratorHarness();
    const live = await chatSessionTurns(harness.agent).prepare({ messages: [{ role: 'user', content: 'the live turn' }] });

    await harness.agent.harnessScaffoldCallTool('trial-7')('memory', RECALL);

    expect(harness.agent.harnessToolClaims('trial-7')).toEqual(['trial-7#0']);
    expect(harness.agent.harnessToolClaims(live.identity.turnId)).toEqual([]);
    expect(harness.agent.harnessToolClaims(WORKSPACE_RUN_ID)).toEqual([]);
  });

  /** Defends: a cold replay after the world moved must answer from the first attempt's row. */
  test('a cold replay is answered from the first attempt row', async () => {
    const harness = orchestratorHarness();
    await chatSessionTurns(harness.agent).prepare({ messages: [{ role: 'user', content: 'the live turn' }] });
    harness.agent.harnessFacts().upsert('trial-probe', 'as the trial saw it');
    const first = await harness.agent.harnessScaffoldCallTool('trial-7')('memory', RECALL);

    harness.agent.harnessFacts().upsert('trial-probe', 'as the world moved on');
    const restarted = await reactivateOrchestratorHarness(harness.db);
    const replay = await restarted.agent.harnessScaffoldCallTool('trial-7')('memory', RECALL);

    expect(replay).toEqual(first);
    expect(restarted.agent.harnessToolClaims('trial-7')).toEqual(['trial-7#0']);
  });

  /** An unscoped rollout (live preview, GEPA candidate) is never re-driven, so it keeps the ambient turn. */
  test('an unscoped rollout still claims against the live turn', async () => {
    const harness = orchestratorHarness();
    const live = await chatSessionTurns(harness.agent).prepare({ messages: [{ role: 'user', content: 'the live turn' }] });

    await harness.agent.harnessScaffoldCallTool()('memory', RECALL);

    expect(harness.agent.harnessToolClaims(live.identity.turnId)).toHaveLength(1);
    expect(harness.agent.harnessToolClaims(WORKSPACE_RUN_ID)).toHaveLength(0);
  });
});
