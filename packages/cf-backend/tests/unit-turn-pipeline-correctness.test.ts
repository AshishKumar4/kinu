import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The turn pipeline is split across the actor substrate (actor-agent.ts —
// beforeTurn assembly, the BackendHost, the event-injection machinery) and
// the orchestrator (onChatResponse sequencing, schema, callables).
const actor = readFileSync(join(import.meta.dir, '..', 'src', 'actor-agent.ts'), 'utf8');
const source = readFileSync(join(import.meta.dir, '..', 'src', 'orchestrator.ts'), 'utf8');
const headRuntime = readFileSync(join(import.meta.dir, '..', 'src', 'heads', 'head-runtime.ts'), 'utf8');
const exploration = readFileSync(join(import.meta.dir, '..', 'src', 'exploration.ts'), 'utf8');
const facetSpawn = readFileSync(join(import.meta.dir, '..', 'src', 'facet-spawn.ts'), 'utf8');
const generateJson = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'generate-json.ts'), 'utf8');

describe('turn-pipeline correctness wiring', () => {
  test('client RPC policy runs before SDK dispatch and defaults to allow', () => {
    const constructor = actor.slice(
      actor.indexOf('constructor(ctx: AgentContext, env: Env)'),
      actor.indexOf('/** Drain batches bound to the LIVE turn'),
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
    expect(actor).toMatch(/createCFHeadRuntime\([\s\S]*?ownerUserId,[\s\S]*?this\.workspaceName\(\),/);
    expect(headRuntime).toContain('parentWorkspaceName: string');
    expect(headRuntime).toContain('sharedParent: parentWorkspaceName');
    expect(headRuntime).not.toContain('sharedParent: orchestrator.name');
    // A recursive split re-uses the ROOT it was given, never its own facet name.
    expect(exploration).toContain('sharedParent: facet.getSharedParent()');
    // The spawn seam is what turns that into the child facet's persisted parent.
    expect(facetSpawn).toContain('await stub.setSharedParent(identity.sharedParent)');
  });

  test('beforeTurn weaves the bounded MEMORY.md tail into the ephemeral system-state block', () => {
    // Parity with the CLI weave: the reflection loop assumes the model sees its
    // newest lessons in-turn. cf previously passed only {factsBlock,executors},
    // so hosted agents never saw their latest MEMORY.md lessons. The tail is
    // sourced through the shared readMemoryTail helper (single source of truth
    // for the path + bound) and rides the ephemeral block, never the prefix.
    expect(actor).toContain('readMemoryTail');
    const weaveIdx = actor.indexOf('this.ephemeralLedger.weave(transformed ?? baseMessages');
    expect(weaveIdx).toBeGreaterThan(-1);
    const sourceIdx = actor.indexOf('const memoryTail = await readMemoryTail(this.rt.memory)');
    expect(sourceIdx).toBeGreaterThan(-1);
    // Sourced BEFORE the weave, and passed into it alongside facts + executors.
    expect(sourceIdx).toBeLessThan(weaveIdx);
    const weaveArgs = actor.slice(weaveIdx, actor.indexOf('const turnLocal = turnLocalContextMessage', weaveIdx));
    expect(weaveArgs).toContain('factsBlock: this.renderFactsForTurn()');
    expect(weaveArgs).toContain('...(memoryTail ? { memoryTail } : {})');
    expect(weaveArgs).toContain('executors: execs');
  });

  test('beforeTurn merges user reasoning effort with cache provider options', () => {
    const beforeTurn = actor.slice(
      actor.indexOf('async beforeTurn(ctx: TurnContext)'),
      actor.indexOf('beforeStep(ctx: PrepareStepContext)'),
    );
    expect(beforeTurn).toContain('this.config.getReasoningEffort()');
    expect(beforeTurn).toContain("REASONING_EFFORT_FOR_STAGE.chat");
    expect(beforeTurn).toContain('reasoningEffortOptions');
    expect(beforeTurn).toContain('mergeProviderOptions(cacheOptions, reasoningOptions)');
    expect(beforeTurn).toContain('cfg.providerOptions = providerOptions');
    expect(beforeTurn).toContain('...(providerOptions ? { providerOptions } : {})');
  });

  test('provider-agnostic auxiliary calls use low effort without implicit output caps', () => {
    expect(exploration).not.toContain('maxOutputTokens');
    expect(exploration.match(/reasoningEffortOptions\('low'/g)?.length).toBe(1);
    expect(headRuntime).not.toContain('maxOutputTokens');
    expect(headRuntime).toContain("reasoningEffortOptions('low', parseModelSpec(spec).provider)");

    const shadowJudge = source.slice(
      source.indexOf('private async runShadowEvalSampled'),
      source.indexOf('private async maybeGenerateTitle'),
    );
    expect(shadowJudge).not.toContain('maxOutputTokens');
    expect(shadowJudge).toContain("reasoningEffortOptions('low', this.effectiveModelProviderFamily())");
    expect(generateJson).not.toContain('opts.maxOutputTokens ??');
  });

  test('CHAT_CLEAR resets the ephemeral ledger and durable compaction plan after Think handles it', () => {
    const constructor = actor.slice(
      actor.indexOf('constructor(ctx: AgentContext, env: Env)'),
      actor.indexOf('/** Drain batches bound to the LIVE turn'),
    );
    const dispatch = constructor.indexOf('await dispatchMessage.call');
    const reset = constructor.indexOf('this.ephemeralLedger.reset()');
    const clearPlan = constructor.indexOf('this.compactionState.plans.save(this.name, null)');
    expect(constructor).toContain('parseProtocolMessage(message)');
    expect(constructor).toContain("event?.type === 'clear'");
    expect(dispatch).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(dispatch);
    expect(clearPlan).toBeGreaterThan(reset);
  });

  test('aborted turns re-enqueue absorbed and leftover batches without continuation retention', () => {
    // The settle spine is the ActorAgent helper; onChatResponse must call it
    // FIRST, before anything that can throw or return early.
    const hook = source.slice(source.indexOf('async onChatResponse(result: ChatResponseResult)'));
    const preEarlyReturn = hook.slice(0, hook.indexOf('if (result.status !== "completed")'));
    expect(preEarlyReturn).toContain('this.settleTurnEvents(result)');
    const helper = actor.slice(actor.indexOf('protected settleTurnEvents(result: ChatResponseResult)'));
    expect(helper).toContain('settle({ retainForContinuation: completed })');
    expect(helper).toContain('[...injectedEvents.absorbed, ...injectedEvents.leftover]');
    expect(helper).toContain("this.reenqueueEventBatch(batch, completed ? 'leftover' : 'aborted')");
  });

  test('leftover fallback compensates skipped and rejected enqueues with every batch event id', () => {
    const helper = actor.slice(
      actor.indexOf('protected async reenqueueEventBatch'),
      actor.indexOf('/** Durable per-session compaction state'),
    );
    expect(helper).toContain("if (result.status === 'queued') return");
    expect(helper).toContain('catch (err)');
    expect(helper).toContain('for (const id of batch.ids)');
    expect(helper).toContain('this.eventLog.unbind(id)');
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
      actor.indexOf('/** Drain batches bound to the LIVE turn'),
    );
    expect(clear).toContain('this._pendingDrainReplyTurns.clear()');
  });

  test('activation runs one stale-delivery sweep and schedules the standard drain when it recovers rows', () => {
    const onStart = source.slice(source.indexOf('async onStart()'), source.indexOf('// ── DO alarm'));
    expect(onStart).toContain('this.eventLog.unbindStale(STALE_EVENT_DELIVERY_MS)');
    expect(onStart).toContain('this.orch.scheduleDrain()');
  });

  test('attachment sanitization runs on the whole history BEFORE the extension transform and the ledger weave', () => {
    const beforeTurn = actor.slice(
      actor.indexOf('async beforeTurn(ctx: TurnContext)'),
      actor.indexOf('beforeStep(ctx: PrepareStepContext)'),
    );
    const sanitize = beforeTurn.indexOf('await sanitizeAttachmentsForModel(rawMessages');
    const turnStart = beforeTurn.indexOf('await this.extensions.emitTurnStart');
    const transform = beforeTurn.indexOf('await this.extensions.runTransformContext');
    const weave = beforeTurn.indexOf('this.ephemeralLedger.weave');
    expect(sanitize).toBeGreaterThan(-1);
    expect(turnStart).toBeGreaterThan(sanitize);
    expect(transform).toBeGreaterThan(turnStart);
    expect(weave).toBeGreaterThan(transform);
    // The transform and the weave both read the SANITIZED baseMessages.
    expect(beforeTurn).toContain('messages: baseMessages');
    expect(beforeTurn).toContain('weave(transformed ?? baseMessages');
    expect(beforeTurn).toContain('accepts: this.sessionAcceptedMedia()');
  });

  test('the settle spine persists the provider error text into the activity log and the run_end event', () => {
    const spine = actor.slice(actor.indexOf('protected settleTurnEvents(result: ChatResponseResult)'));
    const errorCapture = spine.indexOf('const errorText = result.error?.slice(0, 500)');
    const logRow = spine.indexOf('this.logActivity("response_complete", errorText ? `${result.status} — ${errorText}` : result.status)');
    const runEnd = spine.indexOf("...(errorText ? { error: errorText } : {})");
    expect(errorCapture).toBeGreaterThan(-1);
    expect(logRow).toBeGreaterThan(errorCapture);
    expect(runEnd).toBeGreaterThan(logRow);
    // The run_end emit itself carries the error.
    const runEndEmit = spine.slice(spine.indexOf("type: 'run_end'"), spine.indexOf("console.warn('[proteus] event emit failed at onChatResponse"));
    expect(runEndEmit).toContain('error: errorText');
  });

  test('pickAlternateTake returns false unless the awaited enqueue actually queues', () => {
    const pick = source.slice(
      source.indexOf('async pickAlternateTake('),
      source.indexOf('/**\n   * The unified Run Timeline spine'),
    );
    expect(pick).toContain('let continuationQueued = false');
    expect(pick).toContain('const result = await this.host.enqueueTurn');
    expect(pick).toContain("continuationQueued = result.status === 'queued'");
    expect(pick).toContain("if (result.status === 'skipped')");
    expect(pick).toContain('catch (err)');
    expect(pick).not.toContain('continuationQueued = true');
  });
});
