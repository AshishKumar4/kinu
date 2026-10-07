import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import type { ModelMessage, ToolSet } from 'ai';
import * as v from 'valibot';
import { INTERRUPTED_TURN, measureTurnRequest, type ChatEvent, type ChatOptions, type StepRecord } from '../chat';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ResolvedTurnProfile, ProfileAuthorityInputs } from '../profiles';
import type { WorkMode } from '../types/turn';
import { DynamicContextLedger, type DynamicContext } from '../prompting/volatile-context';
import { agentsProfileContext, delegationChoices } from '../delegation/agents-tool';
import { promptCacheWarm, PromptCacheRouteSchema, type CachedRequest } from '../prompting/cache-breakpoints';
import type { KinuExtension } from '../extension';
import { ExtensionHost } from '../extension';
import { Effect } from 'effect';
import { attempt, diagnostics, KinuError, renderThrownChain, settle, type TurnTrace, type TurnTracing } from '../obs/index';
import { AgentOrchestrator, type AgentOrchestratorDeps } from './agent-orchestrator';
import { describeLandedSteers, type AcceptedSteer, type LandedSteerRow, type UserSteer } from './inbox';
import { startActorTurn } from './actor-turn';
import type { ChatTurnInput } from './chat-session';
import { captureOperationProfile, currentOperationProfile, operationProfileStream } from '../profiles/operation';
import { prepareActorProgram, type ActorTurnProgram } from './actor-program';
import {
  programIdentityOf, type ActorClaimStore, type ActorTurnClaim, type ClaimOutcome,
} from './actor-claims';
import type { RunEventRecorder } from '../events/recorder';
import type { ContextEventRecorder } from '../types/context-plane';
import type { ContextEntry, ContextSelection } from '../session/context';
import type { JsonObject } from '../utils/json';
import type { Usage } from '../usage';
import type { ScaffoldBridgeOpts } from './scaffold-host';
import type { ModelCallSpend } from '../events/model-call';
import type { AgentSignal, SendOutcome } from '../types/signals';
import { USER_MESSAGE_SIGNAL_KIND } from '../types/signals';

import type { AgentConfigStore } from '../config/store';
import type { CompletedTurn } from '../evolution/types';
import {
  ADVISOR_ROLE_ID, advisedTurnOf, advisorLane, buildAdvisorPrompt, judgeAdvisorReply, sayAdvisorNote,
  type AdvisorNote, type AdvisorRecoverySnapshot,
} from '../advisor/review';
import type { TemporaryAgentPort } from '../types/subordinates';
import type { AnsweredEvolutionHelper } from '../identity/evolution-helpers';
import { advisorWorkspaceGuidance } from '../prompting/agents-md';
import { resolveModelRoute } from '../profiles/model-route';
import { modelWindow } from '../context-window';
import { SessionHistory, type MaterializedHistory } from '../session/history';
import { SessionStream } from './session-stream';
import { steerUserMessage } from './inbox';
import { recordTurnResumed, sameBuildOf } from './turn-recovery-events';
import { decideInterruptedTurn, type InterruptedTurnVerdict } from './turn-recovery';
import { lostToolCall } from '../tools/effect-claim';
import type { MessageReference, MessagePartReference, PreparedMessage } from '../session/messages';

