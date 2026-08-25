import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memberBody } from '@kinu.run/test-utils';
import {
  BUILTIN_PROFILE_CATALOG, DEFAULT_WORKERS_AI_MODEL_SPEC, effectiveRoleCatalog, profileCatalogDigest,
  type CompletedTurn, type ProfileCatalog, type ProfileCatalogEnvelope,
} from '@kinu.run/core';
import {
  orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import type { ToolSet, UIMessage } from 'ai';
import * as v from 'valibot';

const TasksToolProbeSchema = v.object({ execute: v.function() });
const RoleResultSchema = v.object({ role: v.string() });

// The turn pipeline is split across the actor substrate (actor-agent.ts —
// beforeTurn assembly, the BackendHost, the event-injection machinery) and
// the orchestrator (onChatResponse sequencing, schema, callables).
const actor = readFileSync(join(import.meta.dir, '..', 'src', 'actor-agent.ts'), 'utf8');
const source = readFileSync(join(import.meta.dir, '..', 'src', 'orchestrator.ts'), 'utf8');
const subordinate = readFileSync(join(import.meta.dir, '..', 'src', 'subordinate-agent.ts'), 'utf8');
const headRuntime = readFileSync(join(import.meta.dir, '..', 'src', 'head-runtime.ts'), 'utf8');
const takePick = readFileSync(join(import.meta.dir, '..', '..', 'core', 'src', 'read-models', 'evolution-views.ts'), 'utf8');
const exploration = readFileSync(join(import.meta.dir, '..', 'src', 'exploration.ts'), 'utf8');
const facetSpawn = readFileSync(join(import.meta.dir, '..', 'src', 'facet-spawn.ts'), 'utf8');
const ownedModelServices = readFileSync(join(import.meta.dir, '..', 'src', 'owned-model-services.ts'), 'utf8');
const generateJson = readFileSync(join(import.meta.dir, '..', '..', 'core', 'src', 'prompts', 'structured.ts'), 'utf8');

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

/** A second catalog, so a test can prove the roles are read off the ACTIVE
 *  envelope rather than baked in at construction. Two custom roles over the
 *  required default tier; the digest is the envelope's own content hash. */
const CUSTOM_CATALOG: ProfileCatalog = {
  roles: {
    scout: {
      description: 'Gathers evidence and reports findings.',
      instructions: 'Look it up before you say it.',
      tier: 'fast',
      preset: 'research',
    },
    fixer: {
      description: 'Applies a decided fix.',
      instructions: 'Make the change and verify it.',
      tier: 'default',
      preset: 'optimise',
    },
  },
  tiers: { default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC } },
};
const CUSTOM_ENVELOPE: ProfileCatalogEnvelope = {
  authority: { kind: 'local' },
  version: 1,
  digest: profileCatalogDigest(CUSTOM_CATALOG),
  catalog: CUSTOM_CATALOG,
};

