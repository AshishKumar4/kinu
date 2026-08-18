import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memberBody } from '@proteus/test-utils';
import { orchestratorHarness } from './helpers/actor-harness';
import type { UIMessage } from 'ai';
import * as v from 'valibot';

const TasksToolProbeSchema = v.object({ execute: v.function() });
const StanceResultSchema = v.object({ stance: v.string() });

// The turn pipeline is split across the actor substrate (actor-agent.ts —
// beforeTurn assembly, the BackendHost, the event-injection machinery) and
// the orchestrator (onChatResponse sequencing, schema, callables).
const actor = readFileSync(join(import.meta.dir, '..', 'src', 'actor-agent.ts'), 'utf8');
const source = readFileSync(join(import.meta.dir, '..', 'src', 'orchestrator.ts'), 'utf8');
const headRuntime = readFileSync(join(import.meta.dir, '..', 'src', 'heads', 'head-runtime.ts'), 'utf8');
const exploration = readFileSync(join(import.meta.dir, '..', 'src', 'exploration.ts'), 'utf8');
const facetSpawn = readFileSync(join(import.meta.dir, '..', 'src', 'facet-spawn.ts'), 'utf8');
const ownedModelServices = readFileSync(join(import.meta.dir, '..', 'src', 'owned-model-services.ts'), 'utf8');
const generateJson = readFileSync(join(import.meta.dir, '..', '..', 'core', 'src', 'prompts', 'structured.ts'), 'utf8');
const takePick = readFileSync(join(import.meta.dir, '..', '..', 'core', 'src', 'read-models', 'evolution-views.ts'), 'utf8');

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
    expect(actor).toMatch(/createCFHeadRuntime\([\s\S]*?ownerUserId,[\s\S]*?this\.workspaceName\(\),/);
    expect(headRuntime).toContain('parentWorkspaceName: string');
    expect(headRuntime).toContain('sharedParent: parentWorkspaceName');
    expect(headRuntime).not.toContain('sharedParent: orchestrator.name');
    // A recursive split re-uses the ROOT it was given, never its own facet name.
    expect(exploration).toContain('sharedParent: this.identity.parentWorkspace()');
    // The spawn seam is what turns that into the child facet's persisted parent.
    expect(facetSpawn).toContain('await stub.setSharedParent(identity.sharedParent)');
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
    // The snapshot reads every OTHER plane live, at the step it is called.
    const snapshot = actor.slice(
      actor.indexOf('protected dynamicContextSnapshot(): DynamicContext {'),
      actor.indexOf('beforeStep(ctx: PrepareStepContext)'),
    );
    expect(snapshot).toContain('memoryTail: this._turnMemoryTail');
    expect(snapshot).toContain('this.renderFactsForTurn()');
    expect(snapshot).toContain('this.rt.executionRouter?.listExecutors()');
    expect(snapshot).toContain('this.jobs.listRunning()');
    expect(snapshot).toContain('this.headJournal.listLive()');
    // Which planes the block carries, and when one is omitted rather than
    // rendered empty, is core's (agentDynamicContext — pinned behaviourally in
    // core's unit-volatile-context.test.ts). This backend only says where each
    // plane is read from.
    expect(snapshot).toContain('agentDynamicContext({');
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
    expect(beforeTurn).toContain('lastTurnOpts.providerOptions = providerOptions');
  });

  test('provider-agnostic auxiliary calls use low effort without implicit output caps', () => {
    expect(exploration).not.toContain('maxOutputTokens');
    // Low effort is no longer DERIVED here. Both auxiliary calls (the MCTS
    // rollout and the recursive-split merge) ask the shared owner-scoped
    // services for it, and those services are the single place that turns an
    // effort level into provider options — pinned globally below rather than by
    // counting occurrences in this one file, which is strictly stronger: it
    // catches a second derivation added ANYWHERE, not just in exploration.ts.
    expect(exploration).not.toContain('reasoningEffortOptions');
    // Three askers: the MCTS rollout, the pruned-branch reflection, and the
    // recursive-split merge. All three used to funnel through one local helper
    // that derived the options itself; now they all ask the shared services.
    expect(exploration.match(/resolveModelWithEffort\([^)]*'low'\)/g)?.length).toBe(3);
    expect(ownedModelServices.match(/reasoningEffortOptions\(/g)?.length).toBe(1);
    expect(headRuntime).not.toContain('maxOutputTokens');
    expect(headRuntime).toContain("reasoningEffortOptions('low', parseModelSpec(spec).provider)");

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
    expect(closeArgs).toContain('error: errorText');
    expect(closeArgs).toContain('reason: result.status');
    // The per-turn records the spine is the only writer of. Dropping either
    // leaves the mechanism running and its durable trail silently empty.
    expect(closeArgs).toContain('steering: this.orch.steering.snapshot()');
    expect(closeArgs).toContain('craft: this.orch.craft.snapshot()');
  });

  test("the per-turn system prompt carries all three of the turn's axes", () => {
    // Permission, provenance and stance are three independent facts and cf
    // must pass all three: forcing them through one `mode` is what kept the
    // background-resume overlay off every real wake (jobs/runner.ts stamps
    // proteusEvent AND proteusMode, and the work mode used to win).
    const beforeTurn = actor.slice(
      actor.indexOf('const promptOptions: NonNullable<Parameters<typeof buildSystemPromptSync>[1]> = {'),
      actor.indexOf('this.recordSystemPromptHash(systemOverride)'),
    );
    expect(beforeTurn).toContain('workMode,');
    expect(beforeTurn).toContain('provenance: this.turnProvenance()');
    expect(beforeTurn).toContain('stance: this.config.getStance()');
    const turnMode = actor.slice(
      actor.indexOf('protected turnWorkMode(): WorkMode'),
      actor.indexOf('/** What this turn was started BY:'),
    );
    expect(turnMode).toContain('workModeForTurnMetadata(this.turnDrivingMetadata())');
    expect(turnMode).toContain('turnProvenanceForMetadata(this.turnDrivingMetadata())');
    expect(turnMode).toContain('if (!this._activeProgrammaticUserMessage) return this.turnUserMetadata();');
  });

  test('the stance the agent set is in the prompt the DO actually builds', async () => {
    // Not a source grep: the real prompt, off the real config store, through
    // the real cache key. Cutting `stance` out of either buildSystemPromptSync
    // call in actor-agent.ts fails this.
    const harness = orchestratorHarness();
    const agent = harness.agent;
    expect(agent.getSystemPrompt()).not.toContain('Audit stance:');

    const tasks = v.parse(TasksToolProbeSchema, agent.getTools().tasks);
    const result = v.parse(StanceResultSchema, await tasks.execute({ action: 'mode', stance: 'audit' }));
    expect(result.stance).toBe('audit');
    expect(agent.getSystemPrompt()).toContain('Audit stance:');
  });

  test('the DO holds a keepAlive heartbeat until BOTH evolution lanes settle', () => {
    // Parity with the CLI, which awaits orch.settleEvolution() before the
    // process exits. Evolution is detached so it never blocks the TurnQueue —
    // but Think's own keepAliveWhile disposes when onChatResponse returns, so
    // without a settle heartbeat the detached LLM calls race DO eviction.
    //
    // The DO holds BOTH lanes: the turn lane (settleEvolution) and the
    // cadence-heavy session pass (runDueSessionEvolution). It is the host that
    // CAN afford the heavy pass — keepAlive is exactly what a one-shot
    // `proteus exec` process lacks, which is why that one defers it instead.
    const settle = actor.slice(
      actor.indexOf('protected settleEvolutionInBackground(): void'),
      actor.indexOf("   * The completed turn's evolution spine"),
    );
    expect(settle).toContain('if (this._evolutionSettling) return;');
    expect(settle).toContain('await this.orch.settleEvolution();');
    expect(settle).toContain('await this.orch.runDueSessionEvolution();');
    expect(settle).toContain('.finally(() => { this._evolutionSettling = false; });');
    // Detached — awaiting it in onChatResponse would re-block the TurnQueue.
    expect(settle).toContain('void this.keepAliveWhile');

    // …and the shared post-turn spine actually calls it, after recordTurn
    // dispatched — for EVERY actor, not just the orchestrator.
    const spine = actor.slice(
      actor.indexOf('protected settleCompletedTurn('),
      actor.indexOf('protected get scaffoldControl()'),
    );
    const recordTurn = spine.indexOf('this.orch.recordTurn(turn, this._turnContinuity);');
    const settleCall = spine.indexOf('this.settleEvolutionInBackground();');
    expect(recordTurn).toBeGreaterThan(-1);
    expect(settleCall).toBeGreaterThan(recordTurn);
    // The promotion gate's trial is queued THROUGH the engine, which holds the
    // one auto-evolution gate. Calling core's queueTurnShadowTrial from here
    // instead is how a `--no-auto-evolve` run came to leave trial rows behind.
    expect(spine).toContain('this.engine.queueShadowTrial(turn,');
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
