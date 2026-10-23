/** The workspace half of an agent's turns (D9): their tools and sources. */
import { hold, KinuError, logged, settle, settleSync } from '@kinu.run/core/obs';
import { Effect, Exit } from 'effect';
import {
  AgentOpenTurns, TurnFences, type FencedRow, decodeModelMessageValues, encodeModelMessageValues, materializeTurnSources, callableToolNames, buildHeadMessages, scaffoldProviders, runWorkModeInvocation,
  announcementOf, type SeatedActor, type TurnSurface,
  type ActorReference, type DynamicContext, type ModelPricing, type ResolvedTurnProfile, type TierId, type WorkMode,
  type HeadInput, type RunInference, type HeadReport, type SqlExecutor, type MissionBudgetPort, type MissionGovernor, type Executor, turnTags,
  openingCacheCold, type OpenWork, advisorReadTool, advisorReadTools, describeAgentTools, renderToolResult, type AdvisorReadTools, type AgentAdvisorRead,
  type AgentToolDescriptor, type ServedStores,
} from '@kinu.run/core';
import type { TurnCall } from './agent-facets';
import type { TurnBound, TurnCapabilityOf } from './agent-facet/agent-turn';
import { prepareHostedTurn, type HostedActorSeams, type HostedTurnRequest, type PreparedHostedTurn } from './hosted-actors';
import type { AgentHeadDelta, AgentTurnTask, AgentToolAnswer, AgentToolCall, AgentTrace, AgentTurnEnd, Fact, AgentOwes, FrozenAuthority, JsonObject, PreparedAgentTurn, RunEndReport, StoredRow, TaskPlan, OpenedAt, TurnFacts, TurnOpeningAsk, TurnReads } from '@kinu.run/core';

export interface AgentTurnsDeps {
  readonly sql: SqlExecutor;
  /** The agent's newest opening as the durable fence holds it. */
  readonly fence: (actorId: string) => FencedRow | null;
  seams(): HostedActorSeams;
  reference(actorId: string): ActorReference;
  /** Delivers a run to the agent (design v2 §1, D2), whose report tells its end (`runEnded`). Answers the failure of a
   *  delivery that neither crossed nor is owed, which is the run's end; null otherwise. */
  deliver(reference: ActorReference, task: AgentTurnTask): Promise<KinuError | null>;
  /** `cutoff`: the newest delivery its Stop cancelled, which the agent takes nothing at or below after. */
  interrupt(reference: ActorReference, turnId: string | null, cutoff: number | null): Promise<void>;
  /** The agent's own chat answers for itself whether it holds a turn, running or queued; one at rest is not asked. */
  chatOwed(reference: ActorReference): Promise<boolean>;
  chatIdle(reference: ActorReference): Promise<void>;
  /** What an execution of the agent froze as it bound, in its own store; null before then. */
  frozen(reference: ActorReference, key: Pick<TurnBound, 'turnId' | 'runId'>): Promise<FrozenAuthority | null>;
  pricing(spec: string): ModelPricing | null;
  accounts(): Readonly<Record<string, string>>;
  /** A real provider request of the agent's is starting: noted on its warming lane, which answers until when it kept the
   *  cache warm for the one sent at `lastRequestAt` (`CacheWarmingLane.noteRequest`). */
  noteRequest(actorId: string, lastRequestAt: number | null): number | null;
  /** The agent's open work, over its own rows (its tasks tool and its jobs run here): what its turn's task reminder reads. */
  openWork(actorId: string): OpenWork;
  /** The account's credentials revision as the turn's open read it; null before one opened. */
  credentialsRevision(): number | null;
  /** The governor an agent's chat turns spend under, when its missions are the workspace's: main's (D9). */
  missions(actorId: string): MissionGovernor | null;
  /** The agent has no turn open here any more, or it was stopped: what it held for its turns lets go, the computer's
   *  desktop among it (D89). Its owner runs it detached: nothing of the turn waits on it. */
  turnsEnded(actorId: string): void;
}

