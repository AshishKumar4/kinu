import type { ModelMessage, ToolSet } from 'ai';
import * as v from 'valibot';
import { INTERRUPTED_TURN, type ChatEvent, type ChatOptions } from '../chat';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ResolvedTurnProfile, ProfileAuthorityInputs } from '../profiles';
import type { WorkMode } from '../types/turn';
import { DynamicContextLedger, type DynamicContext } from '../prompting/volatile-context';
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
import type { ContextSelection } from '../session/context';
import type { JsonObject } from '../utils/json';
import type { ScaffoldBridgeOpts } from './scaffold-host';
import type { ModelCallSpend } from '../events/model-call';
import type { AgentSignal, SendOutcome } from '../types/signals';
import { USER_MESSAGE_SIGNAL_KIND } from '../types/signals';
import type { VFS } from '../types/primitives';
import type { AgentConfigStore } from '../config/store';
import type { CompletedTurn } from '../evolution/types';
import { reviewRecordedTurn, type AdvisorRecoverySnapshot, type AdvisorDisposition } from '../advisor/review';
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
  /** The actor's durable claim ledger. REQUIRED: a turn that cannot write its
   *  claim cannot issue an effect, so there is no arm of this class that runs
   *  without one and no host that may decline to wire it. */
  readonly claims: ActorClaimStore;
  readonly history: SessionHistory;
  /**
   * The installed build the host publishes for its BUILTIN loop, or null when
   * it publishes none.
   *
   * Null is recorded as unknown and read back as unknown. It is not filled in
   * from a package version that ships as a placeholder, from a descriptor, or
   * from a digest of the words that name the builtin arm: a claim that says
   * "this ran under build X" when nobody knows X is worse than one that says
   * the build is unknown.
   */
  readonly installedBuild: string | null;
  /**
   * The actor's run-event recorder, for the context-edit evidence the working
   * history writes.
   *
   * Optional and null-tolerant on purpose: the revision rows are the durable
   * record either way, and a host with no recorder gets no event rather than a
   * fabricated one.
   */
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
  /** Re-checked by the runner before each model call, for a kind whose
   *  liveness is owned outside this session (a head or a swarm node whose
   *  controller may have finished with it). */
  readonly assertActive?: () => void;
  /** Stream options the scaffold bridge passes through, for the same kinds. */
  readonly scaffoldStreamOptions?: ScaffoldBridgeOpts['streamOptions'];
}

export interface ActorExecutionResult {
  readonly text: string;
  /** The turn's answer as the runner selected it (the final step's text),
   *  or null when the steps carried none and `text` is what streamed or a
   *  synthesis of the tool results. */
  readonly answer: string | null;
  /** How many steps the turn finished in this process. A continuation reads
   *  it to tell whether the answer is the cut step it resumed (one step) or a
   *  later step whose narration the cut text belongs to. */
  readonly steps: number;
  readonly failure: Error | null;
  readonly interrupted: boolean;
  /** Null when preparation failed before any program was selected. */
  readonly program: ActorTurnProgram | null;
  /** The durable claim this execution ran under — written before the first
   *  effect, and the identity every revision of the turn is keyed to. Null
   *  only when preparation failed before the claim was admitted. */
  readonly claim: ActorTurnClaim | null;
  /** Admission evidence from the claim ledger; empty when no claim was admitted. */
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
  /** Set the moment the durable claim is admitted, cleared never: a settled
   *  turn's claim is still the identity its late work is attributed to. */
  claim: ActorTurnClaim | null;
  claimSettled: boolean;
}

/** One refusal, one sentence: the walk-back is refused by whatever sees work in
 *  flight first — this actor's own turn, or the queue its host's loop holds —
 *  and the operator reads the same thing either way. */
export const REVERT_NEEDS_IDLE = 'Stop the turn that is running before you revert the conversation.';

/** A logical actor's mutable execution state, independent of its physical host.
 * The host retains admission, queueing and durable/effect settlement. It may
 * share immutable catalogs, never this actor's context, orchestrator or abort. */