/** What the owner reads when a run a dead process left is not run on, by why recovery closed it. */
const RESTORE_REFUSALS: Readonly<Record<Extract<InterruptedTurnVerdict, { kind: 'closed' }>['cause'], string>> = {
  settled: 'This turn ended before the last process did, so it is not run again.',
  stopped: 'This turn was stopped before the last process ended, so it is not run again.',
  record_unreadable: 'The record of what this turn had done could not be read after the last process ended, so it is not run again.',
  stalled: 'This turn made no progress across two runs, so it is not run a third time.',
  unverified: 'The program this turn ran has changed since the last process ended, so it is not run again under another.',
};

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
  readonly workspace?: string;
  /** Optional: the revision rows are the durable record; no recorder means no event, never a fabricated one. */
  readonly events?: ContextEventRecorder | null;
  readonly recording?: RunEventRecorder;
  readonly advisor?: ActorAdvisorContext;
  /** The port this actor hires its advisor through; null or absent, its turns are not reviewed. */
  readonly advisorPort?: () => TemporaryAgentPort | null;
  /** The profile's `input`: an actor that takes no input (a swarm node, an evolution agent) is not reviewed. */
  readonly reviewed?: boolean;
  /** The completion gate has asked and not heard back, when the host keeps one. */
  readonly gateOpen?: () => boolean;
  readonly turns?: () => TurnTracing;
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
  /** The turn's unapproved workspace files as one message, null for none. */
  readonly instructions?: string | null;
  /** What the turn's input activates (`activatedSkillsBlock`), spliced before it for this turn only. */
  readonly activated?: string | null;
  readonly scaffoldSpend?: ModelCallSpend;
  /** Re-checked before each model call, for kinds whose liveness is owned elsewhere (heads, swarm nodes). */
  readonly assertActive?: () => void;
  readonly scaffoldStreamOptions?: ScaffoldBridgeOpts['streamOptions'];
  readonly cacheKeptAliveUntil?: number | null;
  /** Steps a resumed turn keeps from its dead activation's run, and what they reported using. */
  readonly resumedSteps?: number;
  readonly resumedUsage?: Usage;
  readonly resumedMidStep?: boolean;
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
  context: MaterializedHistory | null;
  profile: ResolvedTurnProfile | null;
  profileInputs: ProfileAuthorityInputs | null;
  /** Never cleared: a settled turn's claim still attributes its late work. */
  claim: ActorTurnClaim | null;
  claimSettled: boolean;
  trace: TurnTrace | null;
  startedAt: number;
  ended: { readonly steps: number; readonly interrupted: boolean; readonly failure: Error | null } | null;
}

interface TurnTally {
  text: string;
  answer: string | null;
  steps: number;
  completed: boolean;
  failure: Error | null;
  admittedMessages: readonly ModelMessage[];
  readonly pending: Array<Extract<ChatEvent, { type: 'tool-call' }>>;
}

function newTurnTally(resumedSteps: number): TurnTally {
  return {
    text: '', answer: null, steps: resumedSteps, completed: false, failure: null, admittedMessages: [], pending: [],
  };
}

export const REVERT_NEEDS_IDLE = 'Stop the turn that is running before you revert the conversation.';

export const CLEAR_NEEDS_IDLE = 'Stop the turn that is running before you start a new conversation.';

export const COMPACT_NEEDS_IDLE = 'Stop the turn that is running before you compact the conversation.';

/** An actor's mutable execution state, apart from its host, which keeps admission, queueing and settlement and
 *  may share immutable catalogs, never this context, orchestrator or abort. */