export interface ChatTurnRequest {
  readonly turnId: string | null;
  readonly mode: WorkMode;
  readonly userText: string;
  readonly parentDriven: boolean;
  /** The turn's author-stamped metadata, as the agent admitted it. */
  readonly driving?: JsonObject | undefined;
  /** The tier the agent's chat runs the turn on, when the turn names one; its sources are read for that tier's models. */
  readonly explicitTier?: TierId;
  /** Where the agent's chat opened the turn, and what it knows of its prompt cache: the workspace notes the turn's request
   *  on the agent's warming lane as it prepares it (`AgentTurnsDeps.noteRequest`). */
  readonly opening?: TurnOpeningAsk;
  /** The approved plan the turn implements, as the agent's own plan store reads it. */
  readonly taskPlan?: TaskPlan;
  /** Whether a plan of the agent's, sent back with comments, awaits its answers, as its own plan store reads it. */
  readonly awaitsReply: boolean;
  /** The run this opening prepares (a recovery continues its run, a Retry starts one) and its place in the agent's
   *  sequence: an opening older than the agent's newest is refused. */
  readonly runId?: string;
  readonly seq?: number;
  /** A recovered execution's authority, as it froze at its bind (D5): its surface, mode and sources are built on it, and
   *  nothing of the current settings is resolved. */
  readonly frozen?: FrozenAuthority;
  /** The agent's report its opening moved and no crossing told yet, numbered in its sequence: taken first, as a told one. */
  readonly owes?: AgentOwes;
}

interface OpenTurn {
  readonly reference: ActorReference;
  readonly request: HostedTurnRequest;
  prepared: PreparedHostedTurn | null;
  /** The account's facts, read once when the turn is read, so every step's block is the same bytes. */
  accountFacts?: readonly Fact[];
  /** The agent's unread mail, read with the facts for the same reason. */
  mail?: TurnReads['mail'];
  /** MEMORY.md's tail, read with its sources for the same reason. */
  memoryTail?: string;
  /** The opening the workspace's fence admitted for it: what it offers and closes must still be that one. */
  readonly fenced?: OpenedAt;
  /** A run's end, which its agent tells with a report (`runEnded`). */
  readonly ended?: ReturnType<typeof Promise.withResolvers<AgentTurnEnd>>;
  /** Its advisor's read-only tools over the agent's stores, on a ledger of their own (`advisorRead`). */
  advisor?: AdvisorReadTools;
}

/** Values held per agent's turn: a turn id names a turn only within its agent, whose owner's message ids are its own. */
class PerTurn<T> {
  private readonly byActor = new Map<string, Map<string, T>>();

  get(actorId: string, turnId: string): T | undefined {
    return this.byActor.get(actorId)?.get(turnId);
  }

  set(actorId: string, turnId: string, value: T): void {
    const turns = this.byActor.get(actorId) ?? new Map<string, T>();

    turns.set(turnId, value);
    this.byActor.set(actorId, turns);
  }

  delete(actorId: string, turnId: string): void {
    const turns = this.byActor.get(actorId);

    turns?.delete(turnId);

    if (turns?.size === 0) this.byActor.delete(actorId);
  }

  /** One agent's, by turn id. */
  of(actorId: string): ReadonlyMap<string, T> {
    return this.byActor.get(actorId) ?? new Map<string, T>();
  }

  values(): T[] {
    return [...this.byActor.values()].flatMap((turns) => [...turns.values()]);
  }
}

export class AgentTurns {
  private readonly open = new PerTurn<OpenTurn>();

  /** Each agent's chat turn as its room last heard it: a view for the overview, never an authority. */
  private readonly chats = new Map<string, string>();

  private readonly waiting = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();

  constructor(private readonly deps: AgentTurnsDeps) {}

  async run(reference: ActorReference, input: HeadInput, inference: RunInference): Promise<HeadReport> {
    const opened = { actorId: reference.actorId, turnId: input.id };
    const ledger = new AgentOpenTurns(this.deps.sql);
    const interruptions: Promise<void>[] = [];
    const cut = () => { interruptions.push(this.interruptRun(reference, input.id)); };

    const request: HostedTurnRequest = { sequenceId: input.id, body: input.task, mode: input.mode, parentDriven: false, driving: undefined, awaitsReply: false, run: { input, inference } };
    const ended = Promise.withResolvers<AgentTurnEnd>();

    this.open.set(reference.actorId, input.id, { reference, request, prepared: null, ended });
    ledger.open(opened, Date.now());
    inference.signal?.addEventListener('abort', cut, { once: true });

    try {
      if (inference.isAborted()) cut();
      const refused = await this.deps.deliver(reference, { sequenceId: input.id, runId: inference.runId, body: input.task, mode: input.mode });

      if (refused !== null) ended.reject(refused);
      const { activity: _activity, figures: _figures, produced, errorMessage, ...report } = await ended.promise;

      if (produced !== undefined) inference.reportMessages?.(decodeModelMessageValues(produced));

      return {
        ...report,
        errorMessage: errorMessage ?? undefined,
        fileChanges: inference.capture.files.snapshot(),
        ...(inference.isAborted() && { status: 'aborted', errorMessage: inference.abortReason?.() ?? errorMessage ?? undefined }),
      };
    } finally {
      inference.signal?.removeEventListener('abort', cut);
      ledger.close(opened);
      // Its end, told or not: no call of it holds from here, and a later execution's opening is not touched.
      new TurnFences(this.deps.sql).ended(reference.actorId, { runId: inference.runId });
      this.close(reference.actorId, input.id);
      await Promise.all(interruptions);
    }
  }

