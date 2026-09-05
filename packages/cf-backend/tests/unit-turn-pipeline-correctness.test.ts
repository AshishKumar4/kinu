import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memberBody, toolExecute } from '@kinu.run/test-utils';
import { WORKSPACE_RUN_ID, type CompletedTurn } from '@kinu.run/core';
import {
  orchestratorHarness, reactivateOrchestratorHarness,
  type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import type { ModelMessage, ToolSet, UIMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { PrepareStepContext } from '@cloudflare/think';
import * as v from 'valibot';

/** The provider handle a live streamText also passes. `beforeStep` forwards
 *  only `stepNumber` and `messages` to the shared pipeline, so this is supplied
 *  as the model a step carries rather than asserted away. */
const STEP_MODEL = new MockLanguageModelV3();

/** The override half of a `PrepareStepResult`. `v.custom` keeps the element
 *  type without restating the SDK's message union. */
const StepOverrideSchema = v.object({
  messages: v.array(v.custom<ModelMessage>(() => true)),
});

/**
 * The messages one step actually carries, driven through the real Think hook.
 *
 * Awaited: the shared pipeline is promoted to a Promise whenever a registered
 * extension must finish I/O before the model sees its rewrite, and this actor
 * registers three. Reading the result synchronously takes a pending Promise for
 * "nothing changed" and silently passes the input back.
 */
async function stepMessages(
  agent: HarnessOrchestratorAgent, stepNumber: number, messages: ModelMessage[],
): Promise<ModelMessage[]> {
  const context: PrepareStepContext = {
    stepNumber, messages, steps: [], model: STEP_MODEL, experimental_context: undefined,
  };
  const rewritten = v.safeParse(StepOverrideSchema, await agent.beforeStep(context));
  return rewritten.success ? rewritten.output.messages : messages;
}

/** The turn-local block the ledger weaves into every step's request. */
function isDynamicContextBlock(message: ModelMessage): boolean {
  if (message.role !== 'user') return false;
  const { content } = message;
  return !Array.isArray(content) && content.includes('<dynamic_context');
}

/** No `TasksToolProbeSchema` here: `v.function()` erases the SIGNATURE, so a
 *  hand-driven `execute(input)` compiled with the SDK's `options` argument
 *  missing and only failed at runtime, inside the effect-claim wrapper reading
 *  `options.toolCallId`. `toolExecute` is the typed drive every other suite uses
 *  and it supplies the canonical `ToolExecutionOptions`, which is what the SDK
 *  hands a tool in production. */
const RoleResultSchema = v.object({ role: v.string() });

// The turn pipeline is split across the actor substrate (actor-agent.ts —
// beforeTurn assembly, the BackendHost, the event-injection machinery) and
// the orchestrator (onChatResponse sequencing, schema, callables).
const actor = readFileSync(join(import.meta.dir, '..', 'src', 'actor-agent.ts'), 'utf8');
const source = readFileSync(join(import.meta.dir, '..', 'src', 'orchestrator.ts'), 'utf8');
const headRuntime = readFileSync(join(import.meta.dir, '..', 'src', 'head-runtime.ts'), 'utf8');
const takePick = readFileSync(join(import.meta.dir, '..', '..', 'core', 'src', 'read-models', 'evolution-views.ts'), 'utf8');
const exploration = readFileSync(join(import.meta.dir, '..', 'src', 'exploration.ts'), 'utf8');
const facetSpawn = readFileSync(join(import.meta.dir, '..', 'src', 'facet-spawn.ts'), 'utf8');
const ownedModelServices = readFileSync(join(import.meta.dir, '..', 'src', 'owned-model-services.ts'), 'utf8');
const mergePolicy = readFileSync(join(import.meta.dir, '..', '..', 'core', 'src', 'heads', 'merge-policy.ts'), 'utf8');

/** Every cf-backend source that turns a reasoning-effort level into provider
 *  options. Core owns the function; this names its callers, so a second
 *  derivation added anywhere in the backend shows up as a new entry. */
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

describe('turn-pipeline correctness wiring', () => {
  test('the turn prompt carries the loaded SOUL', async () => {
    // `beforeTurn` refreshes the soul only when nothing is cached, so the
    // observed text is the one the turn renders.
    const harness = orchestratorHarness();
    const agent = harness.agent;
    agent.setObservedSoul('You are Atlas. Preserve the owner\'s exact requirements.');

    const config = await agent.beforeTurn({
      system: 'sys',
      messages: [{ role: 'user', content: 'summarise this file' }],
      tools: {} satisfies ToolSet,
      model: 'harness-model',
      continuation: false,
      body: {},
    });

    expect(config?.system ?? '').toContain('You are Atlas. Preserve the owner\'s exact requirements.');
  });

  test('client RPC policy runs before SDK dispatch and defaults to allow', () => {
    const constructor = actor.slice(
      actor.indexOf('constructor(ctx: AgentContext, env: Env)'),
      actor.indexOf('/** The settled turn\'s actor-generic front half'),
    );
    const policy = constructor.indexOf('this.isClientRpcMethodDenied(rpc.method)');
    const dispatch = constructor.indexOf('await dispatchMessage.call');
    expect(actor).toContain('protected isClientRpcMethodDenied(_method: string): boolean { return false; }');
    expect(policy).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(policy);
    expect(constructor).toContain("type: 'rpc'");
    expect(constructor).toContain('success: false');
  });

  test('the admission count and the submitted model resolve ONE spec, not two', () => {
    // The counter picks a provider by parsing the profile tier's spec; the model
    // actually submitted comes from `resolveModel`, which NORMALISES first. So
    // parsing the raw spec keyed the count on a different answer for exactly the
    // forms normalisation exists to accept — a bare model id has no slash and
    // `parseModelSpec` throws on it inside turn assembly, and a bare `@cf/…`
    // parses to provider `@cf`, which no registry knows.
    //
    // A source pin because the rule is an AGREEMENT BETWEEN TWO CALL SITES: no
    // behavioural test can state it without a turn harness that captures which
    // provider was asked for a count, and the harness has no such seam. The
    // property each site upholds alone is checked in unit-agent-registry.
    const beforeTurn = memberBody(actor, 'async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void>');
    expect(beforeTurn).toContain('parseModelSpec(providers.normalizeSpecSync(profile.tier.model))');
    expect(beforeTurn).not.toContain('parseModelSpec(profile.tier.model)');
  });

  test('facet-spawned heads inherit the registered parent workspace identity', () => {
    // The root's own split seeds the child with the REGISTERED workspace, never
    // this actor's own DO name — the file plane is keyed by it, so a self-named
    // head derives a second, empty filesystem.
    const rootRuntime = memberBody(actor, 'protected getCFHeadRuntime()');
    expect(rootRuntime).toContain('sharedParent: this.workspaceName()');
    expect(rootRuntime).not.toContain('sharedParent: this.name');
    // A recursive split re-uses the ROOT it was given, never its own facet name.
    expect(exploration).toContain('sharedParent: this.identity.parentWorkspace()');
    // The spawn seam is what turns that into the child facet's persisted parent.
    expect(facetSpawn).toContain('await stub.setSharedParent(identity.sharedParent)');
    // One factory for both, so there is exactly one place the seed can be wrong —
    // and it resolves the identity per spawn rather than baking in a stale token.
    expect(headRuntime).toContain('identity: () => Promise<ExplorationFacetIdentity>');
    expect(headRuntime).toContain('spawnHeadFacet(deps.host, input, await deps.identity())');
    // The actor's own model services, not a second provider registry.
    expect(headRuntime).not.toContain('createAgentProviderRegistry');
  });

  test('the head runtime constructor receives this actor\'s operation sink', () => {
    // A head's non-turn calls (its merge synthesis, its inference) must land
    // in the ROOT's operation ledger — the actor hands over the one sink it
    // holds, so the rows cannot strand in facet SQLite.
    const rootRuntime = memberBody(actor, 'protected getCFHeadRuntime()');
    expect(rootRuntime).toContain('operations: this.modelOperations');
    expect(headRuntime).toContain('operations?: ModelOperationSink');
  });

  test('the agents swarm substrate is built as an ANNOTATED AgentsForkDeps, with no strategy objects', () => {
    // The fork action is gone. Each backend builds the typed swarm substrate
    // directly, with no pass-through wrapper and no dormant strategy objects.
    //
    // The annotation is load-bearing, not style: `gate:wired` attributes a
    // field supply by the WRITTEN type on the literal, and it does not descend
    // into a nested one. Built inline under `fork:` the substrate's own optional
    // wires — `nodeHost`, `compactShared` — were supplied here and reported as
    // supplied by nobody, which is how a live wire looks identical to a missing
    // one. So the shape this asserts is the shape that stays measurable.
    const depsBody = memberBody(actor, 'private getAgentsToolDeps(workMode: WorkMode)');
    expect(depsBody).toContain('const fork: AgentsForkDeps = {');
    expect(depsBody).toContain('resolveModel:');
    expect(depsBody).toContain('nodeHost:');
    expect(depsBody).toContain('compactShared:');
    expect(depsBody).not.toContain('mcts:');
    expect(depsBody).not.toContain('heads:');
    expect(actor).not.toContain('defaultOptions');
  });

  test('the MEMORY.md tail is read once per turn and rides the per-step dynamic block', () => {
    // Parity with the CLI: the reflection loop assumes the model sees its
    // newest lessons in-turn. The tail is the ONE dynamic-context input behind
    // an await, so it is sourced once at turn assembly and closed over by the
    // per-step snapshot — never rendered into the cacheable prefix.
    const assembleIdx = actor.indexOf('cfg.messages = await assembleTurnMessages(assembly)');
    const sourceIdx = actor.indexOf('this._turnMemoryTail = await readMemoryTail(this.rt.memory)');
    expect(assembleIdx).toBeGreaterThan(-1);
    expect(sourceIdx).toBeGreaterThan(-1);
    expect(sourceIdx).toBeLessThan(assembleIdx);
    // Everything else the block carries is now read live inside core, at the
    // step the snapshot is called: WHICH planes exist is agentDynamicContext's
    // (pinned in core's unit-volatile-context.test.ts) and WHICH STORE feeds
    // each is collectDynamicContext's (pinned behaviourally, per plane, in
    // core's unit-dynamic-context-binding.test.ts). What is left here is the
    // two inputs only this backend knows.
    const snapshot = actor.slice(
      actor.indexOf('protected dynamicContextSnapshot(): DynamicContext {'),
      actor.indexOf('beforeStep(ctx: PrepareStepContext)'),
    );
    expect(snapshot).toContain('collectDynamicContext({');
    expect(snapshot).toContain('memoryTail: this._turnMemoryTail');
    expect(snapshot).toContain('...this._mcpUnavailable');
    // Passed, not re-derived: a backend that rebuilt its own store handles here
    // would be back to stating the binding twice.
    expect(snapshot).toContain('stores: this.stores');
  });

  test('the dynamic-context ledger rides the shared STEP pipeline, not the turn assembly', async () => {
    // Per-step, because the state it carries changes mid-turn: a job detaches,
    // a sandbox comes up, a consent card lands. Assembling it once per turn
    // would show the model a snapshot that is already stale by step 2 — and a
    // prepareStep override never feeds the next step's input, so a block woven
    // at turn assembly would be gone from every request after the first.
    //
    // Driven rather than read: `beforeStep` is the hook streamText calls, and
    // the two facts here — the block is absent from what the step is HANDED and
    // present in what it CARRIES, on every step — are the operational content of
    // "per step, not per turn". A source scan for the wiring cannot tell a live
    // weave from a dead one.
    const { agent } = orchestratorHarness();
    const handed: ModelMessage[] = [{ role: 'user', content: 'deploy the api' }];

    expect(handed.filter(isDynamicContextBlock)).toHaveLength(0);
    expect((await stepMessages(agent, 0, handed)).filter(isDynamicContextBlock)).toHaveLength(1);
    expect((await stepMessages(agent, 4, handed)).filter(isDynamicContextBlock)).toHaveLength(1);
  });

  test('beforeTurn merges profile reasoning effort with cache provider options', () => {
    const beforeTurn = actor.slice(
      actor.indexOf('async beforeTurn(ctx: TurnContext)'),
      actor.indexOf('beforeStep(ctx: PrepareStepContext)'),
    );
    expect(beforeTurn).toContain('profile.tier.reasoningEffort');
    // Was `parseModelSpec(profile.tier.model).provider` — a RAW parse, and the
    // second of two in this method. Reasoning options for a provider spelled
    // `@cf` reach a provider no registry knows, and a bare model id threw here.
    // Both sites now read the one normalised parse.
    expect(beforeTurn).toContain('tierModel.provider');
    expect(beforeTurn).not.toContain('parseModelSpec(profile.tier.model)');
    expect(beforeTurn).toContain('reasoningEffortOptions');
    expect(beforeTurn).toContain('mergeProviderOptions(cacheOptions, reasoningOptions)');
    expect(beforeTurn).toContain('cfg.providerOptions = providerOptions');
    expect(beforeTurn).toContain('lastTurnOpts.providerOptions = providerOptions');
  });

  // Output caps are not asserted per seam here: the gate below owns that rule
  // for every production source at once, and a second, weaker copy of it beside
  // four hand-picked files is the drift that gate exists to prevent.
  test('provider-agnostic auxiliary calls take their effort from the route, not a constant', () => {
    // Low effort is no longer DERIVED here. Every auxiliary caller asks the
    // shared owner-scoped services for it, and those services are the single
    // place that turns an effort level into provider options.
    expect(exploration).not.toContain('reasoningEffortOptions');
    // And no auxiliary caller NAMES an effort any more. `'low'` was a second
    // decision sitting beside a routed model: the tier that chose the model
    // already chose how hard to run it, and a constant here overrode it. The
    // two askers in this file — the MCTS rollout and the pruned-branch
    // reflection — both read `route.reasoningEffort` now.
    expect(exploration).not.toMatch(/resolveModelWithEffort\([^)]*'(low|medium|high)'\)/);
    expect(exploration.match(/resolveModelWithEffort\(\s*\n?\s*route\.model, route\.reasoningEffort,?\s*\n?\s*\)/g)?.length).toBe(2);
    expect(ownedModelServices.match(/reasoningEffortOptions\(/g)?.length).toBe(1);
    expect(headRuntime).not.toContain('reasoningEffortOptions');
    // The merge's ROUTE is no longer decided in this backend at all — core's
    // `headMergeLLM` resolves `judge` and the tier's own effort, and both
    // backends call it, which is what stops the local merge from running the
    // session's chat model at a constant while filing `judge` spend. So the
    // route lookup and the spend label must be there and NOT here.
    expect(mergePolicy).toContain("const HEAD_MERGE_SOURCE = 'judge'");
    expect(mergePolicy).toContain('resolveModelRoute(HEAD_MERGE_SOURCE, profile)');
    expect(headRuntime).not.toContain('resolveModelRoute');
    // What is left here is the one backend-local decision: binding the routed
    // pair through the OWNER's provider registry. Effort still comes from the
    // resolution, never from a constant beside it.
    expect(headRuntime).toContain('bindMergeModel: (route) => deps.models.resolveModelWithEffort(');
    expect(headRuntime).toContain('route.model, route.reasoningEffort,');
    // Chat and all auxiliary profile lanes derive provider options at the
    // point where their resolved concrete model is known.
    expect(effortDerivationSites()).toEqual([
      'actor-agent.ts',
      'owned-model-services.ts',
      'runtime.ts',
    ]);

    // The shadow eval's judge is the control plane's, and the plane builds it
    // over the cross-family REVIEW model at the judge stage's own effort. The
    // actor used to build a second judge here carrying provider options derived
    // from the CHAT model's family — options a review model on a different
    // provider cannot apply — so the effort is no longer named at this seam.
    const control = actor.slice(
      actor.indexOf('protected get scaffoldControl()'),
      actor.indexOf("/** The scaffold's host.llmStream bridge"),
    );
    expect(control).toContain('judge: createJsonJudge(() => this.getModelForReview())');
    expect(control).not.toContain('reasoningEffortOptions');
  });

  // Owner directive: output caps are the wrong mechanism entirely — a reasoning
  // model spends its budget thinking before it emits anything, so a cap
  // truncates or starves the answer. Cost is controlled by reasoning effort,
  // and completion length is the model's, bounded by the provider. So it is not
  // only the hardcoded literal that is gone: no production source NAMES the
  // field, and no config supplies one — `LLMProviderConfig.maxTokens`,
  // `generateJson`'s cap option and `StrategyBudget.maxOutputTokens` were the
  // three sources, and all three were deleted rather than defaulted.
  //
  // Where the field still legitimately exists is inside a provider adapter that
  // must send it: Anthropic's Messages API requires `max_tokens`, and
  // `@ai-sdk/anthropic` fills it with the resolved MODEL's own maximum when the
  // caller sets nothing (dist/index.mjs, `maxOutputTokens != null ? … :
  // maxOutputTokensForModel`). That is the provider bounding the completion,
  // which is exactly the arrangement this gate protects — and it lives in the
  // adapter, never here.
  //
  // `maxOutputTokens` means exactly one thing in this repo and this gate is why:
  // an output cap on a model REQUEST. Context admission reserves the resolved
  // model's answer allowance under its own name (`ModelWindow.modelOutputLimit`,
  // prompting/step-prune.ts) precisely so this stays strict — a second meaning
  // for the same identifier would have needed an exception here, and an
  // exception in a gate is the gate.
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

  test('CHAT_CLEAR resets the dynamic-context ledger and durable compaction plan after Think handles it', () => {
    const constructor = actor.slice(
      actor.indexOf('constructor(ctx: AgentContext, env: Env)'),
      actor.indexOf('/** The settled turn\'s actor-generic front half'),
    );
    const dispatch = constructor.indexOf('await dispatchMessage.call');
    const reset = constructor.indexOf('this.dynamicLedger.reset()');
    const clearPlan = constructor.indexOf('this.compactionState.plans.save(this.name, null)');
    expect(constructor).toContain('parseProtocolMessage(message)');
    expect(constructor).toContain("event?.type === 'clear'");
    expect(dispatch).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(dispatch);
    expect(clearPlan).toBeGreaterThan(reset);
  });

  test('the settle spine runs FIRST and hands the turn status to the one delivery seam', () => {
    // What the aborted turn does with absorbed/leftover signals is core's
    // (SignalDelivery.settle — behaviourally pinned in core's
    // unit-signals.test.ts). What THIS backend must do is call the spine before
    // anything that can throw or return early, and tell it how the turn ended.
    const hook = source.slice(source.indexOf('async onChatResponse(result: ChatResponseResult)'));
    const preEarlyReturn = hook.slice(0, hook.indexOf('if (result.status !== "completed")'));
    expect(preEarlyReturn).toContain('this.settleTurnEvents(result)');
    const helper = actor.slice(actor.indexOf('protected settleTurnEvents(result: ChatResponseResult)'));
    expect(helper).toContain('this.orch.signals.settle({ completed })');
    // No second re-delivery path on this side — the seam owns it.
    expect(actor).not.toContain('reenqueue');
  });

  test('an INTERRUPTED turn is complete through every reader, with no mirror write', async () => {
    // The bug the operator hit: he forked from a message the chat pane was
    // showing and got `fork point not found`, because every reader but the
    // fork cut read the `messages` projection, and the projection skipped
    // anything that had not been reconciled. The readers now go through the
    // canonical conversation store — the SDK's own transcript — so nothing
    // may be written into `messages` for the default chat, and the
    // interrupted turn must still be served by the paged history read.
    const harness = orchestratorHarness();
    harness.db.exec(`CREATE TABLE IF NOT EXISTS assistant_messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT '', parent_id TEXT,
      role TEXT NOT NULL, content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    const append = harness.db.prepare(
      `INSERT INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
       VALUES (?, '', ?, ?, ?, '2026-08-16 22:05:00')`,
    );
    append.run('u-live', null, 'user', JSON.stringify({
      id: 'u-live', role: 'user', parts: [{ type: 'text', text: 'do the thing' }],
    }));
    append.run('a-live', 'u-live', 'assistant', JSON.stringify({
      id: 'a-live', role: 'assistant', parts: [{ type: 'text', text: 'partial answer' }],
    }));

    const message: UIMessage = {
      id: 'a-live', role: 'assistant', parts: [{ type: 'text', text: 'partial answer' }],
    };
    await harness.agent.onChatResponse({
      message, requestId: 'req-interrupted', continuation: false, status: 'aborted',
    });

    // No projection row anywhere.
    const mirrored = harness.db.prepare<{ c: number }, []>(
      `SELECT COUNT(*) AS c FROM messages WHERE session_id = 'default'`,
    ).get();
    expect(mirrored?.c).toBe(0);

    // The paged history read serves the interrupted turn straight from the
    // authority, text flattened, edges intact.
    const page = await harness.agent.getChatHistoryPage({ limit: 10 });
    expect(page.items.map((entry) => entry.id)).toEqual(['u-live', 'a-live']);
    expect(page.items[1]!.content).toBe('partial answer');
  });

  test('an ABORTED turn is still recorded as evidence', async () => {
    // The drift this closes: `onChatResponse` early-returned on any status but
    // 'completed', so a failed cloud turn reached neither the outcome-review
    // buffer nor `extensions.onTurnEnd`, while the identical turn on the CLI
    // reached both. Failures are the most informative evidence the evolution
    // loop has, and the comment justifying that early return covered only the
    // alternate-takes purge beside it. Core's terminal roster is the one
    // declaration now, and it owes `turn_end_extensions` before `turn_record` on
    // every status; the ordering half is core's (unit-core-adapter-seams pins
    // it), so what THIS asserts is the half that was unprovable here — the
    // durable row.
    const harness = orchestratorHarness();
    // What `beforeTurn` establishes for a turn with no durable identity: this
    // session records evolution state, and the settled response carries that
    // fact into the recording rather than asking the host that recovers it.
    harness.agent.declareTurnEvolutionGate();

    await harness.agent.onChatResponse({
      message: {
        id: 'a-cut', role: 'assistant', parts: [{ type: 'text', text: 'partial' }],
      } satisfies UIMessage,
      requestId: 'req-cut', continuation: false, status: 'aborted',
    });

    // The outcome-review buffer core's recordTurn appends to, and the turn's own
    // partial answer inside it — a row for some other turn would pass a bare
    // count.
    const recorded = harness.db.prepare<{ turn: string }, []>(
      `SELECT turn FROM completed_turns`,
    ).all();
    expect(recorded, 'an aborted turn left no evidence row').toHaveLength(1);
    expect(recorded[0]!.turn).toContain('partial');
  });

  // The credit decision, behaviourally, on this backend. Core's
  // `creditedTurnId` decides it for both; what THIS suite pins is that the
  // orchestrator asks it and honours the answer.
  //
  // The plan case is a BEHAVIOUR CHANGE, recorded as one: a completed plan turn
  // used to claim its mid-turn takes here, because the only guard was
  // `status === 'completed'` plus a message id. The CLI already excluded plan
  // mode; a plan is not an answer the captures competed against.
  describe('mid-turn captures are credited to the turn only when it answered', () => {
    /** One take set captured mid-turn: written unclaimed, stamped inside the
     *  claiming turn's window (the scoped claim drops anything older). The
     *  workspace schema the harness already ran owns the table. */
    function settleOneTurn(mode: 'plan' | 'build'): ActorHarness<HarnessOrchestratorAgent> {
      const harness = orchestratorHarness();
      harness.db.prepare(
        `INSERT INTO alternate_takes
           (id, turn_id, session_id, task, source, winner_node_id, chosen_node_id,
            candidates, created_at, picked_at)
         VALUES ('take-1', NULL, NULL, 'pick a strategy', 'mcts', 'win', NULL, ?, ?, NULL)`,
      ).run(
        JSON.stringify([
          { nodeId: 'win', text: 'go with approach A', score: 0.9, visits: 3, depth: 1 },
          { nodeId: 'alt', text: 'go with approach B', score: 0.86, visits: 2, depth: 1 },
        ]),
        Date.now() + 1_000,
      );
      if (!Reflect.set(harness.agent, '_cachedMessages', [{
        id: 'u-1', role: 'user', parts: [{ type: 'text', text: `${mode} this` }],
        metadata: { kinuMode: mode },
      }])) throw new Error('failed to seed the harness message array');
      return harness;
    }

    const settled: UIMessage = {
      id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: 'the answer' }],
    };

    test('a completed build turn claims them', async () => {
      const harness = settleOneTurn('build');
      await harness.agent.onChatResponse({
        message: settled, requestId: 'req-build', continuation: false, status: 'completed',
      });
      expect(harness.db.query('SELECT turn_id, session_id FROM alternate_takes').get())
        .toMatchObject({ turn_id: 'a-1', session_id: 'default' });
    });

    test('a completed PLAN turn purges them', async () => {
      const harness = settleOneTurn('plan');
      await harness.agent.onChatResponse({
        message: settled, requestId: 'req-plan', continuation: false, status: 'completed',
      });
      expect(harness.db.query('SELECT COUNT(*) AS n FROM alternate_takes').get())
        .toMatchObject({ n: 0 });
    });
  });

  // A delivery's recovery lease says "a running turn still owes this an
  // answer", and `onStart`'s sweep re-pends every lease it finds open. So the
  // settle has to close the lease for EVERY way a drain reaches a turn, and
  // only when the turn's answer is durable — otherwise the sweep either
  // re-delivers an answered event or abandons an unanswered one.
  describe('a settled turn closes the delivery leases it answered, and only those', () => {
    /**
     * When the lease was taken. A LIVE stamp, not a literal: the activation
     * reconcile sweeps leases stranded past a grace, so a 1970 stamp would make
     * every case measure the sweep instead of the closure. unit-durable-terminal
     * uses the same shape for the same reason.
     */
    const LEASE_TAKEN_AT = Date.now();

    /** One admitted event, bound to `turnId` with its recovery lease OPEN —
     *  what a drain leaves behind on its way to the turn. */
    function boundDelivery(harness: ActorHarness<HarnessOrchestratorAgent>, turnId: string): void {
      harness.db.prepare(
        `INSERT INTO agent_log
           (id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
            trust, priority, payload_visibility, payload, received_at,
            schema_version, dedupe_key, consumed_at)
         VALUES ('ev-1', 'event', ?, 0, NULL, 'tr-1', 'webhook_bearer', 'webhook',
                 'authenticated', 'normal', 'full', ?, 1, 1, NULL, ?)`,
      ).run(turnId, JSON.stringify({
        webhook_id: 'hook-1',
        http_method: 'POST',
        http_headers: { 'content-type': 'application/json' },
        body: { text: 'a build finished' },
        delivery_id: 'delivery-1',
      }), LEASE_TAKEN_AT);
    }

    /** The lease once every owed effect of the turn has reported. The write is
     *  the tail of a detached dispatch, so reading the row synchronously would
     *  pin the absence of a guarantee nobody makes. Bounded, so the two
     *  recoverable cases — where it must NEVER close — still fail loudly. */
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

    /** Splice a drain into the live turn, exactly as the reactor does: the seam
     *  routes on `turnInFlight`, and the step boundary is what absorbs it. */
    async function spliceDrain(
      harness: ActorHarness<HarnessOrchestratorAgent>, replyTurnId: string,
    ): Promise<void> {
      if (!Reflect.set(harness.agent, '_inFlight', true)) {
        throw new Error('failed to put the harness actor in a turn');
      }
      const signals = harness.agent.observeOrch().signals;
      expect(await signals.deliver({ kind: 'event_drain', text: 'a build finished', replyTurnId }))
        .toBe('mid-turn');
      signals.prepareStep({ stepNumber: 0, messages: [] });
    }

    test('a spliced drain settles once, and the activation sweep will not redeliver it', async () => {
      const harness = orchestratorHarness();
      boundDelivery(harness, 'evt-spliced');
      await spliceDrain(harness, 'evt-spliced');

      await harness.agent.onChatResponse({
        message: { id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: 'the answer' }] },
        requestId: 'req-spliced', continuation: false, status: 'completed',
      });

      // Answered: the lease is closed and the BINDING is kept, so no drain can
      // select it again either.
      expect(await settledLease(harness)).toEqual({ turn_id: 'evt-spliced', consumed_at: null });
      // What the next activation's sweep would take: nothing.
      expect(harness.db.query(
        `SELECT COUNT(*) AS n FROM agent_log WHERE kind = 'event' AND consumed_at IS NOT NULL`,
      ).get()).toMatchObject({ n: 0 });
    });

    test('a turn with no durable answer leaves the delivery recoverable', async () => {
      const harness = orchestratorHarness();
      boundDelivery(harness, 'evt-nodurable');
      await spliceDrain(harness, 'evt-nodurable');

      // Think reported a completed stream, but no assistant row carries the
      // answer — a later activation reads this turn back as never having
      // happened, so the delivery is still owed.
      await harness.agent.onChatResponse({
        message: { id: '', role: 'assistant', parts: [{ type: 'text', text: 'the answer' }] },
        requestId: 'req-nodurable', continuation: false, status: 'completed',
      });

      expect(await settledLease(harness)).toEqual({
        turn_id: 'evt-nodurable', consumed_at: LEASE_TAKEN_AT,
      });
    });

    test('a failed turn leaves the delivery recoverable', async () => {
      const harness = orchestratorHarness();
      boundDelivery(harness, 'evt-failed');
      await spliceDrain(harness, 'evt-failed');

      await harness.agent.onChatResponse({
        message: { id: 'a-3', role: 'assistant', parts: [] },
        requestId: 'req-failed', continuation: false, status: 'error', error: 'provider exploded',
      });

      expect(await settledLease(harness)).toEqual({
        turn_id: 'evt-failed', consumed_at: LEASE_TAKEN_AT,
      });
    });
  });

  test('programmatic turns succeed only after Think completes the turn and keep their own drain identity', () => {
    const host = actor.slice(
      actor.indexOf('protected get host(): BackendHost'),
      actor.indexOf('/** Executors whose tools ran this turn'),
    );
    expect(host).toContain("result.status === 'completed' ? 'queued' : 'skipped'");
    expect(host).toContain('this._activeDrainTurnId = drainTurnId');
    expect(host).toContain('this._activeProgrammaticUserMessage = message');
    expect(host).toContain('finally {');
    expect(host).toContain('this._activeProgrammaticUserMessage === message');
    const settle = actor.slice(actor.indexOf('protected settleTurnEvents(result: ChatResponseResult)'));
    // Three sources for one identity, and the third is what a DURABLY ADMITTED
    // drain needs: the activation that runs it is not the one that submitted it,
    // so it holds neither the stash nor the re-delivery entry, and the only
    // remaining witness is the `drainTurnId` the enqueue seam persisted on the
    // driving message.
    expect(settle).toContain('this._activeDrainTurnId');
    expect(settle).toContain('this._pendingDrainReplyTurns.get(result.requestId)');
    expect(settle).toContain('this.turnDrainTurnId()');
    const response = source.slice(source.indexOf('async onChatResponse(result: ChatResponseResult)'));
    expect(response).toContain('const lastUserMsg = programmaticUserMessage ??');
    expect(response).not.toContain('metadata.drainTurnId');
  });

  test('delivery leases close only after reply dispatch completes', () => {
    const helper = source.slice(
      source.indexOf('private async completeEventBatch'),
      source.indexOf('private _engine: EvolutionEngine | null = null;'),
    );
    expect(helper.indexOf('await dispatchEmailRepliesForTurn')).toBeGreaterThan(-1);
    expect(helper).toContain('if (replies.pending)');
    expect(helper).toContain('return false');
    expect(helper.indexOf('this.eventLog.markTurnCompleted')).toBeGreaterThan(
      helper.indexOf('await dispatchEmailRepliesForTurn'),
    );
  });

  test('standalone drain identity survives Think auto-continuations until reply settlement', () => {
    // The reply is one CLAIMED terminal effect now, so the identity bookkeeping
    // lives in that effect's body rather than inline in the response hook — which
    // is also what makes it survive an eviction rather than only a continuation.
    const replyEffect = source.slice(
      source.indexOf('event_reply: terminalEffect({'),
      source.indexOf('branches: terminalEffect({'),
    );
    // Registered for the QUEUED drain only: that identity has to outlive an
    // auto-continuation, while a spliced one is reported afresh on every
    // absorbed signal and has nothing to carry forward.
    expect(replyEffect).toContain('this._pendingDrainReplyTurns.set(requestId, drainTurnId)');
    expect(replyEffect).toContain('this._pendingDrainReplyTurns.delete(requestId)');
    // The request id is part of the RECORDED input, so a replay on a later
    // activation re-registers under the same identity instead of inventing one.
    expect(replyEffect).toContain('requestId: v.string()');
    const clear = actor.slice(
      actor.indexOf('constructor(ctx: AgentContext, env: Env)'),
      actor.indexOf('/** The settled turn\'s actor-generic front half'),
    );
    expect(clear).toContain('this._pendingDrainReplyTurns.clear()');
  });

  test('activation classifies owed deliveries; only the durable wake dispatches', () => {
    // Activation asks ONE predicate and arms one row…
    const onStart = memberBody(source, 'async onStart(): Promise<void>', 'orchestrator.ts');
    expect(onStart).toContain('sweepsTruncated || this.owedWorkExists()');
    expect(onStart).toContain('this.scheduleTerminalRetry(Date.now())');

    // …and that predicate is EXISTENCE READS AND NOTHING ELSE — the init ruling
    // covers spawned work too, so the lease join, the stale sweep and every
    // dispatch belong to the wake's frame. Behaviour:
    // unit-durable-terminal-recovery.test.ts drives an activation over an owed
    // lease and asserts both halves — the classification answers true and the
    // lease is untouched until the tick runs.
    const classify = memberBody(
      source, 'protected owedWorkExists(): boolean', 'orchestrator.ts',
    );
    expect(classify).toContain('hasOpenDrainLease()');
    expect(classify).toContain('hasIncomplete()');
    expect(classify).not.toContain('await');
    expect(classify).not.toContain('owedDrainReplies');
    expect(classify).not.toContain('unbindStale');
    expect(classify).not.toContain('resumeAll');

    // The wake: sweep with the answered set excluded, then the replies, then
    // the terminal replay — one frame, one order that cannot lose work.
    const wake = memberBody(
      source, 'protected override async owedDeliveryWork(): Promise<void>', 'orchestrator.ts',
    );
    const owedAt = wake.indexOf('this.owedDrainReplies()');
    const sweptAt = wake.indexOf('this.eventLog.unbindStale(');
    const repliesAt = wake.indexOf('await this.completeEventBatch(');
    const terminalAt = wake.indexOf('await super.owedDeliveryWork()');
    expect(owedAt).toBeGreaterThan(-1);
    expect(sweptAt).toBeGreaterThan(owedAt);
    expect(repliesAt).toBeGreaterThan(sweptAt);
    expect(terminalAt).toBeGreaterThan(repliesAt);
    expect(wake).toContain('STALE_EVENT_DELIVERY_MS');
    expect(wake).toContain('this.orch.scheduleDrain()');
  });

  test('cloud admission counts precisely the active tool surface Think submits', () => {
    const beforeTurn = actor.slice(
      actor.indexOf('async beforeTurn(ctx: TurnContext)'),
      actor.indexOf('beforeStep(ctx: PrepareStepContext)'),
    );
    expect(beforeTurn).toContain('const submittedTools = { ...ctx.tools, ...effectiveTools };');
    expect(beforeTurn).toContain('effectiveActiveTools.flatMap((name) => {');
    expect(beforeTurn).toContain('const entry = submittedTools[name];');
    expect(beforeTurn).toContain('tools: { ...ctx.tools, ...cfg.tools }');
  });

  test('attachment sanitization runs on the whole history BEFORE the extension transform', () => {
    // The ordering (sanitize → onTurnStart → transformContext → turn-local) is
    // owned by core assembleTurnMessages — behaviorally pinned in core's
    // unit-turn-context-assembly.test.ts. What THIS backend must do is delegate
    // to it with the sanitizer policy and the extension host, instead of
    // re-implementing the ordering inline.
    const beforeTurn = actor.slice(
      actor.indexOf('async beforeTurn(ctx: TurnContext)'),
      actor.indexOf('beforeStep(ctx: PrepareStepContext)'),
    );
    const assemble = beforeTurn.indexOf('const assembly: Parameters<typeof assembleTurnMessages>[0] = {');
    expect(assemble).toBeGreaterThan(-1);
    const args = beforeTurn.slice(assemble);
    expect(args).toContain('history: rawMessages');
    expect(args).toContain('accepts: this.sessionAcceptedMedia()');
    expect(args).toContain('vfs: this.rt.storage.vfs');
    expect(args).toContain('extensions: this.extensions');
    // No parallel inline copy of the ordering survives here.
    expect(beforeTurn).not.toContain('sanitizeAttachmentsForModel(');
    expect(beforeTurn).not.toContain('runTransformContext(');
    expect(beforeTurn).not.toContain('.weave(');
  });

  test('the settle spine persists the provider error text into the activity log and the run_end event', () => {
    const spine = actor.slice(actor.indexOf('protected settleTurnEvents(result: ChatResponseResult)'));
    const errorCapture = spine.indexOf('const errorText = result.error?.slice(0, 500)');
    const logRow = spine.indexOf('this.logActivity("response_complete", errorText ? `${result.status} — ${errorText}` : result.status)');
    // The run bracket is the shared core closeTurnRun (turn_end + run_end);
    // the error text must flow into it. The payload shape is pinned in core's
    // unit-turn-lifecycle tests.
    const runEnd = spine.indexOf('closeTurnRun(this.eventRecorder, this._currentRunId, {');
    expect(errorCapture).toBeGreaterThan(-1);
    expect(logRow).toBeGreaterThan(errorCapture);
    expect(runEnd).toBeGreaterThan(logRow);
    const closeArgs = spine.slice(runEnd, spine.indexOf('});', runEnd));
    // `reason` and `error` are core's `classifyRunEnd` now, fed the driver's raw
    // facts. They used to be `reason: result.status` and `error: errorText`
    // chosen here, which is how the identical user Stop came to seal 'aborted'
    // on this backend and 'error' on the CLI. The error text still has to REACH
    // the classifier — that is what this pins — and which arm keeps it is core's
    // rule, behaviourally covered by unit-three-kinds-one-contract's abort arm.
    //
    // The classification is hoisted to a local now, because the fleet analytics
    // row beside this seal reads it too; the spread is what carries it in.
    expect(closeArgs).toContain('...end');
    expect(closeArgs).not.toContain('reason: result.status');
    // And the FACTS the classifier is fed, including the one this backend was
    // missing entirely: Think reports status 'completed' for a turn its own stop
    // condition cut, so `completed` alone cannot tell a finished turn from one
    // that stopped mid-work. `lastFinishReason` is what makes that observable —
    // dropping it makes core's mid-work tripwire permanently silent.
    expect(spine).toContain('const end = classifyRunEnd({');
    expect(spine).toContain("interrupted: result.status === 'aborted'");
    expect(spine).toContain('lastFinishReason: this.acc.lastFinishReason');
    // The per-turn records the spine is the only writer of. Dropping either
    // leaves the mechanism running and its durable trail silently empty.
    expect(closeArgs).toContain('steering: this.orch.steering.snapshot()');
    expect(closeArgs).toContain('craft: this.orch.craft.snapshot()');
  });

  test("the per-turn system prompt carries permission, provenance, and role", () => {
    const beforeTurn = actor.slice(
      actor.indexOf('const promptOptions: NonNullable<Parameters<typeof buildSystemPromptSync>[1]> = {'),
      actor.indexOf('this.recordSystemPromptHash(systemOverride)'),
    );
    expect(beforeTurn).toContain('workMode,');
    expect(beforeTurn).toContain('provenance: this.turnProvenance()');
    expect(beforeTurn).toContain('roleSection: profile.role');
    const turnMode = actor.slice(
      actor.indexOf('protected turnWorkMode(): WorkMode'),
      actor.indexOf('/** What this turn was started BY:'),
    );
    expect(turnMode).toContain('workModeForTurnMetadata(this.turnDrivingMetadata())');
    expect(turnMode).toContain('turnProvenanceForMetadata(this.turnDrivingMetadata())');
    expect(turnMode).toContain('if (!this._activeProgrammaticUserMessage) return this.turnUserMetadata();');
  });

  test('the turn prompt advertises the temporary rung the child substrate always wires', async () => {
    // Every cf actor with room below it holds team deps, so the temporary rung is
    // wired on every turn this backend runs. `TurnConfig.system` is the one
    // prompt the model receives, so it is the one surface that must name the
    // ladder's middle rung.
    const { agent } = orchestratorHarness();
    const config = await agent.beforeTurn({
      system: 'sys',
      messages: [{ role: 'user', content: 'summarise this file' }],
      tools: {} satisfies ToolSet,
      model: 'harness-model',
      continuation: false,
      body: {},
    });
    expect(config?.system ?? '').toContain('`ask` with `role` runs one temporary agent for one question');
  });

  test('the role the agent set is in the next prompt the DO builds', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    const turn = (content: string) => agent.beforeTurn({
      system: 'sys',
      messages: [{ role: 'user' as const, content }],
      tools: {} satisfies ToolSet,
      model: 'harness-model',
      continuation: false,
      body: {},
    });
    await turn('open the turn');
    const setMode = toolExecute<{ action: 'mode'; role: string }, unknown>(agent.getTools().tasks);
    const result = v.parse(RoleResultSchema, await setMode({ action: 'mode', role: 'auditor' }));
    expect(result.role).toBe('auditor');
    const config = await turn('audit this change');
    expect(config?.system).toContain('## Role: Auditor (auditor)');
  });

  test('a fresh multi-part ask gets NO delegation nudge at step 0', async () => {
    // The turn-start hint used to splice a `[Runtime steering …]` message on
    // every fresh ask telling the model to run the parts as one search. That
    // pressure is what sent a simple diagnosis into a three-node swarm on
    // 2026-09-03, and it is gone: the model decides from the tool description.
    const harness = orchestratorHarness();
    const agent = harness.agent;
    const orch = agent.observeOrch();
    const prepare = orch.turnExtension.prepareStep;
    if (!prepare) throw new Error('Expected turn steering prepareStep extension');

    await agent.beforeTurn({
      system: 'sys',
      messages: [{ role: 'user', content: 'add caching to the api and update the docs' }],
      tools: {} satisfies ToolSet,
      model: 'harness-model',
      continuation: false,
      body: {},
    });
    const messages = [{ role: 'user' as const, content: 'add caching to the api and update the docs' }];
    const stepped = await prepare.call(orch.turnExtension, { stepNumber: 0, messages });
    const rendered = JSON.stringify(stepped ?? messages);
    expect(rendered).not.toContain('Runtime steering');
    expect(rendered).not.toContain('action=swarm');
    expect(orch.steering.snapshot()).toEqual([]);
  });


  test('pickAlternateTake returns false unless the awaited delivery actually landed', () => {
    // One implementation, in core, that both backends' transports call — the
    // local session used to report every pick as queued without waiting.
    const pick = takePick.slice(takePick.indexOf('export async function pickAlternateTake('));
    expect(pick).toContain('let continuationQueued = false');
    expect(pick).toContain('const outcome = await deps.signals.deliver');
    expect(pick).toContain("continuationQueued = outcome !== 'undelivered'");
    expect(pick).not.toContain('continuationQueued = true');
    expect(source).toContain('await pickAlternateTake(');
  });
});

describe('improvement_lanes — one verdict gates the improvement lanes', () => {
  // Behavioral, not source-shaped: the lanes are driven through the CLAIMED
  // effect both actor classes dispatch, and what each verdict leaves behind is
  // read from storage. A FAILED build turn has no subject to replay and no answer to
  // review; a plan turn belongs in neither evidence set. Both facts are ONE
  // core decision (`improvementLanesOpen`, asked from inside the row) — these
  // arms fail independently on any backend that starts spelling its own
  // condition again.
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

  test('a completed build turn earns its review', async () => {
    const { agent } = advisorHarness();
    await agent.harnessSettleSpine({ status: 'completed', turn: turnOf() });
    // The review rides a detached durable fiber by contract; join the mock
    // runtime's live fibers rather than guessing at its clock.
    await agent.harnessJoinDetachedFibers();
    expect(agent.harnessAdvisorNotes()).toBe(1);
  });

  test('a FAILED build turn feeds no lane', async () => {
    const { agent } = advisorHarness();
    await agent.harnessSettleSpine({ status: 'error', turn: turnOf() });
    expect(agent.harnessAdvisorNotes()).toBe(0);
  });

  test('a completed PLAN turn feeds no lane', async () => {
    const { agent } = advisorHarness();
    agent.observeOrch().beginTurn(Date.now(), { kinuMode: 'plan' });
    // The mode is stated because the effect READS it from its row: a replay on a
    // fresh activation has no live turn to derive it from, and defaulting to
    // build is exactly what would feed a plan turn into the lanes.
    await agent.harnessSettleSpine({ status: 'completed', turn: turnOf(), workMode: 'plan' });
    expect(agent.harnessAdvisorNotes()).toBe(0);
  });

  test('an ABORTED build turn feeds no lane', async () => {
    const { agent } = advisorHarness();
    await agent.harnessSettleSpine({ status: 'aborted', turn: turnOf() });
    expect(agent.harnessAdvisorNotes()).toBe(0);
  });
});

/**
 * A queued shadow trial is re-drivable after an interruption, and its candidate
 * reaches the LIVE tool surface — so its calls pass the same once-only claim an
 * ordinary turn's calls do. That claim is keyed on the turn, the call id and
 * the arguments: the rollout's scope fixes the call id, and it has to fix the
 * turn half too, because the ambient one is the last turn's checkpoint while
 * the trial is queued and `_workspace` once the isolate that queued it is gone.
 */
describe('a recoverable rollout claims its tool calls on the rollout', () => {
  /** A claimed capability that runs entirely on this actor's own storage, so
   *  what the claim admits or refuses is observable without a network. */
  const RECALL = { action: 'recall', key: 'trial-probe' };

  test('the scope is the claim identity, not whatever turn is ambient', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-live');

    await harness.agent.harnessScaffoldCallTool('trial-7')('memory', RECALL);

    expect(harness.agent.harnessToolClaims('trial-7')).toEqual(['trial-7#0']);
    expect(harness.agent.harnessToolClaims('u-live')).toEqual([]);
    expect(harness.agent.harnessToolClaims(WORKSPACE_RUN_ID)).toEqual([]);
  });

  /**
   * The defect, end to end: the same trial re-driven on an activation that
   * shares nothing with the one that queued it. The world is moved in between,
   * so a call that ran a second time would answer differently — and the row the
   * first attempt left is what makes it answer the same.
   */
  test('a cold replay is answered from the first attempt row', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-live');
    harness.agent.harnessFacts().upsert('trial-probe', 'as the trial saw it');
    const first = await harness.agent.harnessScaffoldCallTool('trial-7')('memory', RECALL);

    harness.agent.harnessFacts().upsert('trial-probe', 'as the world moved on');
    const restarted = await reactivateOrchestratorHarness(harness.db);
    const replay = await restarted.agent.harnessScaffoldCallTool('trial-7')('memory', RECALL);

    expect(replay).toEqual(first);
    expect(restarted.agent.harnessToolClaims('trial-7')).toEqual(['trial-7#0']);
  });

  /** A rollout with no durable identity — a live preview, a GEPA candidate — is
   *  re-driven by nothing, so it keeps the ambient turn rather than inventing a
   *  scope that would claim to be recoverable. */
  test('an unscoped rollout still claims against the live turn', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-live');

    await harness.agent.harnessScaffoldCallTool()('memory', RECALL);

    expect(harness.agent.harnessToolClaims('u-live')).toHaveLength(1);
  });
});