function deliveryFailed(turnId: string): (failure: KinuError) => Effect.Effect<boolean> {
  return (failure) => Effect.sync(() => {
    diagnostics.failure('advisor.delivery_failed', failure, { turnId });

    return false;
  });
}

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

  get currentTurnId(): string | null {
    return this.active?.lease.turnId ?? null;
  }

  constructor(private readonly options: ActorSessionOptions) {
    this.actorId = options.runtime.actor.actorId;
    this.runtime = options.runtime;
    this.canonical = options.history;

    this.orchestrator = new AgentOrchestrator(options.orchestration, {
      onDrain: (steers, atStep) => this.landSteers(steers, atStep),
      turnId: () => this.active?.lease.turnId ?? null,
    });
  }

  /** Once, at session build; `landed` is recorded after `onDrain` returns, so a failed write leaves no unseen row. */
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
  /** Until `finishTurn`, a settling turn owns its claim. */
  get turnOpen(): boolean { return this.active !== null; }

  lastRequestAt(): number | null {
    return this.canonical.requests.lastStep()?.recordedAt ?? null;
  }

  /** Whether the next request finds the prompt cache cold: the one reading the turn's dynamic context and a live trial's segment both use. */
  promptCacheCold(keptAliveUntil: number | null): boolean {
    const last = this.canonical.requests.lastStep();

    return !promptCacheWarm(last === null ? null : cachedRequestOf(last), Date.now(), keptAliveUntil);
  }
  /** A host settles the claim under the outcome it named. */
  get turnClaim(): ActorTurnClaim | null { return this.active?.claim ?? null; }
  /** Read, and observed, by whoever asks where a turn stands. */
  get claims(): ActorClaimStore { return this.options.claims; }
  /** The revision the open turn's input was placed on. */
  get turnContext(): ContextSelection | null { return this.active?.context?.selection ?? null; }

  get advisorEnabled(): boolean {
    return (this.options.advisor?.config ?? this.runtime.actor.config).getAdvisorEnabled();
  }

  advisorSnapshot(turn: CompletedTurn, reachable: readonly string[]): AdvisorRecoverySnapshot {
    const profile = this.profile;

    return {
      turn: this.orchestrator.scopedTurn(turn),
      reachable: [...reachable],
      model: profile === null || !this.advisorEnabled ? undefined : resolveModelRoute('advisor', profile).model,
    };
  }

  /** Off by default: the owner's switch, a reviewed profile and a port to hire the advisor through all decide. */
  get reviewsTurns(): boolean {
    return this.options.reviewed !== false && this.advisorEnabled && (this.options.advisorPort?.() ?? null) !== null;
  }

  /**
   * Hires the turn's advisor, an evolution agent under the advisor preset, and returns: its answer reaches
   * {@link deliverAdvisorAnswers} through the ingress. Idempotent per turn, so a replay hires no second one.
   */
  async hireAdvisor(snapshot: AdvisorRecoverySnapshot): Promise<void> {
    const port = this.options.advisorPort?.() ?? null;
    const turnId = snapshot.turn.turnId;

    // No durable id, no lane to answer on.
    if (!this.reviewsTurns || port === null || turnId === undefined || turnId === '') return;

    if (this.options.orchestration.engine.hasAdvisorNoteForTurn(turnId) || port.reclaim(advisorLane(turnId)) !== null) return;

    const task = buildAdvisorPrompt(snapshot.turn, snapshot.reachable, await this.advisorGuidance());
    const hired = await port.start({ role: ADVISOR_ROLE_ID, roleLabel: ADVISOR_ROLE_ID, task, mode: 'build', lane: advisorLane(turnId) });

    if (!('status' in hired) || hired.status === 'failed') {
      diagnostics.event('advisor.hire_failed', { turnId, reason: 'reason' in hired ? hired.reason ?? 'unknown' : 'unknown' });
    }
  }

  /** Notes handed to the conversation and not yet said, by the helper that answered them. */
  private readonly delivering = new Map<string, Promise<void>>();

  /** Settles once every note handed to the conversation is said, or failed and kept for the next pass. */
  advisorDeliveries(): Promise<void> {
    return Promise.allSettled(this.delivering.values()).then(() => undefined);
  }

  /**
   * Every advisor answer this actor holds, judged once and said at most once; per-turn feedback never changes the
   * learning window. A note to be said is handed to the conversation and not awaited: the turn it opens runs as long
   * as it runs, and the answer is forgotten only once it is said. False while any answer is still held. `deliver`
   * says it where the actor's notes live, true once said: an agent in its own isolate says it there.
   */
  async deliverAdvisorAnswers(deliver?: (helper: AnsweredEvolutionHelper, turnId: string) => Promise<boolean>): Promise<boolean> {
    const port = this.options.advisorPort?.() ?? null;

    if (port === null) return true;
    let settled = true;

    for (const helper of port.answered()) {
      const turnId = advisedTurnOf(helper.lane);

      if (turnId === null) continue;

      if (deliver === undefined) {
        if (!await this.deliverAdvisorAnswer(port, helper, turnId)) settled = false;
      } else if (await deliver(helper, turnId)) {
        port.forget(helper.name);
      } else {
        settled = false;
      }
    }

    return settled;
  }

  /** True once the answer is forgotten. */
  deliverAdvisorAnswer(port: TemporaryAgentPort, helper: AnsweredEvolutionHelper, turnId: string): Promise<boolean> {
    if (this.delivering.has(helper.name)) return Promise.resolve(false);

    return settle(attempt({ doing: `judging the advisor's review of turn ${turnId}`, otherwise: 'unavailable' }, async () => {
      const judged = helper.status === 'completed' ? this.judgedAdvice(helper.answer, turnId) : null;

      if (judged === null || !judged.spoken) {
        port.forget(helper.name);

        return true;
      }

      this.delivering.set(helper.name, this.handOffAdvice(port, helper.name, judged.note, turnId)
        .finally(() => { this.delivering.delete(helper.name); }));

      return false;
    }).pipe(Effect.catch(deliveryFailed(turnId))));
  }

  /** The note judged for the turn, recorded by its first judgement; a pass after a cut delivery reads it back. */
  private judgedAdvice(answer: string, turnId: string): { readonly note: AdvisorNote; readonly spoken: boolean } | null {
    const { engine } = this.options.orchestration;
    const recorded = engine.advisorNoteForTurn(turnId);

    if (recorded !== null) return recorded;

    const judged = judgeAdvisorReply(answer, {
      turnId,
      minSeverity: (this.options.advisor?.config ?? this.runtime.actor.config).getAdvisorMinSeverity(),
      recent: [...engine.recentAdvisorNotes()],
      gateOpen: this.options.gateOpen?.() ?? false,
      record: (note, id, spoken) => { engine.recordAdvisorNote(note, id, spoken); },
    });

    return judged === null || judged.disposition === 'drop' ? null : { note: judged.note, spoken: judged.disposition === 'deliver' };
  }

  /** Settles once the note is said and its answer forgotten, or failed and kept for the next pass. */
  handOffAdvice(port: TemporaryAgentPort, name: string, note: AdvisorNote, turnId: string): Promise<void> {
    return this.sayAdvice(note, turnId).then((said) => { if (said) port.forget(name); });
  }

  /** The answer judged and, if it speaks, said here; true once nothing of it is owed. */
  async sayAdvisorAnswer(helper: AnsweredEvolutionHelper, turnId: string): Promise<boolean> {
    const judged = helper.status === 'completed' ? this.judgedAdvice(helper.answer, turnId) : null;

    return judged === null || !judged.spoken || await this.sayAdvice(judged.note, turnId);
  }

  sayAdvice(note: AdvisorNote, turnId: string): Promise<boolean> {
    return settle(attempt({ doing: `saying the advisor's note on turn ${turnId}`, otherwise: 'unavailable' }, async () => {
      const sent = await sayAdvisorNote(note, {
        turnId,
        send: (signal) => this.orchestrator.inbox.send(signal),
        ...(this.options.advisor !== undefined && { actor: this.runtime.actor, parent: this.options.advisor.parent }),
      });

      // A signal the host could not take stays owed for the next pass.
      return sent === 'queued' || sent === 'mid-turn';
    }).pipe(Effect.catch(deliveryFailed(turnId))));
  }

  private async advisorGuidance(): Promise<string> {
    const workspace = await this.options.advisor?.workspace() ?? this.runtime.agentStateVfs ?? this.runtime.storage.vfs;

    return await advisorWorkspaceGuidance({ vfs: workspace, limits: async () => modelWindow(null) });
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
  async revertConversation(sessionId: string, entryId: string, assertIdle: () => Effect.Effect<void, KinuError>): Promise<void> {
    this.canonical.revertTo(sessionId, entryId, () => this.inFlight ? Effect.fail(new KinuError('denied', REVERT_NEEDS_IDLE)) : assertIdle());
    this.dynamic.unload();
    await this.restoreWorkingHistory();
  }

  async clearConversation(sessionId: string, assertIdle: () => Effect.Effect<void, KinuError>): Promise<void> {
    this.canonical.clearConversation(sessionId, () => this.inFlight ? Effect.fail(new KinuError('denied', CLEAR_NEEDS_IDLE)) : assertIdle());
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

    const selected = this.canonical.context.selected() ?? this.canonical.context.initialize();

    if (selected.revision === 0 && this.canonical.context.conversationOf(this.canonical.context.entries(selected)).length === 0 && this.canonical.proposals.pending(selected.contextId).length === 0) {
      const birth = await input.birthContext();

      if (birth.length > 0) await this.canonical.replaceHistory(birth, { author: this.actorId, via: 'runtime', turnId: null, stage: false, assertOwner });
    }

    for (const [index, message] of input.messages.entries()) {
      const reference = await this.canonical.admitInput({ id: index === 0 ? lease.turnId : `${lease.turnId}:input:${index}`, message, turnId: lease.turnId, assertOwner });
      this.canonical.activateInput(reference, lease.turnId, assertOwner);
    }

    const opened = await this.canonical.materialize();
    this.requireTurn(lease).context = opened;
    this.messages.splice(0, this.messages.length, ...opened.messages);
  }

  /** A delivery turn (`metadata.drainTurnId`) opens on the settled working revision; others append. */
  async openTurnInput(lease: ActorTurnLease, input: {
    readonly item: Pick<ChatTurnInput, 'metadata'>;
    readonly message: ModelMessage;
    readonly birthContext: (drainTurnId: string) => Promise<readonly ModelMessage[]>;
  }): Promise<void> {
    await this.restoration;

    const assertOwner = this.preparingTurnFence(lease, 'input must belong to a preparing turn');

    const selected = this.canonical.context.selected() ?? this.canonical.context.initialize();
    const drainTurn = v.safeParse(v.string(), input.item.metadata?.drainTurnId);

    if (selected.revision === 0 && drainTurn.success && this.canonical.context.conversationOf(this.canonical.context.entries(selected)).length === 0 && this.canonical.proposals.pending(selected.contextId).length === 0) {
      for (const [index, message] of (await input.birthContext(drainTurn.output)).entries()) await this.canonical.append({ id: `${lease.turnId}:birth:${index}`, message, origin: 'input', turnId: lease.turnId, assertOwner });
    }

    const acceptedInput = await this.canonical.admitInput({ id: lease.turnId, message: input.message, turnId: lease.turnId, assertOwner });
    this.canonical.activateInput(acceptedInput, lease.turnId, assertOwner);

    const opened = await this.canonical.materialize();
    this.requireTurn(lease).context = opened;
    this.messages.splice(0, this.messages.length, ...opened.messages);
  }



  async retractCutStep(lease: ActorTurnLease, outputs: readonly string[]): Promise<void> {
    await this.canonical.retract(outputs, this.preparingTurnFence(lease, 'a cut step is retracted by the turn preparing it'));
    const opened = await this.canonical.materialize();
    this.requireTurn(lease).context = opened;
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
      lease, abort, phase: 'preparing', context: null, profile: null, profileInputs: null,
      claim: null, claimSettled: false, trace: null, startedAt: 0, ended: null,
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

  /**
   * Unread input stays queued for the settle to rerun. The stop is a row of the run before the abort lands: a process
   * that dies before the turn settles leaves it, and the next start ends the turn as this one would have.
   */
  stop(): void {
    const active = this.active;

    if (active === null || active.phase === 'settling') return;
    this.options.recording?.emit(active.lease.runId, { type: 'stop_requested' });
    active.abort.abort();
  }

  /**
   * A run a dead process left open goes on only if recovery says it may: the recovery sweep's own decision. Any other
   * ends as a stop ends it, before anything runs.
   */
  resumeOrClose(lease: ActorTurnLease): Promise<void> {
    const active = this.requireTurn(lease);

    return settle(Effect.map(decideInterruptedTurn({
      runtime: this.runtime, stores: { claims: this.options.claims, history: this.options.history }, runs: this.options.recording ?? null,
      installedBuild: this.options.installedBuild, workspace: this.options.workspace ?? '', actor: this.runtime.identity.name,
      runId: lease.runId, claim: this.options.claims.read(lease.turnId),
      // This session holds the turn: it is the one deciding.
      turnOpen: () => false,
    }), (verdict) => {
      if (verdict.kind === 'closed') active.abort.abort(new KinuError('cancelled', RESTORE_REFUSALS[verdict.cause]));
    }));
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
    const ended = active.ended;

    active.trace?.settle(active.startedAt, (span) => {
      span.setAttribute('kinu.turn.outcome', outcome);

      if (ended === null) return;
      span.setAttribute('kinu.turn.steps', ended.steps);
      span.setAttribute('kinu.turn.interrupted', ended.interrupted);

      if (ended.failure !== null && !ended.interrupted) span.fail(ended.failure);
    });
    active.trace = null;
  }

  /** Prepare, claim durably, then consume: `startActorTurn` runs nothing until the first `next()`, so a crash
   *  before the claim leaves a turn that provably did nothing. */
  async execute(lease: ActorTurnLease, input: ActorExecutionInput, emit: (event: ChatEvent) => void | Promise<void>): Promise<ActorExecutionResult> {
    const active = this.requireTurn(lease);
    active.startedAt = Date.now();
    const release = this.orchestrator.acc.chargeTo(input.chat.budget);
    let result: ActorExecutionResult;

    try {
      result = await this.run(lease, input, emit);
    } finally {
      release();
    }

    active.ended = { steps: result.steps, interrupted: result.interrupted, failure: result.failure };

    return result;
  }

  private liveStream: SessionStream | null = null;

  durableCall(callId: string, signal?: AbortSignal): Promise<void> {
    return this.liveStream?.durable(callId, signal) ?? Promise.resolve();
  }

  private async run(
    lease: ActorTurnLease,
    input: ActorExecutionInput,
    emit: (event: ChatEvent) => void | Promise<void>,
  ): Promise<ActorExecutionResult> {
    const active = this.requireTurn(lease);

    if (active.phase !== 'preparing' || active.profile === null) throw new KinuError('denied', 'a profiled actor turn executes once');
    const profile = active.profile;
    const tally = newTurnTally(input.resumedSteps ?? 0);

    // The steps the dead activation finished count once, as their rows did.
    if (input.resumedSteps !== undefined) this.orchestrator.acc.resume(input.resumedSteps, input.resumedUsage ?? {});
    let program: ActorTurnProgram | null = null;
    let durableOutput: SessionStream | null = null;

    try {
      active.phase = 'running';
      active.abort.signal.throwIfAborted();
      const prepared = await this.prepareProgram(input.loopVersion, active);
      program = prepared.program;
      const claim = await this.admitClaim(lease, program, prepared.selection, input);
      active.claim = claim;

      active.trace = this.options.turns?.().admitted({ turnId: claim.turnId, epoch: claim.epoch }, active.startedAt, (span) => {
        span.setAttribute('kinu.turn.mode', this.mode);
      }) ?? null;
      tally.admittedMessages = prepared.messages;

      if (profile.tier.replaced !== null) {
        await emit({ type: 'model-fallback', from: profile.tier.replaced, to: profile.tier.model, reason: 'its provider no longer lists it' });
      }

      durableOutput = new SessionStream(this.canonical, lease.turnId, claim.epoch);
      const stream = durableOutput;
      this.liveStream = stream;
      const events = this.turnEvents({ lease, active, profile, input, program, claim, stream, tally });

      for await (const event of events) {
        await stream.observe(event);
        this.tallyEvent(tally, event, active.abort.signal, event.source === 'native');
        await emit(event);
      }
    } catch (cause) {
      if (!tally.completed) this.messages.push(...this.orchestrator.inbox.recordedMessages());
      tally.failure = cause instanceof Error ? cause : new Error(renderThrownChain({ cause }), { cause });

      if (tally.failure.message !== INTERRUPTED_TURN && !active.abort.signal.aborted) this.orchestrator.acc.hadError = true;
      await emit({ type: 'error', message: renderThrownChain({ cause }) });
    } finally {
      active.phase = 'settling';
      this.liveStream = null;
      await this.settleOutput(active, durableOutput);
    }

    return this.turnResult(lease, active, tally, program);
  }

  private async prepareProgram(version: number, active: ActiveTurn): Promise<{
    readonly program: ActorTurnProgram;
    readonly selection: ContextSelection;
    readonly messages: readonly ModelMessage[];
  }> {
    const program = await prepareActorProgram({ signal: active.abort.signal, runtime: this.runtime, mode: this.mode, version });
    const admitted = active.context ?? await this.canonical.materialize();
    active.context = admitted;
    this.messages.splice(0, this.messages.length, ...admitted.messages);

    return { program, selection: admitted.selection, messages: admitted.messages };
  }

  /** An unsettled claim: a dead activation left this turn open. */
  private async admitClaim(
    lease: ActorTurnLease, program: ActorTurnProgram, context: ContextSelection, input: ActorExecutionInput,
  ): Promise<ActorTurnClaim> {
    const previous = this.options.claims.read(lease.turnId);

    const claim = await this.options.claims.admit({
      runId: lease.runId,
      turnId: lease.turnId,
      workMode: this.mode,
      program: programIdentityOf(program, this.options.installedBuild),
      context,
      installedBuild: this.options.installedBuild,
    });

    if (previous?.status === 'admitted') {
      recordTurnResumed({
        workspace: this.options.workspace ?? '',
        actor: this.runtime.identity.name,
        stepsKept: input.resumedSteps ?? 0,
        midStep: input.resumedMidStep ?? false,
        sameBuild: sameBuildOf(previous.program.build, this.options.installedBuild),
      });
    }

    return claim;
  }

  private turnToolset(input: Omit<ActorExecutionInput, 'task'>, profile: ResolvedTurnProfile) {
    const allowedTools = new Set(profile.allowedTools);
    const tools = Object.fromEntries(Object.entries(input.chat.tools ?? {}).filter(([name]) => allowedTools.has(name)));
    const extensions = new ExtensionHost();

    for (const extension of input.extensions) extensions.register(extension);
    extensions.register(this.orchestrator.turnExtension);

    return { tools, extensions };
  }

  /** Null mid-turn: that turn measures its own. */
  async measureNextRequest(
    input: Omit<ActorExecutionInput, 'task'>, profile: ResolvedTurnProfile,
  ): Promise<{ readonly tokens: number; readonly contextWindow: number | null } | null> {
    if (this.inFlight) return null;
    const { tools, extensions } = this.turnToolset(input, profile);
    const { messages } = await this.canonical.materialize();

    return measureTurnRequest({
      ...input.chat, tools, history: messages, extensions,
      dynamicContext: { ledger: this.dynamic, snapshot: () => this.stepContext(input.dynamic, profile, tools), instructions: input.instructions },
    });
  }

  /** A step's live state: the backend's, plus what core owns, the roles and tiers the `agents` tool takes, kept out
   *  of its bytes so accounts share one definition. */
  stepContext(dynamic: ActorExecutionInput['dynamic'], profile: ResolvedTurnProfile, tools: ToolSet): DynamicContext {
    const context = dynamic(profile, tools);
    const delegation = tools.agents === undefined ? null : delegationChoices(agentsProfileContext(profile, this.profileInputs));

    return delegation === null ? context : { ...context, delegation };
  }

  private turnEvents(turn: {
    readonly lease: ActorTurnLease;
    readonly active: ActiveTurn;
    readonly profile: ResolvedTurnProfile;
    readonly input: ActorExecutionInput;
    readonly program: ActorTurnProgram;
    readonly claim: ActorTurnClaim;
    readonly stream: SessionStream;
    readonly tally: TurnTally;
  }): AsyncIterable<ChatEvent> {
    const { lease, active, profile, input, program, claim, stream, tally } = turn;
    const { tools, extensions } = this.turnToolset(input, profile);
    // Activation names the input's entry after its message; an edit keeps the entry.
    const turnInput = this.canonical.admittedInput(claim.turnId);
    const assertClaim = () => this.canonical.assertEpoch(claim.turnId, claim.epoch);
    let stepEntries: readonly ContextEntry[] = [];
    let turnOpened = false;

    return operationProfileStream(startActorTurn({
      runtime: this.runtime, mode: this.mode, task: input.task, loopVersion: input.loopVersion,
      program, scaffoldSpend: input.scaffoldSpend,
      assertActive: input.assertActive,
      scaffoldStreamOptions: input.scaffoldStreamOptions,
      chat: { ...input.chat, tools, history: this.messages, signal: active.abort.signal, extensions,
        lostToolCall: (call) => lostToolCall(this.runtime.storage.sql, this.runtime.actor, lease.turnId, call),
        measureContext: true, ...(active.trace !== null && { trace: active.trace }),
        persistStreamPart: part => stream.nativePart(part),
        persistStep: (record) => stream.nativeStep(record, () => this.recordStep(record)),
        dynamicContext: {
          ledger: this.dynamic,
          snapshot: () => {
            const context = this.stepContext(input.dynamic, profile, tools);

            // The turn scores only the lessons it was shown.
            this.orchestrator.acc.noteLessonsShown(context.toolLessons ?? []);

            return context;
          },
          instructions: input.instructions,
          activated: input.activated,
        },
        stepContext: {
          base: async () => {
            const base = await this.canonical.stepBase(assertClaim, claim.turnId, this.options.events ?? null, active.context);
            active.context = base;
            this.messages.splice(0, this.messages.length, ...base.messages);
            stepEntries = base.entries;

            // A cold cache makes rewriting free: the stored blocks collapse into one.
            if (!turnOpened) {
              turnOpened = true;

              if (this.promptCacheCold(input.cacheKeptAliveUntil ?? null)) this.dynamic.reset();
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

            if (stepNumber === 0) tally.admittedMessages = [...messages];
            stream.beginRequest(consumed.requestId, stepNumber);
          },
        } } satisfies ChatOptions,
    }), captureOperationProfile({
      actor: this.runtime.actor, profile,
      inputs: active.profileInputs, runId: lease.runId, turnId: lease.turnId,
    }));
  }

  private tallyEvent(tally: TurnTally, event: ChatEvent, abort: AbortSignal, native: boolean): void {
    switch (event.type) {
      case 'text-delta': this.orchestrator.acc.onFirstChunk(); tally.text += event.delta; break;
      case 'tool-call':
        if (!native) tally.pending.push(event);
        break;
      case 'tool-result': {
        if (native) break;
        const args = this.callArgs(tally.pending, event.toolCallId);
        this.orchestrator.acc.recordResult(args, event);
        break;
      }

      // Reasoning is never the turn's answer.
      case 'reasoning-delta':
      case 'model-fallback':
      case 'context-admitted':
        break;

      case 'step-finish':
        tally.steps += 1;

        if (!native) this.orchestrator.acc.recordBoundary(event);
        break;
      case 'error': {
        this.orchestrator.acc.hadError = true;

        // The scaffold loop pushes an `error` event rather than throwing, so an empty turn never settles `completed`.
        // First failure wins; an abort is not one.
        if (tally.failure === null && !abort.aborted && event.message !== INTERRUPTED_TURN) {
          tally.failure = new Error(event.message);
        }

        break;
      }

      case 'done':
        this.messages.push(...this.orchestrator.inbox.replayInto(event.responseMessages));

        // The runner's `done` answer wins; the concatenated deltas are the fallback.
        if (event.text.trim()) tally.text = event.text;

        if (event.answer !== undefined && event.answer.trim()) tally.answer = event.answer;
        tally.completed = true;
        break;
    }
  }

  private async settleOutput(active: ActiveTurn, stream: SessionStream | null): Promise<void> {
    if (active.claim === null) return;
    await stream?.settle();
    const settled = await this.canonical.materialize(active.context);
    active.context = settled;
    this.messages.splice(0, this.messages.length, ...settled.messages);
  }

  private async turnResult(
    lease: ActorTurnLease,
    active: ActiveTurn,
    tally: TurnTally,
    program: ActorTurnProgram | null,
  ): Promise<ActorExecutionResult> {
    const output = await this.canonical.outputForTurn(lease.turnId);
    const said = await this.saidText(output.messages, tally.text, tally.answer);

    return {
      text: said.text, answer: tally.answer, steps: tally.steps, failure: tally.failure, program, claim: active.claim,
      interrupted: active.abort.signal.aborted || tally.failure?.message === INTERRUPTED_TURN,
      admittedMessages: tally.admittedMessages,
      outputReferences: output.messages, finalTextReference: said.reference,
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
  private callArgs(pending: Array<Extract<ChatEvent, { type: 'tool-call' }>>, toolCallId: string): JsonObject {
    let index = pending.length - 1;

    while (index >= 0 && pending[index]?.toolCallId !== toolCallId) index--;

    return (index < 0 ? undefined : pending.splice(index, 1)[0])?.args ?? {};
  }

  private recordStep(record: StepRecord): () => void {
    const write = () => this.orchestrator.acc.writeNative(record);
    const collected = this.options.recording?.collect(write);

    if (collected === undefined) return write();

    return () => { collected.value(); collected.publish(); };
  }

  private requireTurn(lease: ActorTurnLease): ActiveTurn {
    if (this.active?.lease !== lease) throw new KinuError('denied', 'the actor turn lease is no longer active');

    return this.active;
  }
}
