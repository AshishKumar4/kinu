import type { ModelMessage, ToolSet } from 'ai';
import * as v from 'valibot';
import { INTERRUPTED_TURN, type ChatEvent, type ChatOptions } from '../chat';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ResolvedTurnProfile, ProfileAuthorityInputs } from '../profiles';
import type { WorkMode } from '../types/turn';
import { DynamicContextLedger, type DynamicContext } from '../prompting/volatile-context';
import { promptCacheWarm, PromptCacheRouteSchema, type CachedRequest } from '../prompting/cache-breakpoints';
import type { KinuExtension } from '../extension';
import { ExtensionHost } from '../extension';
import { KinuError, renderThrownChain } from '../obs/index';
import { AgentOrchestrator, type AgentOrchestratorDeps } from './agent-orchestrator';
import { describeLandedSteers, type AcceptedSteer, type LandedSteerRow, type UserSteer } from './inbox';
import { startActorTurn } from './actor-turn';
import type { ChatTurnInput } from './chat-session';
import { captureOperationProfile, currentOperationProfile, operationProfileStream } from '../profiles/operation';
import { prepareActorProgram, type ActorTurnProgram } from './actor-program';
import {
  programIdentityOf, type ActorClaimStore, type ActorTurnClaim, type ClaimOutcome,
} from './actor-claims';
import type { ContextEventRecorder } from '../types/context-plane';
import type { ContextEntry, ContextSelection } from '../session/context';
import type { JsonObject } from '../utils/json';
import type { ScaffoldBridgeOpts } from './scaffold-host';
import type { ModelCallSpend } from '../events/model-call';
import type { AgentSignal, SendOutcome } from '../types/signals';
import { USER_MESSAGE_SIGNAL_KIND } from '../types/signals';
import type { VFS } from '../types/primitives';
import type { AgentConfigStore } from '../config/store';
import type { CompletedTurn } from '../evolution/types';
import {
  reviewRecordedTurn, startAdvisorLane,
  type AdvisorLaneStart, type AdvisorRecoverySnapshot, type AdvisorDisposition,
} from '../advisor/review';
import { advisorWorkspaceGuidance } from '../prompting/agents-md';
import { resolveModelRoute } from '../profiles/model-route';
import { contextWindowForModel } from '../context-window';
import { SessionHistory } from '../session/history';
import { SessionStream } from './session-stream';
import { steerUserMessage } from './inbox';
import type { MessageReference, MessagePartReference, PreparedMessage } from '../session/messages';

/** A hosted actor shares workspace priorities, but delivers feedback to itself. */
export interface ActorAdvisorContext {
  readonly config: AgentConfigStore;
  readonly workspace: () => Promise<VFS>;
  readonly parent: (signal: AgentSignal) => Promise<SendOutcome>;
}

export interface ActorSessionOptions {
  readonly runtime: AgentRuntime;
  readonly orchestration: AgentOrchestratorDeps;
  /** Required: a turn that cannot write its claim cannot issue an effect. */
  readonly claims: ActorClaimStore;
  readonly history: SessionHistory;
  /** Null is recorded and read back as unknown, never filled in from a placeholder version or descriptor. */
  readonly installedBuild: string | null;
  /** Optional: the revision rows are the durable record; no recorder means no event, never a fabricated one. */
  readonly events?: ContextEventRecorder | null;
  readonly advisor?: ActorAdvisorContext;
}

/** Live-instance execution token, not a replacement for a durable turn/run claim. */
export interface ActorTurnLease {
  readonly actorId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly signal: AbortSignal;
}

