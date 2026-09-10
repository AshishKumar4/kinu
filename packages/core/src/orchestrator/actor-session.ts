import type { ModelMessage } from 'ai';
import { INTERRUPTED_TURN, type ChatEvent, type ChatOptions } from '../chat';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ResolvedTurnProfile, ProfileAuthorityInputs } from '../profiles';
import type { WorkMode } from '../types/turn';
import { DynamicContextLedger, type DynamicContext } from '../prompting/volatile-context';
import type { KinuExtension } from '../extension';
import { ExtensionHost } from '../extension';
import { KinuError, renderThrownChain } from '../obs/index';
import { AgentOrchestrator, type AgentOrchestratorDeps } from './agent-orchestrator';
import { describeLandedSteers, UserSteerDrain, type LandedSteerRow, type UserSteer } from './user-steer';
import { startActorTurn } from './actor-turn';
import { prepareActorProgram, type ActorTurnProgram } from './actor-program';
import {
  programIdentityOf, type ActorClaimStore, type ActorTurnClaim, type ClaimOutcome,
} from './actor-claims';
import { createActorContextPlane, type ActorContextPlane, type ContextEventRecorder } from './context-plane';
import type { ScaffoldBridgeOpts } from './scaffold-host';
import type { ModelCallSpend } from '../events/model-call';

export interface ActorSessionOptions {
  readonly runtime: AgentRuntime;
  readonly orchestration: AgentOrchestratorDeps;
  /** The actor's durable claim ledger. REQUIRED: a turn that cannot write its
   *  claim cannot issue an effect, so there is no arm of this class that runs
   *  without one and no host that may decline to wire it. */
  readonly claims: ActorClaimStore;
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
  readonly dynamic: () => DynamicContext;
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
  readonly failure: Error | null;
  readonly interrupted: boolean;
  /** Null when preparation failed before any program was selected. */
  readonly program: ActorTurnProgram | null;
  /** The durable claim this execution ran under — written before the first
   *  effect, and the identity every revision of the turn is keyed to. Null
   *  only when preparation failed before the claim was admitted. */
  readonly claim: ActorTurnClaim | null;
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

/** A logical actor's mutable execution state, independent of its physical host.
 * The host retains admission, queueing and durable/effect settlement. It may
 * share immutable catalogs, never this actor's context, orchestrator or abort. */
export class ActorSession {
  readonly actorId: string;
  readonly runtime: AgentRuntime;
  readonly orchestrator: AgentOrchestrator;
  readonly dynamic = new DynamicContextLedger();
  private readonly messages: ModelMessage[] = [];
  private readonly landed: LandedSteerRow[] = [];
  private readonly userSteer: UserSteerDrain;
  private active: ActiveTurn | null = null;
  private mode: WorkMode = 'build';
  /** The actor's context plane: the working history its requests are built
   *  from, and where an edit of it lands. One per session, over the claim
   *  store's own ledgers. */
  private readonly context: ActorContextPlane;

  constructor(private readonly options: ActorSessionOptions) {
    this.actorId = options.runtime.actor.actorId;
    this.runtime = options.runtime;
    this.orchestrator = new AgentOrchestrator(options.orchestration);
    this.context = createActorContextPlane({ claims: options.claims, events: options.events ?? null });
    this.userSteer = new UserSteerDrain({
      turnInFlight: () => this.inFlight,
      onDrain: (steers, atStep) => {
        for (const row of describeLandedSteers(steers, atStep)) {
          this.landed.push(row);
          options.orchestration.host.broadcast({ type: 'steer_status', status: 'landed', steerId: row.id, text: row.text, atStep: row.atStep });
        }
      },
    });
  }

