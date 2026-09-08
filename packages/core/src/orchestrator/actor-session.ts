import type { ModelMessage } from 'ai';
import { INTERRUPTED_TURN, type ChatEvent, type ChatOptions } from '../chat';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ResolvedTurnProfile, ProfileAuthorityInputs } from '../profiles';
import type { WorkMode } from '../prompting/surface';
import { DynamicContextLedger, type DynamicContext } from '../prompting/volatile-context';
import type { KinuExtension } from '../extension';
import { ExtensionHost } from '../extension';
import { KinuError, renderThrownChain } from '../obs/index';
import { AgentOrchestrator, type AgentOrchestratorDeps } from './agent-orchestrator';
import { describeLandedSteers, UserSteerDrain, type LandedSteerRow, type UserSteer } from './user-steer';
import { prepareActorTurn } from './actor-turn';
import type { ActorTurnProgram } from './actor-program';
import type { ModelCallSpend } from '../events/model-call';

export interface ActorSessionOptions {
  readonly runtime: AgentRuntime;
  readonly orchestration: AgentOrchestratorDeps;
}

/** Live-instance execution token, not a replacement for a durable turn/run claim. */
export interface ActorTurnLease {
  readonly actorId: string;
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
}

export interface ActorExecutionResult {
  readonly text: string;
  readonly failure: Error | null;
  readonly interrupted: boolean;
  /** Null when preparation failed before any program was selected. */
  readonly program: ActorTurnProgram | null;
}

interface ActiveTurn {
  readonly lease: ActorTurnLease;
  readonly abort: AbortController;
  phase: 'preparing' | 'running' | 'settling';
  profile: ResolvedTurnProfile | null;
  profileInputs: ProfileAuthorityInputs | null;
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

  constructor(private readonly options: ActorSessionOptions) {
    this.actorId = options.runtime.actor.actorId;
    this.runtime = options.runtime;
    this.orchestrator = new AgentOrchestrator(options.orchestration);
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

  /** Hydration is not a working-context edit. Active edits belong to the store's
   * staged revision path, not to a host replacing an in-flight array. */
  restoreHistory(messages: readonly ModelMessage[]): void {
    if (this.active !== null) throw new KinuError('denied', 'cannot hydrate actor history during an admitted turn');
    this.messages.splice(0, this.messages.length, ...messages);
  }

  appendInput(lease: ActorTurnLease, message: ModelMessage): void {
    if (this.requireTurn(lease).phase !== 'preparing') throw new KinuError('denied', 'actor input must belong to a preparing turn');
    this.messages.push(message);
  }

  beginTurn<Metadata>(turnId: string, mode: WorkMode, startedAt: number, metadata?: Metadata): ActorTurnLease {
    if (this.active !== null) throw new KinuError('denied', 'this actor already has an admitted turn');
    const abort = new AbortController();
    const lease: ActorTurnLease = Object.freeze({ actorId: this.actorId, turnId, signal: abort.signal });
    this.active = { lease, abort, phase: 'preparing', profile: null, profileInputs: null };
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

  finishTurn(lease: ActorTurnLease): void {
    const active = this.requireTurn(lease);
    if (active.phase === 'running') throw new KinuError('denied', 'cannot release an actor while its program is running');
    this.active = null;
  }

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
      const prepared = await prepareActorTurn({
        runtime: this.runtime, mode: this.mode, task: input.task, loopVersion: input.loopVersion,
        scaffoldSpend: input.scaffoldSpend,
        chat: { ...input.chat, history: this.messages, signal: active.abort.signal, extensions,
          meter: this.orchestrator.acc.composition, dynamicContext: { ledger: this.dynamic, snapshot: input.dynamic } },
      });
      program = prepared.program;
      for await (const event of prepared.events) {
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
          case 'error': this.orchestrator.acc.hadError = true; break;
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
    }
    return { text, failure, interrupted: active.abort.signal.aborted || failure?.message === INTERRUPTED_TURN, program };
  }

  private requireTurn(lease: ActorTurnLease): ActiveTurn {
    if (this.active?.lease !== lease) throw new KinuError('denied', 'the actor turn lease is no longer active');
    return this.active;
  }
}