export interface ActorExecutionInput {
  readonly task: string;
  readonly loopVersion: number;
  readonly chat: Omit<ChatOptions, 'history' | 'signal' | 'extensions' | 'meter' | 'dynamicContext'>;
  readonly extensions: readonly KinuExtension[];
  readonly dynamic: (profile: ResolvedTurnProfile, tools: ToolSet) => DynamicContext;
  readonly scaffoldSpend?: ModelCallSpend;
  /** Re-checked before each model call, for kinds whose liveness is owned elsewhere (heads, swarm nodes). */
  readonly assertActive?: () => void;
  readonly scaffoldStreamOptions?: ScaffoldBridgeOpts['streamOptions'];
  /** A warming lane's cover. */
  readonly cacheKeptAliveUntil?: number | null;
}

const RequestCacheSchema = v.looseObject({ cache: v.optional(PromptCacheRouteSchema) });

/** Without a route: an unknown provider's. */
function cachedRequestOf(last: { readonly recordedAt: number; readonly metadata: string | null }): CachedRequest {
  const parsed = last.metadata === null ? null : v.safeParse(RequestCacheSchema, JSON.parse(last.metadata));

  return { at: last.recordedAt, ...(parsed?.success === true ? parsed.output.cache : undefined) ?? { retention: 'short' } };
}

export interface ActorExecutionResult {
  readonly text: string;
  /** The runner's selected answer, or null when the steps carried none. */
  readonly answer: string | null;
  /** A continuation reads it to tell whether the answer is the cut step it resumed. */
  readonly steps: number;
  readonly failure: Error | null;
  readonly interrupted: boolean;
  /** Null when preparation failed before any program was selected. */
  readonly program: ActorTurnProgram | null;
  /** Written before the first effect; null only when preparation failed before admission. */
  readonly claim: ActorTurnClaim | null;
  /** What the first request sent, else the admitted context; empty without a claim. */
  readonly admittedMessages: readonly ModelMessage[];
  readonly outputReferences: readonly MessageReference[];
  readonly outputPartReferences: readonly MessagePartReference[];
  readonly finalTextReference: MessagePartReference | null;
}

interface ActiveTurn {
  readonly lease: ActorTurnLease;
  readonly abort: AbortController;
  phase: 'preparing' | 'running' | 'settling';
  profile: ResolvedTurnProfile | null;
  profileInputs: ProfileAuthorityInputs | null;
  /** Never cleared: a settled turn's claim still attributes its late work. */
  claim: ActorTurnClaim | null;
  claimSettled: boolean;
}

export const REVERT_NEEDS_IDLE = 'Stop the turn that is running before you revert the conversation.';

/** An actor's mutable execution state, apart from its host, which keeps admission, queueing and settlement and
 *  may share immutable catalogs, never this context, orchestrator or abort. */
export class ActorSession {
  readonly actorId: string;
  readonly runtime: AgentRuntime;
  readonly orchestrator: AgentOrchestrator;
  readonly canonical: SessionHistory;
  /** Every rewrite of the model-visible stream resets it; its blocks are stored. */
  readonly dynamic = new DynamicContextLedger(true);
  private readonly messages: ModelMessage[] = [];
  private readonly landed: LandedSteerRow[] = [];
  private active: ActiveTurn | null = null;
  private mode: WorkMode = 'build';
  private restoration: Promise<void> = Promise.resolve();

  constructor(private readonly options: ActorSessionOptions) {
    this.actorId = options.runtime.actor.actorId;
    this.runtime = options.runtime;
    this.canonical = options.history;

    this.orchestrator = new AgentOrchestrator(options.orchestration, {
      onDrain: (steers, atStep) => this.landSteers(steers, atStep),
      turnId: () => this.active?.lease.turnId ?? null,
    });
  }

  /** Called once, when the owning session is built. `landed` is recorded only after `onDrain` returns, so a failed write leaves no unseen row. */
  bindSteerPersistence(deps: {
    readonly onAccept?: (steer: AcceptedSteer) => void;
    readonly prepareDrain?: (rows: readonly LandedSteerRow[], atStep: number, reference: MessageReference) => Promise<(selection: ContextSelection) => void>;
    readonly turnId?: () => string | null;
    readonly skills?: (text: string) => Promise<string | null>;
  }): void {
    this.orchestrator.inbox.bindSteerDeps({
      onAccept: deps.onAccept,
      onDrain: (steers, atStep) => this.landSteers(steers, atStep, deps.prepareDrain),
      turnId: () => deps.turnId?.() ?? this.active?.lease.turnId ?? null,
      skills: deps.skills,
    });
  }