  get history(): readonly ModelMessage[] { return this.messages; }
  get workMode(): WorkMode { return this.mode; }
  get profile(): ResolvedTurnProfile | null { return this.active?.profile ?? null; }
  get profileInputs(): ProfileAuthorityInputs | null { return this.active?.profileInputs ?? null; }
  get landedSteers(): readonly LandedSteerRow[] { return this.landed; }
  get inFlight(): boolean { return this.active !== null && this.active.phase !== 'settling'; }
  /** The admitted turn's durable claim, or null before it is written. A host
   *  reads it to settle the claim under the outcome IT named. */
  get turnClaim(): ActorTurnClaim | null { return this.active?.claim ?? null; }

  /**
   * Replace this actor's working context.
   *
   * Two arms, because a hydration and an edit are different acts. With no
   * admitted turn this is cold-start hydration: the array becomes the actor's
   * history AND is recorded as a working revision, so the `/context` projection
   * of a just-restarted actor serves what it will really build its next request
   * from rather than an empty answer an edit could then overwrite the history
   * with.
   *
   * DURING an admitted turn it is an edit, and it cannot be applied in place:
   * work already issued keeps the context it was issued with. So it is staged
   * as a later working revision (compare-and-set against the head — see
   * `ActorWorkingContextStore.stage`), and that revision becomes the request at
   * the next SAFE step boundary with the turn's protected tail and any ingress
   * that landed since preserved (`prompting/staged-context.ts`).
   *
   * Returns the staged revision when it staged one, null when it hydrated.
   */
  restoreHistory(messages: readonly ModelMessage[]): number | null {
    if (this.active === null) {
      this.messages.splice(0, this.messages.length, ...messages);
      this.context.hydrate(this.messages);

      return null;
    }

    const state = this.context.read();

    return this.context.edit({
      base: state.head?.revision ?? 0,
      messages,
      author: this.actorId,
      via: 'session',
    }).revision;
  }

  appendInput(lease: ActorTurnLease, message: ModelMessage): void {
    if (this.requireTurn(lease).phase !== 'preparing') throw new KinuError('denied', 'actor input must belong to a preparing turn');
    this.messages.push(message);
  }