  /** A run's end as its agent's report told it: its open run's caller hears it. One this activation never ran is gone, and
   *  so is another generation's of the same id, whose caller went with a reset: the re-driven caller awaits its own. */
  async runEnded(actorId: string, report: RunEndReport): Promise<void> {
    const turn = this.open.get(actorId, report.id);
    const waiting = turn?.ended;

    if (waiting === undefined || turn?.request.run?.inference.runId !== report.runId) return;
    const { outcome } = report;

    if ('ended' in outcome) waiting.resolve(outcome.ended);
    else waiting.reject(new KinuError(outcome.refused.code, outcome.refused.message));
  }

  private async interruptRun(reference: ActorReference, turnId: string): Promise<void> {
    await hold(logged('agent.run_interrupt_failed', { doing: 'interrupting a run in its own isolate', otherwise: 'io' }, () => this.deps.interrupt(reference, turnId, null)));
  }

  /** Each open turn's cut: aborted once a Stop, a retirement or the workspace's deletion cut it off. A call bound to it
   *  that would run more of it is refused, whatever its opening, and one already running here ends with it. */
  private readonly cuts = new PerTurn<AbortController>();

  private cut(actorId: string, turnId: string): AbortController {
    const cut = this.cuts.get(actorId, turnId) ?? new AbortController();

    this.cuts.set(actorId, turnId, cut);

    return cut;
  }

  /** What a call bound to the agent's `turnId` that runs more of it races: its turn cut off. None for a turn this
   *  activation has not opened, which keeps no cut past its own close. */
  cutOff(actorId: string, turnId: string): AbortSignal | null {
    return this.open.get(actorId, turnId) === undefined ? null : this.cut(actorId, turnId).signal;
  }

  /**
   * A call that runs more of an execution holds while its capability does (design v2 §3): while the durable fence holds
   * the opening it names, a chat turn's or a run's alike (a later opening, a Stop or its end refuses it, before a reset of
   * this workspace as after). A measure carries none and runs nothing. One that opens an execution is judged by the
   * opening itself. A close (its trace, charges, answer metadata, end, settle) is judged by the opening it names, so an
   * execution's own close runs after its end, a Stop or a newer opening, and one naming another execution runs nothing
   * (`TurnFences.closes`).
   */
  holds(actorId: string, bound: TurnBound, call: TurnCall): boolean {
    if (call === 'opens') return true;
    const fence = bound.epoch === null ? null : this.deps.fence(actorId);
    const named = fence !== null && fence.seq === bound.epoch;

    // A close naming the agent's newest opening is judged by the fence's row, which that opening wrote with its own.
    if (call === 'settles') {
      return named ? fence.turnId === bound.turnId && fence.runId === bound.runId : new TurnFences(this.deps.sql).closes(actorId, { turnId: bound.turnId, runId: bound.runId, seq: bound.epoch });
    }

    return named && fence.live && fence.turnId === bound.turnId && fence.runId === bound.runId;
  }

  /** The turn is cut off: nothing bound to it runs from here, and what runs now ends. */
  private cancelled(actorId: string, turnId: string): void {
    const cut = this.cut(actorId, turnId);

    if (!cut.signal.aborted) cut.abort(new KinuError('cancelled', `turn ${turnId} was stopped`));
  }

  chatOpened(actorId: string, turnId: string): void {
    this.chats.set(actorId, turnId);
  }

  /** The chat turn the agent last said it began and has not said it ended. */
  chatTurn(actorId: string): string | null {
    return this.chats.get(actorId) ?? null;
  }

  /** The agent's open chat turn and the opening the fence admitted for it. */
  chatOpening(actorId: string): { readonly turnId: string; readonly fenced?: OpenedAt } | null {
    const turnId = this.chats.get(actorId);
    const fenced = turnId === undefined ? undefined : this.open.get(actorId, turnId)?.fenced;

    return turnId === undefined ? null : { turnId, ...(fenced !== undefined && { fenced }) };
  }

  /** What that turn's tools run under, when its preparation gave it a surface. */
  surface(actorId: string): TurnSurface | null {
    const turnId = this.chats.get(actorId);

    return turnId === undefined ? null : this.open.get(actorId, turnId)?.prepared?.surface.surface ?? null;
  }