  private async landSteers(steers: readonly UserSteer[], atStep: number, prepareDrain?: (rows: readonly LandedSteerRow[], atStep: number, reference: MessageReference) => Promise<(selection: ContextSelection) => void>): Promise<ModelMessage> {
    const rows = describeLandedSteers(steers, atStep);
    const claim = this.active?.claim;

    if (claim === undefined || claim === null) throw new KinuError('denied', 'steer landing requires an admitted claim');
    const id = `steers:${steers.map(steer => steer.id ?? `${claim.turnId}:${atStep}`).join(':')}`;
    const existing = this.canonical.admittedInput(id);
    let prepared: PreparedMessage | null = null;
    let reference: MessageReference;

    if (existing === null) {
      prepared = await this.canonical.messages.prepare(steerUserMessage(steers), id);
      reference = { messageId: id };
    } else {
      reference = existing;
    }

    const publish = await prepareDrain?.(rows, atStep, reference);
    this.canonical.landInput({
      prepared, reference, turnId: claim.turnId,
      assertOwner: () => { this.canonical.assertEpoch(claim.turnId, claim.epoch); }, publish,
    });
    const message = await this.canonical.messages.materialize(reference);
    this.landed.push(...rows);

    return message;
  }

  get history(): readonly ModelMessage[] { return this.messages; }
  get workMode(): WorkMode { return this.mode; }
  get profile(): ResolvedTurnProfile | null { return currentOperationProfile(this.runtime.actor)?.profile ?? this.active?.profile ?? null; }
  get profileInputs(): ProfileAuthorityInputs | null {
    const operation = currentOperationProfile(this.runtime.actor);

    return operation ? operation.inputs : this.active?.profileInputs ?? null;
  }
  get landedSteers(): readonly LandedSteerRow[] { return this.landed; }
  get inFlight(): boolean { return this.active !== null && this.active.phase !== 'settling'; }

  lastRequestAt(): number | null {
    return this.canonical.requests.lastStep()?.recordedAt ?? null;
  }
  /** A host settles the claim under the outcome it named. */
  get turnClaim(): ActorTurnClaim | null { return this.active?.claim ?? null; }

  get advisorEnabled(): boolean {
    return (this.options.advisor?.config ?? this.runtime.actor.config).getAdvisorEnabled();
  }

  advisorSnapshot(turn: CompletedTurn, reachable: readonly string[]): AdvisorRecoverySnapshot {
    const profile = this.profile;

    return {
      turn: this.orchestrator.scopedTurn(turn),
      reachable: [...reachable],
      recent: [...this.options.orchestration.engine.recentAdvisorNotes()],
      minSeverity: (this.options.advisor?.config ?? this.runtime.actor.config).getAdvisorMinSeverity(),
      model: profile === null || !this.advisorEnabled ? undefined : resolveModelRoute('advisor', profile).model,
    };
  }

  startAdvisorLane(lane: AdvisorLaneStart): Promise<void> {
    if (this.runtime.advisorLlm === undefined || !this.advisorEnabled) return Promise.resolve();

    return startAdvisorLane({ sql: this.runtime.storage.sql, actor: this.runtime.actor }, lane);
  }