  /**
   * Admit one turn on this live instance, under the ids the host issued for it.
   *
   * The run id rides the lease because the durable claim binds it: a turn's
   * effects are attributed to the activation's run, and a recovered activation
   * that re-admits the same turn writes its own run id under a new epoch.
   */
  beginTurn<Metadata>(
    ids: { readonly runId: string; readonly turnId: string },
    mode: WorkMode,
    startedAt: number,
    metadata?: Metadata,
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
    this.userSteer.beginTurn();
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

  steer(steer: UserSteer & { readonly id: string }): boolean {
    if (this.userSteer.accept(steer) !== 'mid-turn') return false;
    this.options.orchestration.host.broadcast({ type: 'steer_status', status: 'queued', steerId: steer.id, text: steer.text });

    return true;
  }

  interrupt(): readonly UserSteer[] {
    const dropped = this.userSteer.interrupt();

    for (const steer of dropped) if (steer.id) {
      this.options.orchestration.host.broadcast({ type: 'steer_status', status: 'returned', steerId: steer.id, text: steer.text });
    }

    if (this.active?.phase !== 'settling') this.active?.abort.abort();

    return dropped;
  }

  takeLeftoverSteers(): readonly UserSteer[] { return this.userSteer.takeLeftover(); }

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
  async execute(lease: ActorTurnLease, input: ActorExecutionInput, emit: (event: ChatEvent) => void): Promise<ActorExecutionResult> {
    const active = this.requireTurn(lease);

    if (active.phase !== 'preparing' || active.profile === null) throw new KinuError('denied', 'a profiled actor turn executes once');
    const extensions = new ExtensionHost();

    for (const extension of input.extensions) extensions.register(extension);
    extensions.register({ name: 'kinu.steering', prepareStep: ctx => this.userSteer.prepareStep(ctx) });
    extensions.register(this.orchestrator.turnExtension);
    const pending: Array<Extract<ChatEvent, { type: 'tool-call' }>> = [];
    let text = '';
    let completed = false;
    let program: ActorTurnProgram | null = null;
    let failure: Error | null = null;

    try {
      active.phase = 'running';
      active.abort.signal.throwIfAborted();
      const control = { signal: active.abort.signal };
      program = await prepareActorProgram({
        ...control, runtime: this.runtime, mode: this.mode, version: input.loopVersion,
      });
      // The turn's history is what the CONTEXT PLANE resolves, not simply what
      // this instance accumulated: an edit authored between turns lands here,
      // at the turn boundary, with the input delivered since preserved after it
      // exactly once. The array it returns is the array the claim names, so a
      // recovery reads back what the first step actually started from.
      const admitted = this.context.startTurn({ turnId: lease.turnId, history: this.messages });
      this.messages.splice(0, this.messages.length, ...admitted.messages);

      const claim = this.options.claims.admit({
        runId: lease.runId,
        turnId: lease.turnId,
        workMode: this.mode,
        program: programIdentityOf(program, this.options.installedBuild),
        context: this.messages,
        workingRevision: admitted.workingRevision,
      });

      active.claim = claim;

      const events = startActorTurn({
        runtime: this.runtime, mode: this.mode, task: input.task, loopVersion: input.loopVersion,
        program, scaffoldSpend: input.scaffoldSpend,
        assertActive: input.assertActive,
        scaffoldStreamOptions: input.scaffoldStreamOptions,
        chat: { ...input.chat, history: this.messages, signal: active.abort.signal, extensions,
          meter: this.orchestrator.acc.composition, dynamicContext: { ledger: this.dynamic, snapshot: input.dynamic },
          stepContext: this.context.steps(claim) },
      });

      for await (const event of events) {
        this.requireTurn(lease);

        switch (event.type) {
          case 'text-delta': this.orchestrator.acc.onFirstChunk(); text += event.delta; break;
          case 'tool-call': pending.push(event); break;
          case 'tool-result': {
            let index = pending.length - 1;

            while (index >= 0 && pending[index]?.toolCallId !== event.toolCallId) index--;
            const call = index < 0 ? undefined : pending.splice(index, 1)[0];
            this.orchestrator.acc.recordToolCall(event.success
              ? { toolName: event.toolName, input: call?.args ?? {}, success: true, output: event.result }
              : { toolName: event.toolName, input: call?.args ?? {}, success: false, reason: event.reason,
                  execution: event.execution, error: event.error ?? event.result });
            break;
          }

          case 'step-finish': this.orchestrator.acc.recordStep({ response: { messages: event.responseMessages }, usage: event.usage }); break;
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
            this.messages.push(...this.userSteer.replayInto(event.responseMessages));

            if (!text.trim() && event.text.trim()) text = event.text;
            completed = true;
            break;
        }

        emit(event);
      }
    } catch (cause) {
      if (!completed) this.messages.push(...this.userSteer.recordedMessages());
      failure = cause instanceof Error ? cause : new Error(renderThrownChain({ cause }), { cause });

      if (failure.message !== INTERRUPTED_TURN && !active.abort.signal.aborted) this.orchestrator.acc.hadError = true;
      emit({ type: 'error', message: renderThrownChain({ cause }) });
    } finally {
      active.phase = 'settling';

      // The working history the turn leaves behind, recorded once the turn's
      // messages are final — including a failed or interrupted turn, whose
      // partial tail is just as much the history the next request builds on.
      // The plane's array replaces this instance's, because an edit that landed
      // mid-turn is in the LANDED revision and not in the array the SDK rebuilt
      // each step from; keeping the latter would drop the edit at the boundary.
      if (active.claim !== null) {
        const settled = this.context.endTurn({ turnId: lease.turnId, history: this.messages });
        this.messages.splice(0, this.messages.length, ...settled.messages);
      }
    }

    return {
      text, failure, program, claim: active.claim,
      interrupted: active.abort.signal.aborted || failure?.message === INTERRUPTED_TURN,
    };
  }

  private requireTurn(lease: ActorTurnLease): ActiveTurn {
    if (this.active?.lease !== lease) throw new KinuError('denied', 'the actor turn lease is no longer active');

    return this.active;
  }
}