  /** Closes the agent's chat turn if it is still the opening `at` names; null closes whichever is open. A later
   *  opening, the same turn's Retry included, stays open; a turn this activation read again after a restart carries no
   *  opening of its own, and is the one the fence held open. */
  chatClosed(actorId: string, at: OpenedAt | null): void {
    const turnId = this.chats.get(actorId);
    const fenced = turnId === undefined ? undefined : this.open.get(actorId, turnId)?.fenced;

    if (turnId === undefined || (at !== null && fenced !== undefined && fenced.seq !== at.seq)) return;
    this.chats.delete(actorId);
    this.close(actorId, turnId);
  }

  private close(actorId: string, turnId: string): void {
    const turn = this.open.get(actorId, turnId);

    this.open.delete(actorId, turnId);
    this.cuts.delete(actorId, turnId);

    if (turn !== undefined && this.open.of(actorId).size === 0) this.deps.turnsEnded(actorId);

    if (turn === undefined || this.inFlight(actorId)) return;
    this.waiting.get(actorId)?.resolve();
    this.waiting.delete(actorId);
  }

  private runOf(actorId: string): string | null {
    return this.openOf(actorId, (request) => request.run !== undefined);
  }

  /** The agent's open turn `is` picks: its run, or the chat turn it is preparing. */
  private openOf(actorId: string, is: (request: HostedTurnRequest) => boolean): string | null {
    for (const [turnId, turn] of this.open.of(actorId)) {
      if (is(turn.request)) return turnId;
    }

    return null;
  }

  /** Its chat turn, from the preparation it asked for until it says the turn ended; else its run. */
  private running(actorId: string): string | null {
    return this.chats.get(actorId) ?? this.preparing(actorId) ?? this.runOf(actorId);
  }

  private preparing(actorId: string): string | null {
    return this.openOf(actorId, (request) => request.chatTurnId !== undefined);
  }

  inFlightAny(): boolean {
    return this.chats.size > 0 || this.open.values().some((turn) => turn.request.run !== undefined || turn.request.chatTurnId !== undefined);
  }

  /** Handed out by this activation and not yet over. */
  isOpen(actorId: string, turnId: string): boolean {
    return this.open.get(actorId, turnId) !== undefined;
  }

  inFlight(actorId: string): boolean {
    return this.running(actorId) !== null;
  }

  /** Its runs have ended and its own chat holds nothing. */
  async settled(actorId: string): Promise<void> {
    if (this.runOf(actorId) !== null) {
      const waiting = this.waiting.get(actorId) ?? Promise.withResolvers<void>();

      this.waiting.set(actorId, waiting);
      await waiting.promise;
    }

    await this.deps.chatIdle(this.deps.reference(actorId));
  }

  /** Each agent's chat is asked once, as it answers for itself; runs are waited out, since a run may start another. */
  async idle(): Promise<void> {
    await Promise.all([...this.chats.keys()].map((actorId) => this.deps.chatIdle(this.deps.reference(actorId))));

    for (let runs = this.runActors(); runs.length > 0; runs = this.runActors()) await Promise.all(runs.map((actorId) => this.settled(actorId)));
  }

  private runActors(): string[] {
    return [...new Set(this.open.values().filter((turn) => turn.request.run !== undefined).map((turn) => turn.reference.actorId))];
  }

  /** Cuts the agent's turns off, its chat's and its run's: each call of theirs still running here ends with them. */
  async interrupt(actorId: string, cutoff: number | null): Promise<void> {
    const reference = this.deps.reference(actorId);
    const run = this.runOf(actorId);
    const chat = this.chats.get(actorId);

    for (const turnId of [run, chat]) if (turnId !== null && turnId !== undefined) this.cancelled(actorId, turnId);
    this.deps.turnsEnded(actorId);

    if (run !== null) await this.deps.interrupt(reference, run, null);
    await this.deps.interrupt(reference, null, cutoff);
  }

  currentTurn(actorId: string): string | null {
    return this.running(actorId);
  }

  /** Whether the agent holds a turn: a run this workspace started, or its own chat's, as the chat says. */
  async holdsTurn(actorId: string): Promise<boolean> {
    return this.runOf(actorId) !== null || await this.deps.chatOwed(this.deps.reference(actorId));
  }

  async beforeRetirement(actorId: string, interrupt: boolean): Promise<void> {
    if (!await this.holdsTurn(actorId)) return;

    if (interrupt) return await this.interrupt(actorId, null);

    return settleSync(Effect.fail(new KinuError('denied', 'This actor holds a turn in flight; retire it once the turn settles.')));
  }