  /** Per-turn feedback never calls recordTurn or changes the learning window. */
  async reviewTurn(
    snapshot: AdvisorRecoverySnapshot,
    gateOpen = false,
    send: (signal: AgentSignal) => Promise<SendOutcome> = (signal) => this.orchestrator.inbox.send(signal),
  ): Promise<AdvisorDisposition | null> {
    const { engine, budget } = this.options.orchestration;
    const turnId = snapshot.turn.turnId;
    const llm = this.runtime.advisorLlm;

    if (!this.advisorEnabled || llm === undefined || (turnId && engine.hasAdvisorNoteForTurn(turnId))) return null;
    const contextWindow = contextWindowForModel(snapshot.model ?? '').window;

    const workspace = await this.options.advisor?.workspace()
      ?? this.runtime.agentStateVfs ?? this.runtime.storage.vfs;

    return reviewRecordedTurn({
      snapshot,
      actor: this.runtime.actor,
      llm,
      govern: (model, labels) => budget?.govern(model, labels) ?? model,
      gateOpen,
      guidance: await advisorWorkspaceGuidance({
        vfs: workspace,
        limits: async () => ({ contextWindow, modelOutputLimit: null }),
      }),
      send,
      parent: this.options.advisor?.parent,
      record: (note, id) => { engine.recordAdvisorNote(note, id); },
    });
  }

  /** An active turn stages authored replacement; idle replacement commits immediately. */
  restoreHistory(messages: readonly ModelMessage[]): Promise<string | null> {
    const active = this.active;

    return this.restoreAfterPending(async () => {
      const receipt = await this.canonical.replaceHistory(messages, { author: this.actorId, via: 'session', turnId: active?.lease.turnId ?? null, stage: active !== null, assertOwner: () => this.runtime.actor.assertCurrent(), events: this.options.events });

      if (receipt.proposalId === null) {
        const current = await this.canonical.materialize();
        this.messages.splice(0, this.messages.length, ...current.messages);
      }

      return receipt.proposalId;
    });
  }

  /** Refused while a turn is in flight; `assertIdle` is the host's further condition, raised in the same transaction. */
  async revertConversation(sessionId: string, entryId: string, assertIdle: () => void): Promise<void> {
    this.canonical.revertTo(sessionId, entryId, () => {
      if (this.inFlight) throw new KinuError('denied', REVERT_NEEDS_IDLE);
      assertIdle();
    });
    this.dynamic.unload();
    await this.restoreWorkingHistory();
  }

  restoreWorkingHistory(): Promise<boolean> {
    return this.restoreAfterPending(async () => {
      const current = await this.canonical.materialize();
      this.messages.splice(0, this.messages.length, ...current.messages);

      return current.selection.revision !== 0 || current.entries.length !== 0 || this.canonical.proposals.pending(current.selection.contextId).length !== 0;
    });
  }

  private restoreAfterPending<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.restoration.then(operation);
    this.restoration = pending.then(() => {});
    this.orchestrator.track(this.restoration, 'restoring actor context');