export class ActorSession {
  readonly actorId: string;
  readonly runtime: AgentRuntime;
  readonly orchestrator: AgentOrchestrator;
  readonly canonical: SessionHistory;
  /**
   * The one ledger of woven dynamic-context blocks: the turn weaves through
   * it, the host's compaction plane prunes it, and every rewrite of the
   * model-visible stream (a new compaction plan, a walk-back, a cleared
   * conversation) resets it, because frozen block positions mean nothing
   * against a stream they were not positioned in. In-memory only, so a cold
   * start attaches exactly one fresh block.
   */
  readonly dynamic = new DynamicContextLedger();
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

  /** Bind the backend's durable steer persistence onto this actor's inbox.
   *  Called once, when the session that owns the actor is built — the actor
   *  itself is created inside `createActorHost`, which has no opinion about
   *  where a CLI workspace keeps its accepted sends.
   *
   *  `onDrain` sees the DESCRIBED rows (the same shape `landedSteers`
   *  records), so the backend writes exactly the ids the durable transcript
   *  will carry; `landed` is only recorded after it returns, so a failed
   *  write cannot leave a row the backend never saw. `turnId` defaults to
   *  the live turn's id when the binding does not need a queue-aware view. */
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
  /** The admitted turn's durable claim, or null before it is written. A host
   *  reads it to settle the claim under the outcome IT named. */
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