  turn(actorId: string, turnId: string): OpenTurn {
    const turn = this.open.get(actorId, turnId);

    if (turn !== undefined) return turn;

    return settleSync(Effect.fail(new KinuError('missing', `No turn ${turnId} is open for this agent in the workspace.`)));
  }

  prepared(turn: OpenTurn): PreparedHostedTurn {
    if (turn.prepared !== null) return turn.prepared;

    return settleSync(Effect.fail(new KinuError('denied', 'The agent called the workspace before its turn was prepared.')));
  }

  /**
   * A workspace that restarted mid-turn reads a chat turn again under the capability its call carries, which the fence
   * held (`holds`): nothing is opened again. What its agent froze as it bound is read first, and the turn's surface, its
   * mode and its sources are built on it, resolving nothing (D5); one that never bound builds on the settings as they
   * are. A run's loop died with the activation that ran it.
   */
  private async reread(actorId: string, call: Pick<AgentToolCall, 'turnId' | 'runId' | 'epoch' | 'mode' | 'parentDriven' | 'driving'>): Promise<void> {
    const known = this.open.get(actorId, call.turnId);

    if (call.epoch === null || (known !== undefined && (known.prepared !== null || known.request.run !== undefined))) return;
    const frozen = await this.deps.frozen(this.deps.reference(actorId), call);

    await this.prepareChat(actorId, {
      turnId: call.turnId, runId: call.runId, mode: call.mode, userText: '', parentDriven: call.parentDriven, driving: call.driving, awaitsReply: false,
      ...(frozen !== null && { frozen }),
    }, { seq: call.epoch });

    if (frozen !== null) this.bind(actorId, call, frozen.profile);
  }

  private mode(turn: OpenTurn, prepared: PreparedHostedTurn): WorkMode {
    return turn.request.mode === 'plan' ? 'plan' : prepared.surface.resolved.profile.workMode;
  }

  private dynamic(turn: OpenTurn, prepared: PreparedHostedTurn): DynamicContext {
    const { offered, sources, resolved, surface } = prepared.surface;

    const reads: TurnReads = {
      memoryTail: turn.memoryTail, activeSkills: null,
      ...(turn.accountFacts !== undefined && { accountFacts: turn.accountFacts }), ...(turn.mail !== undefined && { mail: turn.mail }),
    };

    // The surface holds the profile its isolate bound, once bound, else the one it resolved.
    return sources.dynamic(reads)(surface.operation?.profile ?? resolved.profile, offered);
  }