    return pending;
  }

  private preparingTurnFence(lease: ActorTurnLease, refusal: string): () => void {
    return () => {
      this.runtime.actor.assertCurrent();

      if (this.requireTurn(lease).phase !== 'preparing') throw new KinuError('denied', refusal);
    };
  }

  /** Open a durable assignment. The lease's turn id is the delivery identity, so a re-drive admits a task once,
   *  even beside an equal text. Birth context applies only before the first turn. */
  async openDelegatedTurn(lease: ActorTurnLease, input: {
    readonly messages: readonly ModelMessage[];
    readonly birthContext: () => Promise<readonly ModelMessage[]>;
  }): Promise<void> {
    await this.restoration;

    const assertOwner = this.preparingTurnFence(lease, 'delegated input requires a preparing turn');

    const current = await this.canonical.materialize();

    if (current.selection.revision === 0 && current.entries.length === 0 && this.canonical.proposals.pending(current.selection.contextId).length === 0) {
      const birth = await input.birthContext();

      if (birth.length > 0) await this.canonical.replaceHistory(birth, { author: this.actorId, via: 'runtime', turnId: null, stage: false, assertOwner });
    }

    for (const [index, message] of input.messages.entries()) {
      const reference = await this.canonical.admitInput({ id: index === 0 ? lease.turnId : `${lease.turnId}:input:${index}`, message, turnId: lease.turnId, assertOwner });
      this.canonical.activateInput(reference, lease.turnId, assertOwner);
    }

    const opened = await this.canonical.materialize();
    this.messages.splice(0, this.messages.length, ...opened.messages);
  }

  /** The one rule for where a turn's conversation comes from: a delivery turn (`metadata.drainTurnId`) opens on the settled working revision; others append. */
  async openTurnInput(lease: ActorTurnLease, input: {
    readonly item: Pick<ChatTurnInput, 'metadata'>;
    readonly message: ModelMessage;
    readonly birthContext: (drainTurnId: string) => Promise<readonly ModelMessage[]>;
  }): Promise<void> {
    await this.restoration;

    const assertOwner = this.preparingTurnFence(lease, 'input must belong to a preparing turn');

    const restored = await this.canonical.materialize();
    const drainTurn = v.safeParse(v.string(), input.item.metadata?.drainTurnId);

    if (restored.entries.length === 0 && restored.selection.revision === 0 && drainTurn.success && this.canonical.proposals.pending(restored.selection.contextId).length === 0) {
      for (const [index, message] of (await input.birthContext(drainTurn.output)).entries()) await this.canonical.append({ id: `${lease.turnId}:birth:${index}`, message, origin: 'input', turnId: lease.turnId, assertOwner });
    }

    const acceptedInput = await this.canonical.admitInput({ id: lease.turnId, message: input.message, turnId: lease.turnId, assertOwner });
    this.canonical.activateInput(acceptedInput, lease.turnId, assertOwner);

    const opened = await this.canonical.materialize();
    this.messages.splice(0, this.messages.length, ...opened.messages);
  }



  /** A recovered activation re-admitting the same turn writes its own run id under a new epoch. */
  beginTurn(
    ids: { readonly runId: string; readonly turnId: string },
    mode: WorkMode,
    startedAt: number,
    metadata?: JsonObject,
  ): ActorTurnLease {
    if (this.active !== null) throw new KinuError('denied', 'this actor already has an admitted turn');
    const abort = new AbortController();

    const lease: ActorTurnLease = Object.freeze({
      actorId: this.actorId, runId: ids.runId, turnId: ids.turnId, signal: abort.signal,
    });

    this.active = {
      lease, abort, phase: 'preparing', profile: null, profileInputs: null,
      claim: null, claimSettled: false,
    };
    this.mode = mode;
    this.landed.length = 0;
    this.orchestrator.beginTurn(startedAt, metadata);
    this.orchestrator.restrictTurnWorkMode(mode);

    return lease;
  }

  bindProfile(lease: ActorTurnLease, profile: ResolvedTurnProfile, inputs: ProfileAuthorityInputs): void {
    const turn = this.requireTurn(lease);

    if (turn.phase !== 'preparing' || turn.profile !== null) throw new KinuError('denied', 'an actor turn profile is bound exactly once before execution');

    if (this.mode === 'plan' && profile.workMode !== 'plan') throw new KinuError('denied', 'an actor profile cannot widen an admitted Plan turn');
    turn.profile = profile;
    turn.profileInputs = inputs;
    this.mode = profile.workMode;
    this.orchestrator.restrictTurnWorkMode(this.mode);
  }

  send(steer: UserSteer & { readonly id: string; readonly mode?: WorkMode }): Promise<SendOutcome> {
    return this.orchestrator.inbox.send({
      kind: USER_MESSAGE_SIGNAL_KIND,
      text: steer.text,
      user: {
        id: steer.id,
        // A leftover reruns under the mode its words were typed in.
        mode: steer.mode ?? this.mode,
        ...(steer.files !== undefined && { files: steer.files }),
      },
    });
  }

  interrupt(): readonly UserSteer[] {
    const dropped = this.orchestrator.inbox.interrupt();
    this.stop();

    return dropped;
  }

  /** Unread input stays queued for the settle to rerun. */
  stop(): void {
    if (this.active?.phase !== 'settling') this.active?.abort.abort();
  }

  /** An unnamed outcome settles `indeterminate`, never `completed`. */
  finishTurn(lease: ActorTurnLease): void {
    const active = this.requireTurn(lease);

    if (active.phase === 'running') throw new KinuError('denied', 'cannot release an actor while its program is running');

    if (active.claim !== null && !active.claimSettled) this.settleClaim(active, 'indeterminate');
    this.active = null;
  }

  /** Called once the turn's answer is durable. */
  settleTurnClaim(lease: ActorTurnLease, outcome: ClaimOutcome): void {
    const active = this.requireTurn(lease);

    if (active.claim === null) throw new KinuError('denied', 'this actor turn holds no durable claim to settle');
    this.settleClaim(active, outcome);
  }

  private settleClaim(active: ActiveTurn, outcome: ClaimOutcome): void {
    if (active.claim === null || active.claimSettled) return;
    this.options.claims.settle(active.claim, outcome);
    active.claimSettled = true;
  }

  /** Prepare, claim durably, then consume: `startActorTurn` runs nothing until the first `next()`, so a crash
   *  before the claim leaves a turn that provably did nothing. */
  async execute(lease: ActorTurnLease, input: ActorExecutionInput, emit: (event: ChatEvent) => void | Promise<void>): Promise<ActorExecutionResult> {
    const active = this.requireTurn(lease);

    if (active.phase !== 'preparing' || active.profile === null) throw new KinuError('denied', 'a profiled actor turn executes once');
    const profile = active.profile;
    const allowedTools = new Set(profile.allowedTools);
    const tools = Object.fromEntries(Object.entries(input.chat.tools ?? {}).filter(([name]) => allowedTools.has(name)));
    const extensions = new ExtensionHost();

    for (const extension of input.extensions) extensions.register(extension);
    extensions.register(this.orchestrator.turnExtension);
    const pending: Array<Extract<ChatEvent, { type: 'tool-call' }>> = [];
    let text = '';
    let answer: string | null = null;
    let steps = 0;
    let completed = false;
    let program: ActorTurnProgram | null = null;
    let failure: Error | null = null;
    let durableOutput: SessionStream | null = null;
    let admittedMessages: readonly ModelMessage[] = [];

    try {
      active.phase = 'running';
      active.abort.signal.throwIfAborted();
      const control = { signal: active.abort.signal };
      program = await prepareActorProgram({
        ...control, runtime: this.runtime, mode: this.mode, version: input.loopVersion,
      });
      const admitted = await this.canonical.materialize();
      this.messages.splice(0, this.messages.length, ...admitted.messages);

      const claim = await this.options.claims.admit({
        runId: lease.runId,
        turnId: lease.turnId,
        workMode: this.mode,
        program: programIdentityOf(program, this.options.installedBuild),
        context: admitted.selection,
      });

      active.claim = claim;
      admittedMessages = admitted.messages;
      durableOutput = new SessionStream(this.canonical, lease.turnId, claim.epoch);
      const stream = durableOutput;
      // Activation names the input's entry after its message; an edit keeps the entry.
      const turnInput = this.canonical.admittedInput(claim.turnId);
      const assertClaim = () => this.canonical.assertEpoch(claim.turnId, claim.epoch);
      let stepEntries: readonly ContextEntry[] = [];
      let turnOpened = false;

      const events = operationProfileStream(startActorTurn({
        runtime: this.runtime, mode: this.mode, task: input.task, loopVersion: input.loopVersion,
        program, scaffoldSpend: input.scaffoldSpend,
        assertActive: input.assertActive,
        scaffoldStreamOptions: input.scaffoldStreamOptions,
        chat: { ...input.chat, tools, history: this.messages, signal: active.abort.signal, extensions,
          measureContext: true,
          persistStreamPart: part => stream.nativePart(part),
          persistStep: messages => stream.nativeStep(messages),
          dynamicContext: { ledger: this.dynamic, snapshot: () => input.dynamic(profile, tools) },
          stepContext: {
            base: async () => {
              const base = await this.canonical.stepBase(assertClaim, claim.turnId, this.options.events ?? null);
              this.messages.splice(0, this.messages.length, ...base.messages);
              stepEntries = base.entries;

              // A cold cache makes rewriting free: the stored blocks collapse into one.
              if (!turnOpened) {
                turnOpened = true;
                const last = this.canonical.requests.lastStep();

                if (!promptCacheWarm(last === null ? null : cachedRequestOf(last), Date.now(), input.cacheKeptAliveUntil ?? null)) this.dynamic.reset();
              }

              this.dynamic.adopt(base.rendered.map(render => ({ text: v.parse(v.string(), render.message.content), before: render.before, after: render.after })));
              const turnStart = turnInput === null ? -1 : base.entries.findIndex(entry => entry.entryId === turnInput.messageId);

              return { messages: base.messages, changed: base.changed, ...(turnStart >= 0 && { turnStart }) };
            },
            consume: async ({ stepNumber, messages, cache }) => {
              for (const birth of this.dynamic.takeBirths()) {
                const entry = birth.before === null ? undefined : stepEntries[this.messages.indexOf(birth.before)];
                await this.canonical.recordRender({ role: 'user', content: birth.text }, { before: entry?.entryId ?? null, replaces: birth.replaces }, claim.turnId, assertClaim);
              }

              const consumed = await this.options.claims.consume(claim, { index: stepNumber, messages, cache });

              if (stepNumber === 0) admittedMessages = [...messages];
              stream.beginRequest(consumed.requestId, stepNumber);
            },
          } } satisfies ChatOptions,
      }), captureOperationProfile({
        actor: this.runtime.actor, profile: active.profile,
        inputs: active.profileInputs, runId: lease.runId, turnId: lease.turnId,
      }));

      for await (const event of events) {
        this.requireTurn(lease);
        await stream.observe(event);

        switch (event.type) {
          case 'text-delta': this.orchestrator.acc.onFirstChunk(); text += event.delta; break;
          case 'tool-call': pending.push(event); break;
          case 'tool-result': this.recordToolResult(pending, event); break;

          // Reasoning is never the turn's answer.
          case 'reasoning-delta':
          case 'model-fallback':
            break;

          case 'step-finish':
            steps += 1;
            this.orchestrator.acc.recordStep({
              text: event.text, finishReason: event.finishReason, toolCalls: event.toolCalls, toolResults: event.toolResults,
              response: { messages: event.responseMessages, modelId: event.modelId }, usage: event.usage,
              request: event.request, context: event.context, account: event.account, fallback: event.fallback,
            });
            break;
          case 'error': {
            this.orchestrator.acc.hadError = true;

            // The scaffold loop pushes an `error` event rather than throwing, so an empty turn never settles `completed`.
            // First failure wins; an abort is not one.
            if (failure === null
              && !active.abort.signal.aborted
              && event.message !== INTERRUPTED_TURN) {
              failure = new Error(event.message);
            }

            break;
          }

          case 'done':
            this.messages.push(...this.orchestrator.inbox.replayInto(event.responseMessages));

            // The runner's `done` answer wins over the concatenated deltas; deltas are the fallback when there is no `done`.
            if (event.text.trim()) text = event.text;

            if (event.answer !== undefined && event.answer.trim()) answer = event.answer;
            completed = true;
            break;
        }

        await emit(event);
      }
    } catch (cause) {
      if (!completed) this.messages.push(...this.orchestrator.inbox.recordedMessages());
      failure = cause instanceof Error ? cause : new Error(renderThrownChain({ cause }), { cause });

      if (failure.message !== INTERRUPTED_TURN && !active.abort.signal.aborted) this.orchestrator.acc.hadError = true;
      await emit({ type: 'error', message: renderThrownChain({ cause }) });
    } finally {
      active.phase = 'settling';

      if (active.claim !== null) {
        await durableOutput?.settle();
        const settled = await this.canonical.materialize();
        this.messages.splice(0, this.messages.length, ...settled.messages);
      }
    }

    const output = await this.canonical.outputForTurn(lease.turnId);
    const outputReferences = output.messages;
    const said = await this.saidText(outputReferences, text, answer);

    return {
      text: said.text, answer, steps, failure, program, claim: active.claim,
      interrupted: active.abort.signal.aborted || failure?.message === INTERRUPTED_TURN,
      admittedMessages,
      outputReferences, finalTextReference: said.reference,
      outputPartReferences: output.parts,
    };
  }

  /** What the turn said: its answer, else the last text it streamed. */
  private async saidText(output: readonly MessageReference[], text: string, answer: string | null): Promise<{ readonly text: string; readonly reference: MessagePartReference | null }> {
    const streamed = await this.lastText(output);
    const said = answer === null && streamed !== null ? streamed.text : text;

    return { text: said, reference: said !== '' && streamed?.text === said ? streamed.reference : null };
  }

  private async lastText(output: readonly MessageReference[]): Promise<{ readonly reference: MessagePartReference; readonly text: string } | null> {
    for (let index = output.length - 1; index >= 0; index--) {
      const reference = output[index];

      if (reference === undefined) continue;
      const parts = await this.canonical.messages.materializeParts(reference);

      for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
        const part = parts[partIndex];

        if (part?.value.type === 'text') return { reference: { messageId: reference.messageId, partNo: part.partNo }, text: v.parse(v.string(), part.value.text) };
      }
    }

    return null;
  }

  async recordTranscriptText(claim: ActorTurnClaim, purpose: 'answer' | 'report', text: string, output: readonly MessageReference[]): Promise<MessagePartReference | null> {
    if (text === '') return null;
    const streamed = await this.lastText(output);
    this.canonical.assertClaimEpoch(claim.turnId, claim.epoch);

    if (streamed?.text === text) return streamed.reference;
    const id = `${claim.turnId}:${claim.epoch}:display-${purpose}`;
    const prepared = await this.canonical.messages.prepare({ role: 'assistant', content: text }, id);

    return this.runtime.storage.transactionSync(() => {
      this.canonical.assertClaimEpoch(claim.turnId, claim.epoch);
      this.canonical.messages.insert(prepared, 'render');

      return { messageId: id, partNo: 0 };
    });
  }

  /** Last-in-first-out match: a later call with the same id already matched and was removed. */
  private recordToolResult(
    pending: Array<Extract<ChatEvent, { type: 'tool-call' }>>,
    event: Extract<ChatEvent, { type: 'tool-result' }>,
  ): void {
    let index = pending.length - 1;

    while (index >= 0 && pending[index]?.toolCallId !== event.toolCallId) index--;
    const call = index < 0 ? undefined : pending.splice(index, 1)[0];
    // The ledger records the returned value; a tool that returned nothing records its rendered text.
    const timed = event.durationMs === undefined ? {} : { durationMs: event.durationMs };
    this.orchestrator.acc.recordToolCall(event.success
      ? { toolCallId: event.toolCallId, toolName: event.toolName, input: call?.args ?? {}, success: true, failures: event.failures, output: event.output ?? event.result, ...timed }
      : { toolCallId: event.toolCallId, toolName: event.toolName, input: call?.args ?? {}, success: false, reason: event.reason, failures: event.failures,
          execution: event.execution, error: event.error ?? event.result, ...timed });
  }

  private requireTurn(lease: ActorTurnLease): ActiveTurn {
    if (this.active?.lease !== lease) throw new KinuError('denied', 'the actor turn lease is no longer active');

    return this.active;
  }
}