describe('turn-pipeline correctness wiring', () => {
  test('the actor prompt contains its loaded SOUL on both prompt-build paths', () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    agent.setObservedSoul('You are Atlas. Preserve the owner\'s exact requirements.');

    const prompt = agent.getSystemPrompt();

    expect(prompt).toContain('You are Atlas. Preserve the owner\'s exact requirements.');
    const base = actor.slice(
      actor.indexOf('base = buildSystemPromptSync(this.rt, {'),
      actor.indexOf('this._cachedSystemPrompt = base;'),
    );
    const perTurn = actor.slice(
      actor.indexOf('const promptOptions: NonNullable<Parameters<typeof buildSystemPromptSync>[1]> = {'),
      actor.indexOf('this.recordSystemPromptHash(systemOverride)'),
    );
    expect(base).toContain('soulOverride: this.getSoulText()');
    expect(perTurn).toContain('soulOverride: this.getSoulText()');
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
    expect(snapshot).toContain('missingCapabilities: this._mcpUnavailable');
    // Passed, not re-derived: a backend that rebuilt its own store handles here
    // would be back to stating the binding twice.
    expect(snapshot).toContain('stores: this.stores');
  });

  test('the dynamic-context ledger rides the shared STEP pipeline, not the turn assembly', () => {
    // Per-step, because the state it carries changes mid-turn: a job detaches,
    // a sandbox comes up, a consent card lands. Assembling it once per turn
    // would show the model a snapshot that is already stale by step 2.
    const beforeStep = actor.slice(actor.indexOf('beforeStep(ctx: PrepareStepContext)'));
    expect(beforeStep).toContain('composePrepareStep({');
    expect(beforeStep).toContain('dynamic: { ledger: this.dynamicLedger, snapshot: () => this.dynamicContextSnapshot() }');
    const assembleArgs = actor.slice(
      actor.indexOf('const assembly: Parameters<typeof assembleTurnMessages>[0] = {'),
      actor.indexOf('cfg.messages = await assembleTurnMessages(assembly)'),
    );
    expect(assembleArgs).not.toContain('ledger:');
  });

  test('beforeTurn merges profile reasoning effort with cache provider options', () => {
    const beforeTurn = actor.slice(
      actor.indexOf('async beforeTurn(ctx: TurnContext)'),
      actor.indexOf('beforeStep(ctx: PrepareStepContext)'),
    );
    expect(beforeTurn).toContain('profile.tier.reasoningEffort');
    expect(beforeTurn).toContain('parseModelSpec(profile.tier.model).provider');
    expect(beforeTurn).toContain('reasoningEffortOptions');
    expect(beforeTurn).toContain('mergeProviderOptions(cacheOptions, reasoningOptions)');
    expect(beforeTurn).toContain('cfg.providerOptions = providerOptions');
    expect(beforeTurn).toContain('lastTurnOpts.providerOptions = providerOptions');
  });

  test('provider-agnostic auxiliary calls take their effort from the route, not a constant', () => {
    expect(exploration).not.toContain('maxOutputTokens');
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
    expect(headRuntime).not.toContain('maxOutputTokens');
    expect(headRuntime).not.toContain('reasoningEffortOptions');
    // The recursive-split merge asks through the one HeadRuntime, over the same
    // services object, on the tier its `judge` spend label routes to.
    expect(headRuntime).toContain("resolveModelRoute('judge', await deps.profile())");
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
    expect(control).not.toContain('maxOutputTokens');
    expect(control).toContain('judge: createJsonJudge(() => this.getModelForReview())');
    expect(control).not.toContain('reasoningEffortOptions');
    expect(generateJson).not.toContain('opts.maxOutputTokens ??');
  });

  // Owner directive: output caps are the wrong mechanism entirely — a reasoning
  // model spends its budget thinking before it emits anything, so a cap
  // truncates or starves the answer. Cost is controlled by reasoning effort.
  // An explicitly configured cap is still honoured; a hardcoded literal is not.
  test('no production source hardcodes an output-token cap', () => {
    const root = join(import.meta.dir, '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(path);
        } else if (/\.tsx?$/.test(entry.name)) {
          const text = readFileSync(path, 'utf8');
          for (const [line] of text.matchAll(/maxOutputTokens:\s*\d+/g)) {
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

  test('an INTERRUPTED turn still projects the session tree into `messages`', async () => {
    // The bug the operator hit: he forked from a message the chat pane was
    // showing and got `fork point not found`. `messages` was written by a
    // turn-end summary that ran only on the completed path, so an interrupted
    // turn left the pane and the fork substrate disagreeing. This asserts the
    // BEHAVIOUR, not the source text — delete the `reconcileSessionTree` call in
    // `onChatResponse` and this goes red.
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

    const rows = harness.db.prepare<{ id: string; parent_id: string | null; content: string }, []>(
      `SELECT id, parent_id, content FROM messages WHERE session_id = 'default' ORDER BY rowid`,
    ).all();
    expect(rows.map((r) => r.id)).toEqual(['u-live', 'a-live']);
    expect(rows[1]!.parent_id).toBe('u-live');
    // Flattened for search and the evolution outcome join, not the raw UI JSON.
    expect(rows[1]!.content).toBe('partial answer');
  });

  test('an ABORTED turn is still recorded as evidence', async () => {
    // The drift this closes: `onChatResponse` early-returned on any status but
    // 'completed', so a failed cloud turn reached neither the outcome-review
    // buffer nor `extensions.onTurnEnd`, while the identical turn on the CLI
    // reached both. Failures are the most informative evidence the evolution
    // loop has, and the comment justifying that early return covered only the
    // alternate-takes purge beside it. Core's `AgentOrchestrator.settleTurn` is
    // the one entry now, and it fires the extension end BEFORE recording; the
    // extension half is core's (it runs unconditionally inside settleTurn), so
    // what THIS asserts is the half that was unprovable here — the durable row.
    const harness = orchestratorHarness();

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
      `SELECT turn FROM session_window`,
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
    expect(settle).toContain('this._activeDrainTurnId ?? this._pendingDrainReplyTurns.get(result.requestId)');
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
    const response = source.slice(source.indexOf('async onChatResponse(result: ChatResponseResult)'));
    expect(response).toContain('this._pendingDrainReplyTurns.set(result.requestId, drainTurnId)');
    expect(response).toContain('this._pendingDrainReplyTurns.delete(result.requestId)');
    const clear = actor.slice(
      actor.indexOf('constructor(ctx: AgentContext, env: Env)'),
      actor.indexOf('/** The settled turn\'s actor-generic front half'),
    );
    expect(clear).toContain('this._pendingDrainReplyTurns.clear()');
  });

  test('activation runs one stale-delivery sweep and schedules the standard drain when it recovers rows', () => {
    const onStart = memberBody(source, 'onStart(): void', 'orchestrator.ts');
    expect(onStart).toContain('this.eventLog.unbindStale(STALE_EVENT_DELIVERY_MS)');
    expect(onStart).toContain('this.orch.scheduleDrain()');
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

  test('BOTH prompt paths advertise the RLM provider the sandbox always wires', async () => {
    // `createRLMProvider` is unconditional in buildCfExecuteTools, so `llm.query`
    // is wired on every turn this backend runs — and `rlmAvailable` was set on the
    // cached base alone. TurnConfig.system overrides that base for every turn, so
    // the ONE prompt the model actually receives was the one surface that never
    // said the capability existed: 143 tokens of decomposition doctrine plus the
    // ladder's zeroth rung, absent from every shipped turn. Both paths, because
    // one path knowing is exactly the state that shipped.
    const { agent } = orchestratorHarness();
    const config = await agent.beforeTurn({
      system: 'sys',
      messages: [{ role: 'user', content: 'summarise this file' }],
      tools: {} satisfies ToolSet,
      model: 'harness-model',
      continuation: false,
      body: {},
    });
    for (const prompt of [config?.system ?? '', agent.getSystemPrompt()]) {
      expect(prompt).toContain('`llm.query(text, { model?, reasoning_effort? })` is available');
      expect(prompt).toContain('The cheapest helper is not an agent');
    }
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
    const tasks = v.parse(TasksToolProbeSchema, agent.getTools().tasks);
    const result = v.parse(RoleResultSchema, await tasks.execute({ action: 'mode', role: 'auditor' }));
    expect(result.role).toBe('auditor');
    const config = await turn('audit this change');
    expect(config?.system).toContain('## Role: Auditor (auditor)');
  });

  test('a delegation opportunity carries the roles the catalog offered AT DELIVERY', async () => {
    // The wiring this pins: the DO hands its orchestrator a roleCatalog
    // callback, and the steering object reads it at the moment a hint is
    // delivered — so each row stamps the ids that were on offer then. That is
    // the difference between an ignored hint under an empty catalog (a wiring
    // gap) and one under a full catalog (behaviour).
    //
    // A CALLBACK rather than a constructor argument because the catalog changes
    // between turns; captured at delivery rather than read at turn end because
    // a catalog that moved afterwards would rewrite what the agent was offered.
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
    prepare.call(orch.turnExtension, {
      stepNumber: 0,
      messages: [{ role: 'user' as const, content: 'add caching to the api and update the docs' }],
    });
    const [row] = orch.steering.delegationSnapshot();
    expect(row?.roles).toEqual(Object.keys(effectiveRoleCatalog(BUILTIN_PROFILE_CATALOG)));

    // Swap the active envelope for a different catalog AFTER the hint was
    // delivered. The already-recorded row keeps what was on offer when it was
    // delivered — the row is evidence about a moment, not a live view.
    Reflect.set(agent, '_turnProfileInputs', {
      envelope: CUSTOM_ENVELOPE,
      provider: { revision: 'turn-pipeline-test', availableModels: [DEFAULT_WORKERS_AI_MODEL_SPEC] },
    });
    const swapped = orch.steering.delegationSnapshot();
    expect(swapped[0]!.roles).toEqual(Object.keys(effectiveRoleCatalog(BUILTIN_PROFILE_CATALOG)));

    // And the NEXT delivery reads the swapped catalog, which is what keeps the
    // callback load-bearing rather than a constructor argument in disguise.
    orch.beginTurn(Date.now());
    prepare.call(orch.turnExtension, {
      stepNumber: 0,
      messages: [{ role: 'user' as const, content: 'now do a different fresh thing entirely' }],
    });
    expect(orch.steering.delegationSnapshot()[0]!.roles)
      .toEqual(Object.keys(effectiveRoleCatalog(CUSTOM_CATALOG)));
  });

  test('both post-turn lanes are DURABLE fibers, not bare heartbeats', () => {
    // Parity with the CLI, which awaits orch.settleEvolution() before the
    // process exits. Evolution is detached so it never blocks the TurnQueue —
    // but Think's own keepAliveWhile disposes when onChatResponse returns, so
    // without a hold of its own the detached LLM calls race DO eviction.
    //
    // A HOLD IS NOT ENOUGH, and that is what this test now says. `keepAlive`
    // resets the idle timer and nothing more: a deploy, a runtime restart or an
    // alarm-boundary reset took the whole lane with it, leaving no row, no
    // event and no way to resume — the durable window it had claimed simply sat
    // un-drained. `runFiber` holds the SAME heartbeat AND writes the
    // `cf_agents_runs` row that hands the lane to onFiberRecovered on the next
    // activation, so the fiber is the load-bearing half and the heartbeat is a
    // consequence of it.
    //
    // The DO holds BOTH lanes: the turn lane (settleEvolution) and the
    // cadence-heavy session pass (runDueSessionEvolution). It is the host that
    // CAN afford the heavy pass, which is why a one-shot `kinu exec` defers it.
    const settle = actor.slice(
      actor.indexOf('protected settleEvolutionInBackground(): void'),
      actor.indexOf("   * The settled turn's spine"),
    );
    expect(settle).toContain('if (this._evolutionSettling) return;');
    expect(settle).toContain('await this.orch.settleEvolution();');
    expect(settle).toContain('await this.orch.runDueSessionEvolution();');
    expect(settle).toContain('.finally(() => { this._evolutionSettling = false; });');
    // Detached — awaiting it in onChatResponse would re-block the TurnQueue —
    // and durable, which a bare keepAliveWhile is not.
    expect(settle).toContain('void this.runFiber(EVOLUTION_LANE_FIBER');
    expect(settle).toContain('ctx.stash({ lane: EVOLUTION_LANE_FIBER });');
    expect(settle).not.toContain('keepAliveWhile');

    // The advisor lane is the same shape, and its stash carries the WHOLE
    // review rather than a pointer to it — the complete turn plus the three
    // decisions taken at turn end. A pointer is what made the lane
    // unrecoverable: the review's input is not stored anywhere else, so a
    // snapshot that named the turn without carrying it could only report the
    // loss. Typed, so a field dropped from the snapshot is a build error rather
    // than a review that silently re-runs against different inputs.
    const advisor = actor.slice(
      actor.indexOf('private reviewTurnInBackground(turn: CompletedTurn): void'),
      actor.indexOf('protected get scaffoldControl()'),
    );
    expect(advisor).toContain('void this.runFiber(ADVISOR_LANE_FIBER');
    expect(advisor).toContain('const snapshot: AdvisorRecoverySnapshot = {');
    expect(advisor).toContain('ctx.stash(snapshot);');
    expect(advisor).not.toContain('keepAliveWhile');
    // ONE body for the live lane and its recovery. Two would drift on exactly
    // the fields that matter: a recovery re-deriving `reachable` or `recent`
    // would review the turn against a world it did not run in. The body lives
    // on the actor; the RECOVERY arm consumes it through the transports seam,
    // which is what keeps the re-drive from re-deriving anything.
    expect(advisor).toContain('await this.runAdvisorReview(snapshot);');
    const roster = readFileSync(join(import.meta.dir, '..', 'src', 'fiber-recovery.ts'), 'utf8');
    const advisorRecovery = roster.slice(
      roster.indexOf('async function recoverAdvisorLane('),
      roster.indexOf('async function recordInterruptedSearch('),
    );
    expect(advisorRecovery).toContain('transports.reviewAdvisorSnapshot(snapshot)');
    expect(advisorRecovery).toContain('transports.hasAdvisorNoteForTurn(turnId)');

    // …and the shared post-turn spine actually calls it, after the settle
    // dispatched the recording — for EVERY actor, not just the orchestrator.
    const spine = actor.slice(
      actor.indexOf('protected async settleTurnSpine('),
      actor.indexOf('private reviewTurnInBackground(turn: CompletedTurn): void'),
    );
    const record = spine.indexOf('await this.orch.settleTurn({');
    const settleCall = spine.indexOf('this.settleEvolutionInBackground();');
    expect(record).toBeGreaterThan(-1);
    expect(spine).not.toContain('this.orch.recordTurn(');
    expect(settleCall).toBeGreaterThan(record);
    // WHICH lanes may run is not spelled here at all: core's `settleTurn`
    // returns the completed-and-build verdict, derived from the beginTurn
    // metadata its recording gate already used, so neither backend can answer
    // the question independently (the CLI once queued shadow trials for turns
    // that FAILED while this spine did not).
    expect(spine).toContain('if (!improvementLanesOpen) return false;');
    expect(spine).not.toContain("input.workMode === 'plan'");
    expect(subordinate).not.toContain('workMode: turnMode');
    // The ROOT still computes turnMode — creditedTurnId legitimately takes it
    // — so the pin is the settle call itself, not the whole file.
    const rootSettle = source.slice(
      source.indexOf('const settle = () => this.settleTurnSpine({'),
      source.indexOf('if (result.status !== "completed")'),
    );
    expect(rootSettle).not.toContain('workMode');
    // The promotion gate's trial is queued THROUGH the engine, which holds the
    // one auto-evolution gate. Calling core's queueTurnShadowTrial from here
    // instead is how a `--no-auto-evolve` run came to leave trial rows behind.
    expect(spine).toContain('this.engine.queueShadowTrial(input.turn,');
    expect(spine).not.toContain('queueTurnShadowTrial(');
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

describe('settleTurnSpine — one verdict gates the improvement lanes', () => {
  // Behavioral, not source-shaped: the spine is driven the way both actor
  // classes drive it, and what each verdict leaves behind is read from
  // storage. A FAILED build turn has no subject to replay and no answer to
  // review; a plan turn belongs in neither evidence set. Both facts are ONE
  // core decision (settleTurn's verdict) — these arms fail independently on
  // any backend that starts spelling its own condition again.
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
    await agent.harnessSettleSpine({ status: 'completed', turn: turnOf() });
    expect(agent.harnessAdvisorNotes()).toBe(0);
  });

  test('an ABORTED build turn feeds no lane', async () => {
    const { agent } = advisorHarness();
    await agent.harnessSettleSpine({ status: 'aborted', turn: turnOf() });
    expect(agent.harnessAdvisorNotes()).toBe(0);
  });
});
