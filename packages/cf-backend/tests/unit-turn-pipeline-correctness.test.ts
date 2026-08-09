import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

  test('the MEMORY.md tail is read once per turn and rides the per-step dynamic block', () => {
    // Parity with the CLI: the reflection loop assumes the model sees its
    // newest lessons in-turn. The tail is the ONE dynamic-context input behind
    // an await, so it is sourced once at turn assembly and closed over by the
    // per-step snapshot — never rendered into the cacheable prefix.
    const assembleIdx = actor.indexOf('cfg.messages = await assembleTurnMessages({');
    const sourceIdx = actor.indexOf('this._turnMemoryTail = await readMemoryTail(this.rt.memory)');
    expect(assembleIdx).toBeGreaterThan(-1);
    expect(sourceIdx).toBeGreaterThan(-1);
    expect(sourceIdx).toBeLessThan(assembleIdx);
    // The snapshot reads every OTHER plane live, at the step it is called.
    const snapshot = actor.slice(
      actor.indexOf('protected dynamicContextSnapshot(): DynamicContext {'),
      actor.indexOf('beforeStep(ctx: PrepareStepContext)'),
    );
    expect(snapshot).toContain('memoryTail: this._turnMemoryTail');
    expect(snapshot).toContain('this.renderFactsForTurn()');
    expect(snapshot).toContain('this.rt.executionRouter?.listExecutors()');
    expect(snapshot).toContain('this.jobs.listRunning()');
    expect(snapshot).toContain('forkDelegates(this.headJournal.listLive())');
  });

  test('the dynamic-context ledger rides the shared STEP pipeline, not the turn assembly', () => {
    // Per-step, because the state it carries changes mid-turn: a job detaches,
    // a sandbox comes up, a consent card lands. Assembling it once per turn
    // would show the model a snapshot that is already stale by step 2.
    const beforeStep = actor.slice(actor.indexOf('beforeStep(ctx: PrepareStepContext)'));
    expect(beforeStep).toContain('composePrepareStep({');
    expect(beforeStep).toContain('dynamic: { ledger: this.dynamicLedger, snapshot: () => this.dynamicContextSnapshot() }');
    const assembleArgs = actor.slice(
      actor.indexOf('cfg.messages = await assembleTurnMessages({'),
      actor.indexOf('});', actor.indexOf('cfg.messages = await assembleTurnMessages({')),
    );
    expect(assembleArgs).not.toContain('ledger:');
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

    const shadowJudge = actor.slice(
      actor.indexOf('protected async runShadowEvalSampled'),
      actor.indexOf('/** Build a streaming LLM callback'),
    );
    expect(shadowJudge).not.toContain('maxOutputTokens');
    expect(shadowJudge).toContain("reasoningEffortOptions('low', this.effectiveModelProviderFamily())");
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
      actor.indexOf('/** Drain batches bound to the LIVE turn'),
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
    const assemble = beforeTurn.indexOf('cfg.messages = await assembleTurnMessages({');
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
    expect(closeArgs).toContain('error: errorText');
    expect(closeArgs).toContain('reason: result.status');
  });

  test("the per-turn system prompt carries the turn's mode overlay", () => {
    // The CLI derived a PromptMode from metadata.proteusEvent; cf passed none,
    // so a hosted agent resumed to collect a background job never saw the
    // background-resume guidance. Both now share core's promptModeForTurnEvent.
    const beforeTurn = actor.slice(
      actor.indexOf('const systemOverride = buildSystemPromptSync(this.rt, {'),
      actor.indexOf('this.recordSystemPromptHash(systemOverride)'),
    );
    expect(beforeTurn).toContain(
      'mode: promptModeForTurnEvent(this.turnUserMessageEvent(this._activeProgrammaticUserMessage))',
    );
  });

  test('the DO holds a keepAlive heartbeat until the turn evolution settles', () => {
    // Parity with the CLI, which awaits orch.settleEvolution() before the
    // process exits. Evolution is detached so it never blocks the TurnQueue —
    // but Think's own keepAliveWhile disposes when onChatResponse returns, so
    // without a settle heartbeat the detached LLM calls race DO eviction.
    const settle = actor.slice(
      actor.indexOf('protected settleEvolutionInBackground(): void'),
      actor.indexOf("   * The completed turn's evolution spine"),
    );
    expect(settle).toContain('if (this._evolutionSettling) return;');
    expect(settle).toContain('this.keepAliveWhile(() => this.orch.settleEvolution())');
    expect(settle).toContain('.finally(() => { this._evolutionSettling = false; });');
    // Detached — awaiting it in onChatResponse would re-block the TurnQueue.
    expect(settle).toContain('void this.keepAliveWhile');

    // …and the shared post-turn spine actually calls it, after recordTurn
    // dispatched — for EVERY actor, not just the orchestrator.
    const spine = actor.slice(
      actor.indexOf('protected settleCompletedTurn('),
      actor.indexOf('protected async runShadowEvalSampled'),
    );
    const recordTurn = spine.indexOf('this.orch.recordTurn(turn);');
    const settleCall = spine.indexOf('this.settleEvolutionInBackground();');
    expect(recordTurn).toBeGreaterThan(-1);
    expect(settleCall).toBeGreaterThan(recordTurn);
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