  /**
   * Continue the chat from before `entryId`, on the context the actor held
   * there. One path for every backend: the durable head and the context
   * selection move together inside the store's transaction, the woven dynamic
   * blocks are forgotten with the stream they were positioned in, and the
   * working history is re-read from the store. Refused while a turn is in
   * flight here; `assertIdle` is the host's own further condition (a queued
   * turn its loop holds, say), raised inside the same transaction.
   */
  async revertConversation(sessionId: string, entryId: string, assertIdle: () => void): Promise<void> {
    this.canonical.revertTo(sessionId, entryId, () => {
      if (this.inFlight) throw new KinuError('denied', REVERT_NEEDS_IDLE);
      assertIdle();
    });
    this.dynamic.reset();
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

  /** The ownership fence an input write runs under: this process still holds
   *  the actor, and the lease's turn is still in its preparing phase. The
   *  refusal text names which write was refused. */
  private preparingTurnFence(lease: ActorTurnLease, refusal: string): () => void {
    return () => {
      this.runtime.actor.assertCurrent();

      if (this.requireTurn(lease).phase !== 'preparing') throw new KinuError('denied', refusal);
    };
  }

  /** Open a durable assignment against this actor's working revision. The
   * lease's turn id is the delivery identity, not the actor's name: a re-drive
   * keeps the admitted task once, even when two assignments have equal text.
   * Birth context is used only before the conversation's first turn. */
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

  /**
   * Place an admitted turn's input on the working history — the ONE rule for
   * where a turn's conversation comes from, on every backend.
   *
   * A turn queued to answer a delivery (`metadata.drainTurnId`) is a delegated
   * turn: it opens on the actor's settled working revision, and an actor with
   * no conversation of its own yet — a child hired for context, whose first
   * turn is the delivery — is born from the conversation the delivery names,
   * read lazily since most actors never need it. Every other turn appends its
   * input. Either way a re-opened turn's prior output follows the input, so
   * the model continues its own answer rather than starting one.
   */
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



  /**
   * Admit one turn on this live instance, under the ids the host issued for it.
   *
   * The run id rides the lease because the durable claim binds it: a turn's
   * effects are attributed to the activation's run, and a recovered activation
   * that re-admits the same turn writes its own run id under a new epoch.
   */
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

  /** The user's message, through the inbox: it rides the running turn's next
   *  step, or, when nothing is running, becomes the next user turn. */
  send(steer: UserSteer & { readonly id: string; readonly mode?: WorkMode }): Promise<SendOutcome> {
    return this.orchestrator.inbox.send({
      kind: USER_MESSAGE_SIGNAL_KIND,
      text: steer.text,
      user: {
        id: steer.id,
        // The composer's mode when the message names one; the running turn's
        // otherwise — a leftover reruns under the mode its words were typed in.
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

  /** Abort the turn in flight and nothing else: what the model has not read
   *  stays queued, for the settle to rerun as the operator's next turn. */
  stop(): void {
    if (this.active?.phase !== 'settling') this.active?.abort.abort();
  }

  /**
   * Release the lease.
   *
   * A claim the host never named an outcome for is settled `indeterminate` —
   * the same word the tool-effect claim uses — because that is what is known:
   * the turn was admitted, the lease is being released, and nothing states how
   * it ended. Naming it `completed` here would be the host's silence read as
   * success.
   */
  finishTurn(lease: ActorTurnLease): void {
    const active = this.requireTurn(lease);

    if (active.phase === 'running') throw new KinuError('denied', 'cannot release an actor while its program is running');

    if (active.claim !== null && !active.claimSettled) this.settleClaim(active, 'indeterminate');
    this.active = null;
  }

  /** Name the outcome of the admitted turn's durable claim. Called by the host
   *  once the turn's answer is durable — the claim outlives this instance, so
   *  what closes it is a fact about the turn, not about the activation. */
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

  /**
   * Run the admitted turn: PREPARE the program, CLAIM it durably, then consume
   * the events — in that order, and the order is the contract.
   *
   * Preparation pins the selected version's immutable bytes and their digest.
   * The claim writes that identity, the issued actor/run/turn/epoch, the turn's
   * work mode and the context the turn was admitted against — all of it durable
   * BEFORE the event stream is started, which is before any model, tool or
   * provider work exists. `startActorTurn` builds the stream but runs nothing:
   * an async generator's body begins at its first `next()`, which is the loop
   * below. So a crash between the claim and the first token leaves a claim, and
   * a crash before the claim leaves a turn that provably did nothing.
   */
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
      durableOutput = new SessionStream(this.canonical, lease.turnId, claim.epoch);
      const stream = durableOutput;

      const events = operationProfileStream(startActorTurn({
        runtime: this.runtime, mode: this.mode, task: input.task, loopVersion: input.loopVersion,
        program, scaffoldSpend: input.scaffoldSpend,
        assertActive: input.assertActive,
        scaffoldStreamOptions: input.scaffoldStreamOptions,
        chat: { ...input.chat, tools, history: this.messages, signal: active.abort.signal, extensions,
          meter: this.orchestrator.acc.composition,
          persistStreamPart: part => stream.nativePart(part),
          persistStep: messages => stream.nativeStep(messages),
          dynamicContext: { ledger: this.dynamic, snapshot: () => input.dynamic(profile, tools) },
          stepContext: {
            base: async () => {
              const base = await this.canonical.stepBase(() => this.canonical.assertEpoch(claim.turnId, claim.epoch), claim.turnId, this.options.events ?? null);
              this.messages.splice(0, this.messages.length, ...base.messages);

              return base;
            },
            consume: async ({ stepNumber, messages }) => {
              const consumed = await this.options.claims.consume(claim, { index: stepNumber, messages });
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

          // Reasoning is written to the durable output by `observe` above and
          // is never the turn's answer, so the accounting here ignores it.
          case 'reasoning-delta': break;

          case 'step-finish':
            steps += 1;
            this.orchestrator.acc.recordStep({
              text: event.text, finishReason: event.finishReason, toolCalls: event.toolCalls, toolResults: event.toolResults,
              response: { messages: event.responseMessages }, usage: event.usage, request: event.request,
            });
            break;
          case 'error': {
            this.orchestrator.acc.hadError = true;

            // AN `error` EVENT IS A FAILURE, not a note beside a successful turn.
            // A thrown cause reaches the catch below and becomes `failure`, but
            // the scaffold loop reports a dead provider by PUSHING this event
            // instead of throwing (`scaffold/executor.ts`), so a turn whose
            // model never answered arrived here with `failure` still null: the
            // result read as completed, `runHeadInference` saw no break, and
            // `settleTurnClaim(lease, 'completed')` wrote COMPLETED into the
            // admission ledger for a turn that produced nothing. A claim that
            // lies about how a turn ended is worse than no claim, because
            // recovery verifies claims and would resume nothing.
            //
            // FIRST failure wins, and an abort is not one: an interrupted turn
            // has its own outcome and its own message, and the arms below
            // already distinguish them.
            if (failure === null
              && !active.abort.signal.aborted
              && event.message !== INTERRUPTED_TURN) {
              failure = new Error(event.message);
            }

            break;
          }

          case 'done':
            this.messages.push(...this.orchestrator.inbox.replayInto(event.responseMessages));

            // THE TURN'S ANSWER, over what it streamed. `text` above is every
            // delta this session saw — one step's narration after another on a
            // multi-step turn — while the runner's `done` carries the answer
            // the turn stopped on and already falls back to the steps and to a
            // tool synthesis when the model ended without prose. Preferring
            // the deltas made the durable reply the narration and the answer
            // concatenated: measured 2026-09-16 on build cba44dcb9, the
            // `public-failure-recovery` episode's answers to "reply with only
            // PASS or FAIL" were stored as three narration lines with FAIL run
            // onto the end of the last. The deltas stay the fallback for a
            // turn that produced no `done` at all — an interrupt throws past
            // this arm, and the cut text is what the operator saw.
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
    const finalTextReference = await this.matchTranscriptText(text, outputReferences);
    const admitted = active.claim === null ? null : (await this.options.claims.consumedContext(lease.turnId, 0)) ?? (await this.options.claims.admittedFor(active.claim));

    return {
      text, answer, steps, failure, program, claim: active.claim,
      interrupted: active.abort.signal.aborted || failure?.message === INTERRUPTED_TURN,
      admittedMessages: admitted?.messages ?? [],
      outputReferences, finalTextReference,
      outputPartReferences: output.parts,
    };
  }

  private async matchTranscriptText(text: string, output: readonly MessageReference[]): Promise<MessagePartReference | null> {
    if (text === '') return null;

    for (let index = output.length - 1; index >= 0; index--) {
      const reference = output[index];

      if (reference === undefined) continue;
      const parts = await this.canonical.messages.materializeParts(reference);
      let last: (typeof parts)[number] | undefined;

      for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
        const part = parts[partIndex];

        if (part?.value.type === 'text') { last = part; break; }
      }

      if (last === undefined) continue;

      if (last.value.text === text) return { messageId: reference.messageId, partNo: last.partNo };
      break;
    }

    return null;
  }

  async recordTranscriptText(claim: ActorTurnClaim, purpose: 'answer' | 'report', text: string, output: readonly MessageReference[]): Promise<MessagePartReference | null> {
    if (text === '') return null;
    const existing = await this.matchTranscriptText(text, output);
    this.canonical.assertClaimEpoch(claim.turnId, claim.epoch);

    if (existing !== null) return existing;
    const id = `${claim.turnId}:${claim.epoch}:display-${purpose}`;
    const prepared = await this.canonical.messages.prepare({ role: 'assistant', content: text }, id);

    return this.runtime.storage.transactionSync(() => {
      this.canonical.assertClaimEpoch(claim.turnId, claim.epoch);
      this.canonical.messages.insert(prepared, 'render');

      return { messageId: id, partNo: 0 };
    });
  }

  /** Pair a tool's outcome with the most recent issued call that owns it and
   *  record the whole exchange — success or refusal — on the turn's spend.
   *  The most-recent match is last-in-first-out: a tool-call event for the same
   *  id issued after this one already matched and was removed. */
  private recordToolResult(
    pending: Array<Extract<ChatEvent, { type: 'tool-call' }>>,
    event: Extract<ChatEvent, { type: 'tool-result' }>,
  ): void {
    let index = pending.length - 1;

    while (index >= 0 && pending[index]?.toolCallId !== event.toolCallId) index--;
    const call = index < 0 ? undefined : pending.splice(index, 1)[0];
    // The VALUE the tool returned is what the ledger records; the rendered
    // text is for readers that render. A tool that returned nothing records
    // the text it rendered to, which is what such a tool's row has always read.
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