  /** `held`: the opening the fence already holds for a turn read again after a restart (`reread`), opened by nothing. */
  async prepareChat(actorId: string, request: ChatTurnRequest, held?: OpenedAt): Promise<PreparedAgentTurn> {
    const turnId = request.turnId ?? crypto.randomUUID();

    // Delayed past the agent's later opening, or sent before the workspace reset: its execution is gone.
    if (held === undefined && request.turnId !== null && request.runId !== undefined && request.seq !== undefined
      && !new TurnFences(this.deps.sql).open(actorId, { turnId, runId: request.runId, seq: request.seq })) {
      return settleSync(Effect.fail(new KinuError('denied', `The opening of turn ${turnId} (${String(request.seq)} in its agent's sequence) is older than the agent's newest.`)));
    }

    const fenced = held ?? (request.seq === undefined ? undefined : { seq: request.seq });
    // Its request noted on the agent's warming lane as it opens, the lane's keep read first; a turn read again opens none.
    const ask = request.opening;
    const kept = ask === undefined ? null : this.deps.noteRequest(actorId, ask.lastRequestAt);

    const hosted: HostedTurnRequest = {
      sequenceId: announcementOf(turnId), ...(request.turnId !== null && { chatTurnId: turnId }),
      body: request.userText, mode: request.mode, parentDriven: request.parentDriven, driving: request.driving, awaitsReply: request.awaitsReply,
      ...(request.runId !== undefined && { runId: request.runId }),
      ...(ask !== undefined && { opening: { answerId: ask.answerId, cacheCold: openingCacheCold(ask, kept) } }),
      ...(request.taskPlan !== undefined && { taskPlan: request.taskPlan }),
      ...(request.explicitTier !== undefined && { explicitTier: request.explicitTier }),
      ...(request.frozen !== undefined && { frozen: request.frozen }),
    };

    const turn: OpenTurn = {
      reference: this.deps.reference(actorId),
      request: hosted,
      ...(fenced !== undefined && { fenced }),
      prepared: null,
    };

    // Running from here: the agent is preparing it. A preparation that fails, or that a later opening overtook, leaves
    // nothing open, as the agent never began it.
    if (request.turnId !== null) this.open.set(actorId, turnId, turn);

    return await settle(Effect.gen({ self: this }, function* () {
      const prepared = yield* Effect.promise(() => this.read(turn));

      // Finished after a later opening took its place, or after its run ended: none of it is the agent's to freeze.
      if (prepared === null) return yield* Effect.fail(new KinuError('denied', `The preparation of turn ${turnId} finished after a later opening of its agent.`));

      return { ...prepared, cacheKeptAliveUntil: kept, openWork: this.deps.openWork(actorId) };
    }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => {
      if (this.chats.get(actorId) !== turnId) this.close(actorId, turnId);
    })))));
  }

  /**
   * A delivered run's preparation, under its first round's capability: it opens the agent's fence for the run, as a chat
   * turn's preparation opens it, so a run and a chat turn of the agent are one sequence of executions. A run this
   * activation did not start (its caller went with a reset) is refused, and its opening ended: nobody here hears it.
   */
  async prepare(actorId: string, bound: TurnCapabilityOf): Promise<PreparedAgentTurn> {
    const fences = new TurnFences(this.deps.sql);
    const turn = this.open.get(actorId, bound.turnId);
    const run = turn?.request.run;

    if (turn === undefined || run === undefined || run.inference.runId !== bound.runId) {
      fences.ended(actorId, { runId: bound.runId });

      return settleSync(Effect.fail(new KinuError('denied', `Task ${bound.turnId} is not a run this workspace awaits.`)));
    }

    if (this.cuts.get(actorId, bound.turnId)?.signal.aborted === true) return settleSync(Effect.fail(new KinuError('cancelled', `Task ${bound.turnId} was stopped.`)));
    const opening = { turnId: bound.turnId, runId: bound.runId, seq: bound.epoch };
    const prior = fences.executionEpoch(actorId, opening);

    if (!fences.open(actorId, opening)) {
      return settleSync(Effect.fail(new KinuError('denied', `The opening of task ${bound.turnId} (${String(bound.epoch)} in its agent's sequence) is older than the agent's newest.`)));
    }

    const opened: OpenTurn = { ...turn, fenced: { seq: bound.epoch } };

    this.open.set(actorId, bound.turnId, opened);

    let prepared: PreparedAgentTurn | null = null;

    try {
      prepared = await this.read(opened);
    } finally {
      // A round its isolate never gets: the run's closes still name the opening before it, which its isolate holds.
      if (prepared === null) fences.unopen(actorId, opening, prior);
    }

    if (prepared === null) return settleSync(Effect.fail(new KinuError('denied', `The preparation of task ${bound.turnId} finished after a later opening of its agent.`)));

    return prepared;
  }

  /** Null when the opening it prepares was overtaken while it read: see {@link offeredFacts}. */
  private async read(turn: OpenTurn): Promise<PreparedAgentTurn | null> {
    const prepared = await prepareHostedTurn(this.deps.seams(), turn.reference, turn.request);
    const run = turn.request.run?.inference;
    const { actor, input, surface } = prepared;

    turn.prepared = prepared;
    [turn.accountFacts, turn.mail] = await Promise.all([surface.sources.accountFacts?.(), surface.sources.mail?.()]);
    const version = await actor.runtime.identity.scaffold.version();

    const scaffold = this.scaffold(actor, version);
    const mode = this.mode(turn, prepared);
    const { explicitTier, frozen } = turn.request;

    const sources = await materializeTurnSources(
      { ...surface.sources, toolset: () => ({ tools: surface.offered, stores: surface.stores }), externalTools: async () => ({}) },
      {
        userText: input.task, workMode: mode,
        ...(input.model !== undefined && { model: input.model }), ...(explicitTier !== undefined && { explicitTier }),
        // A recovered execution's model bundle is the one it froze, whatever the tier says now.
        ...(frozen !== undefined && { frozen }),
      },
    );

    turn.memoryTail = sources.memoryTail ?? undefined;
    const advisorTools = await this.advisorTools(turn, surface.stores);
    const brief = run?.brief?.(callableToolNames(mode, surface.offered));
    const facts = this.offeredFacts(turn, prepared);

    if (facts === null) return null;

    return {
      input,
      runId: surface.surface.key.runId,
      ...(run === undefined && { birthContext: encodeModelMessageValues(prepared.birthContext) }),
      sources,
      pricing: this.deps.pricing(prepared.model),
      accounts: this.deps.accounts(),
      credentialsRevision: this.deps.credentialsRevision(),
      scaffold,
      languages: actor.runtime.executor.languages,
      ...(brief !== undefined && { brief }),
      opening: encodeModelMessageValues(run === undefined ? [] : run.opening ?? buildHeadMessages(input)),
      tools: surface.descriptors,
      advisorTools,
      ownerLane: surface.ownerLane,
      dynamic: this.dynamic(turn, prepared),
      ...(run?.mission !== undefined && { missionLabels: run.mission.labels }),
      ...(this.chatMission(turn.reference.actorId, turn).length > 0 && { missionLabels: this.chatMission(turn.reference.actorId, turn) }),
      facts,
      trace: run?.reportStep !== undefined || run?.reportDelta !== undefined,
      resume: run?.resume !== undefined,
      reportMessages: run?.reportMessages !== undefined,
      cacheKeptAliveUntil: null,
    };
  }

  scaffold(actor: SeatedActor, version: number): StoredRow {
    const row = actor.runtime.storage.sql<StoredRow>`
      SELECT * FROM scaffold_versions WHERE actor_id = ${actor.record.actorId} AND version = ${version}`[0];

    if (row !== undefined) return row;

    return settleSync(Effect.fail(new KinuError('missing', "The agent's selected scaffold has no stored version.")));
  }

  /**
   * The profile the agent's isolate assembled the turn on, as its first step's pace carries it, or as its isolate froze
   * it for a turn read again after a restart (D5): the workspace's tools and live block read it, never a resolution of
   * their own. Answers the live block on it.
   */
  bind(actorId: string, bound: TurnBound, profile: ResolvedTurnProfile): DynamicContext {
    const turn = this.turn(actorId, bound.turnId);
    const prepared = this.prepared(turn);

    prepared.surface.bind(profile);

    return this.dynamic(turn, prepared);
  }

  async trace(actorId: string, bound: TurnBound, event: AgentTrace): Promise<void> {
    await this.namedRun(actorId, bound)?.reportStep?.(event.sequence, event.step);
  }

  /** Drained with no reader too: the step record waits on it. */
  async traceStream(actorId: string, bound: TurnBound, deltas: ReadableStream<AgentHeadDelta>): Promise<void> {
    const inference = this.namedRun(actorId, bound);

    for await (const { kind, delta } of deltas) inference?.reportDelta?.(kind, delta);
  }

  async resume(actorId: string, bound: TurnBound) {
    const resumed = await this.namedRun(actorId, bound)?.resume?.() ?? null;

    return resumed === null ? null : encodeModelMessageValues(resumed);
  }

  async guard(actorId: string, bound: TurnBound, ...args: Parameters<MissionBudgetPort['guard']>) {
    return await this.missionPort(actorId, bound)?.guard(...args) ?? null;
  }

  async debit(actorId: string, bound: TurnBound, ...args: Parameters<MissionBudgetPort['debit']>): Promise<void> {
    await this.missionPort(actorId, bound)?.debit(...args);
  }

  /** A run spends through its own mission. Main's chat turn spends through the workspace's governor under the labels its
   *  call names, as it did in this object: its last step's charge may land after its turn closed here. */
  private missionPort(actorId: string, bound: TurnBound): MissionBudgetPort | null {
    const governor = this.deps.missions(actorId);

    if (governor !== null) return { guard: async (seam, labels) => governor.guard(seam, labels), debit: async (tokens, opts) => { governor.debit(tokens, opts); } };

    return this.namedRun(actorId, bound)?.mission?.port ?? null;
  }

  /** The run a call bound to it names, by its turn and its run: a call of another generation, its run re-driven under the
   *  same turn since, reaches nothing of this one. None for a chat turn. */
  namedRun(actorId: string, bound: Pick<TurnBound, 'turnId' | 'runId'>): RunInference | undefined {
    const run = this.turn(actorId, bound.turnId).request.run;

    if (run !== undefined && run.inference.runId !== bound.runId) {
      return settleSync(Effect.fail(new KinuError('denied', `Run ${bound.runId} is not the run of ${bound.turnId} this workspace awaits.`)));
    }

    return run?.inference;
  }

  /** Main's surface decides its continuity and evolution gate; any other agent's turns continue its conversation. A run
   *  spends for its own missions, a chat turn for those its driving message names. */
  private facts(turn: OpenTurn, prepared: PreparedHostedTurn): TurnFacts {
    const { surface } = prepared.surface;

    return {
      continuity: surface.continuity, evolutionEnabled: surface.evolutionEnabled,
      missionLabels: [...turn.request.run?.inference.mission?.labels ?? turnTags({ metadata: turn.request.driving }).missionLabels],
    };
  }

  /** A chat run's facts as the workspace first offered them: the agent may die before it froze them, and its recovery
   *  must freeze the same, whatever changed here meanwhile. */
  private offeredFacts(turn: OpenTurn, prepared: PreparedHostedTurn): TurnFacts | null {
    const facts = this.facts(turn, prepared);

    return turn.fenced === undefined ? facts : new TurnFences(this.deps.sql).offer(turn.reference.actorId, turn.fenced, facts);
  }

  /** Main's chat turn names its missions when it is prepared under any. */
  private chatMission(actorId: string, turn: OpenTurn): readonly string[] {
    return turn.request.run === undefined && this.deps.missions(actorId) !== null ? [...turnTags({ metadata: turn.request.driving }).missionLabels] : [];
  }

  async program(actorId: string, turnId: string, ...[code, providers, opts]: Parameters<Executor['execute']>) {
    const turn = this.turn(actorId, turnId);
    const prepared = this.prepared(turn);
    const { actor } = prepared;
    const supplied = Array.isArray(providers) ? providers : [{ name: 'codemode', fns: providers }];
    const signal = turn.request.run?.inference.signal;
    // Its machines' `fs` runs the store operations its turn's tools run.
    const control = { stores: prepared.surface.stores, ...(signal !== undefined && { signal }) };

    return await actor.runtime.executor.execute(code, [...supplied, ...scaffoldProviders(actor.runtime, control, this.mode(turn, prepared))], opts);
  }

  /** The turn's advisor's read tools over the agent's stores, kept on the turn, and as its isolate is told of them. */
  private async advisorTools(turn: OpenTurn, stores: ServedStores): Promise<readonly AgentToolDescriptor[]> {
    turn.advisor = advisorReadTools({ files: stores.deps.files, memory: stores.deps.memory });
    const { file, memory } = turn.advisor;

    return (await describeAgentTools({ ...(file !== undefined && { file }), ...(memory !== undefined && { memory }) })).descriptors;
  }

  /** One of the turn's advisor's reads, on the advisor's own ledger: it never marks what the agent read. A turn this
   *  workspace no longer holds is not read again for it: the read fails, and the advisor decides without it. */
  async advisorRead(actorId: string, call: AgentAdvisorRead): Promise<string> {
    const turn = this.turn(actorId, call.turnId);
    const read = advisorReadTool(turn.advisor ?? {}, call.name);

    if (read?.execute === undefined) return settleSync(Effect.fail(new KinuError('bad_input', `The advisor has no read tool ${call.name}.`)));

    const output: unknown = await runWorkModeInvocation(this.mode(turn, this.prepared(turn)), () => read.execute?.(call.input, {
      toolCallId: call.callId, messages: [], context: undefined, abortSignal: this.cut(actorId, call.turnId).signal,
    }));

    // As the advisor reads every result: rendered whole here, windowed and redacted where it reads it.
    return renderToolResult(output);
  }

  async execute(actorId: string, call: AgentToolCall): Promise<AgentToolAnswer> {
    await this.reread(actorId, call);
    const turn = this.turn(actorId, call.turnId);
    const prepared = this.prepared(turn);
    const execute = prepared.surface.tools[call.name]?.execute;

    if (execute === undefined) return settleSync(Effect.fail(new KinuError('bad_input', `The agent called ${call.name}, which its turn's tool surface does not hold.`)));

    const { capture } = prepared.surface;

    const before = capture === null ? null : {
      evidence: capture.evidence.length, decisions: capture.decisions.length, artifacts: capture.artifacts.length,
      toolCalls: capture.toolCalls.length, childHeadIds: capture.childHeadIds.length,
    };

    // Aborted as the turn is cut off, so the tool it runs here stops with it.
    const output = await runWorkModeInvocation(this.mode(turn, prepared), () => execute(call.input, {
      toolCallId: call.callId, messages: [], context: undefined, abortSignal: this.cut(actorId, call.turnId).signal,
    }));

    return {
      output,
      ...(capture !== null && before !== null && { captured: {
        evidence: capture.evidence.slice(before.evidence),
        decisions: capture.decisions.slice(before.decisions),
        artifacts: capture.artifacts.slice(before.artifacts),
        toolCalls: capture.toolCalls.slice(before.toolCalls),
        childHeadIds: capture.childHeadIds.slice(before.childHeadIds),
      } }),
      dynamic: this.dynamic(turn, prepared),
      reports: { ...prepared.surface.reports },
      openWork: this.deps.openWork(actorId),
      crafted: prepared.surface.surface.ledgers.craft.call(call.callId),
    };
  }
}
