/** The workspace half of an agent's turns (D9): their tools and sources. */
import { asSchema, type ToolSet } from 'ai';
import { hold, KinuError, logged, settleSync } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import {
  AgentOpenTurns, decodeModelMessageValues, encodeModelMessageValues, materializeTurnSources, callableToolNames, buildHeadMessages, hasPlanPermission, scaffoldProviders, runWorkModeInvocation, toolDescription,
  BUILTIN_TOOL_NAMES, announcementOf,
  type ActorReference, type DynamicContext, type ModelPricing, type ResolvedTurnProfile, type WorkMode,
  type HeadInput, type RunInference, type HeadReport, type SqlExecutor, type MissionBudgetPort, type Executor,
} from '@kinu.run/core';
import { prepareHostedTurn, type HostedActorSeams, type HostedTurnRequest, type PreparedHostedTurn } from './hosted-actors';
import type { AgentHeadDelta, AgentReview, AgentTurnTask, AgentToolAnswer, AgentToolCall, AgentToolDescriptor, AgentTrace, AgentTurnEnd, PreparedAgentTurn, StoredRow } from '@kinu.run/core';

export interface AgentTurnsDeps {
  readonly sql: SqlExecutor;
  seams(): HostedActorSeams;
  reference(actorId: string): ActorReference;
  run(reference: ActorReference, task: AgentTurnTask): Promise<AgentTurnEnd>;
  interrupt(reference: ActorReference, turnId: string | null): Promise<void>;
  /** The agent's own chat answers for itself whether it holds a turn, running or queued; one at rest is not asked. */
  chatOwed(reference: ActorReference): Promise<boolean>;
  chatIdle(reference: ActorReference): Promise<void>;
  pricing(spec: string): ModelPricing | null;
  accounts(): Readonly<Record<string, string>>;
}

export interface ChatTurnRequest {
  readonly turnId: string | null;
  readonly mode: WorkMode;
  readonly userText: string;
  readonly parentDriven: boolean;
}

interface OpenTurn {
  readonly reference: ActorReference;
  readonly request: HostedTurnRequest;
  prepared: PreparedHostedTurn | null;
  /** Over the turn's own tools, as its isolate resolves it. */
  profile: ResolvedTurnProfile | null;
}

async function describe(tools: ToolSet): Promise<AgentToolDescriptor[]> {
  return await Promise.all(Object.entries(tools).map(async ([name, tool]) => ({
    name,
    description: toolDescription(tool) ?? '',
    inputSchema: await asSchema(tool.inputSchema).jsonSchema,
    planAllowed: hasPlanPermission(tool),
  })));
}

export class AgentTurns {
  private readonly open = new Map<string, OpenTurn>();

  /** Each agent's chat turn as its room last heard it: a view for the overview, never an authority. */
  private readonly chats = new Map<string, string>();

  /** Tasks handed to an agent's chat and not yet answered: its actor stays held while one is out. */
  private readonly handing = new Map<string, number>();

  private readonly waiting = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();

  constructor(private readonly deps: AgentTurnsDeps) {}

  async run(reference: ActorReference, input: HeadInput, inference: RunInference): Promise<HeadReport> {
    const opened = { actorId: reference.actorId, turnId: input.id };
    const ledger = new AgentOpenTurns(this.deps.sql);
    const interruptions: Promise<void>[] = [];
    const cut = () => { interruptions.push(this.interruptRun(reference, input.id)); };

    const request: HostedTurnRequest = { sequenceId: input.id, body: input.task, mode: input.mode, parentDriven: false, run: { input, inference } };

    this.open.set(input.id, { reference, request, prepared: null, profile: null });
    ledger.open(opened, Date.now());
    inference.signal?.addEventListener('abort', cut, { once: true });

    try {
      if (inference.isAborted()) cut();
      const { activity: _activity, narration: _narration, figures: _figures, produced, errorMessage, ...report } = await this.deps.run(reference, { sequenceId: input.id, body: input.task, mode: input.mode });

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
      this.close(input.id);
      await Promise.all(interruptions);
    }
  }

  private async interruptRun(reference: ActorReference, turnId: string): Promise<void> {
    await hold(logged('agent.run_interrupt_failed', { doing: 'interrupting a run in its own isolate', otherwise: 'io' }, () => this.deps.interrupt(reference, turnId)));
  }

  chatOpened(actorId: string, turnId: string): void {
    this.chats.set(actorId, turnId);
  }

  chatClosed(actorId: string): void {
    const turnId = this.chats.get(actorId);

    this.chats.delete(actorId);

    if (turnId !== undefined) this.close(turnId);
  }

  private close(turnId: string): void {
    const turn = this.open.get(turnId);

    this.open.delete(turnId);

    if (turn === undefined || this.inFlight(turn.reference.actorId)) return;
    this.waiting.get(turn.reference.actorId)?.resolve();
    this.waiting.delete(turn.reference.actorId);
  }

  private runOf(actorId: string): string | null {
    for (const [turnId, turn] of this.open) {
      if (turn.reference.actorId === actorId && turn.request.run !== undefined) return turnId;
    }

    return null;
  }

  private running(actorId: string): string | null {
    return this.chats.get(actorId) ?? this.runOf(actorId);
  }

  inFlightAny(): boolean {
    return this.chats.size > 0 || [...this.open.values()].some((turn) => turn.request.run !== undefined);
  }

  /** Handed out by this activation and not yet over. */
  holds(turnId: string): boolean {
    return this.open.has(turnId);
  }

  inFlight(actorId: string): boolean {
    return this.running(actorId) !== null || (this.handing.get(actorId) ?? 0) > 0;
  }

  async handOff<A>(actorId: string, work: () => Promise<A>): Promise<A> {
    this.handing.set(actorId, (this.handing.get(actorId) ?? 0) + 1);

    try {
      return await work();
    } finally {
      const left = (this.handing.get(actorId) ?? 1) - 1;

      if (left > 0) this.handing.set(actorId, left);
      else this.handing.delete(actorId);
    }
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
    return [...new Set([...this.open.values()].filter((turn) => turn.request.run !== undefined).map((turn) => turn.reference.actorId))];
  }

  /** The chat is asked whatever the view says: a workspace that reset since its turn began has no view of it. */
  async interrupt(actorId: string): Promise<void> {
    const reference = this.deps.reference(actorId);
    const run = this.runOf(actorId);

    if (run !== null) await this.deps.interrupt(reference, run);
    await this.deps.interrupt(reference, null);
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

    if (interrupt) return await this.interrupt(actorId);

    return settleSync(Effect.fail(new KinuError('denied', 'This actor holds a turn in flight; retire it once the turn settles.')));
  }

  turn(actorId: string, turnId: string): OpenTurn {
    const turn = this.open.get(turnId);

    if (turn !== undefined && turn.reference.actorId === actorId) return turn;

    return settleSync(Effect.fail(new KinuError('missing', `No turn ${turnId} is open for this agent in the workspace.`)));
  }

  prepared(turn: OpenTurn): PreparedHostedTurn {
    if (turn.prepared !== null) return turn.prepared;

    return settleSync(Effect.fail(new KinuError('denied', 'The agent called the workspace before its turn was prepared.')));
  }

  /** A workspace that restarted mid-turn reads a chat turn again. */
  private async reread(actorId: string, call: Pick<AgentToolCall, 'turnId' | 'mode'>): Promise<void> {
    const known = this.open.get(call.turnId);

    if (known !== undefined && (known.prepared !== null || known.request.run !== undefined)) return;
    await this.prepareChat(actorId, { turnId: call.turnId, mode: call.mode, userText: '', parentDriven: call.turnId.startsWith('programmatic:') });
  }

  private mode(turn: OpenTurn, prepared: PreparedHostedTurn): WorkMode {
    return turn.request.mode === 'plan' ? 'plan' : prepared.turn.profile.profile.workMode;
  }

  private dynamic(turn: OpenTurn, prepared: PreparedHostedTurn): DynamicContext {
    const { tools, sources } = prepared;

    return sources.dynamic({ memoryTail: undefined, activeSkills: null })(turn.profile ?? prepared.turn.profile.profile, tools);
  }

  async prepareChat(actorId: string, request: ChatTurnRequest): Promise<PreparedAgentTurn> {
    const turnId = request.turnId ?? crypto.randomUUID();

    const turn: OpenTurn = {
      reference: this.deps.reference(actorId),
      request: { sequenceId: announcementOf(turnId), body: request.userText, mode: request.mode, parentDriven: request.parentDriven },
      prepared: null,
      profile: null,
    };

    if (request.turnId !== null) this.open.set(turnId, turn);

    return await this.read(turn);
  }

  async prepare(actorId: string, turnId: string): Promise<PreparedAgentTurn> {
    return await this.read(this.turn(actorId, turnId));
  }

  private async read(turn: OpenTurn): Promise<PreparedAgentTurn> {
    const prepared = await prepareHostedTurn(this.deps.seams(), turn.reference, turn.request);
    const run = turn.request.run?.inference;

    turn.prepared = prepared;
    const { actor, input } = prepared.turn;

    const version = await actor.runtime.identity.scaffold.version();

    const scaffold = this.scaffold(actor, version);
    const mode = this.mode(turn, prepared);

    const sources = await materializeTurnSources(
      {
        ...prepared.sources,
        toolset: () => prepared.tools,
        externalTools: async () => ({}),
        wiredToolNames: () => Object.keys(prepared.tools).filter((name) => !BUILTIN_TOOL_NAMES.has(name)),
        codemodeCapabilities: () => [],
      },
      { userText: input.task, workMode: mode, ...(input.model !== undefined && { model: input.model }) },
    );

    const brief = run?.brief?.(callableToolNames(mode, prepared.tools));

    return {
      input,
      runId: run?.runId ?? crypto.randomUUID(),
      ...(run === undefined && { birthContext: encodeModelMessageValues(prepared.birthContext) }),
      sources,
      pricing: this.deps.pricing(prepared.model),
      accounts: this.deps.accounts(),
      scaffold,
      languages: actor.runtime.executor.languages,
      ...(brief !== undefined && { brief }),
      opening: encodeModelMessageValues(run === undefined ? [] : run.opening ?? buildHeadMessages(input)),
      tools: await describe(prepared.tools),
      dynamic: this.dynamic(turn, prepared),
      reviewsTurns: actor.session.reviewsTurns,
      ...(run?.mission !== undefined && { missionLabels: run.mission.labels }),
      trace: run?.reportStep !== undefined || run?.reportDelta !== undefined,
      resume: run?.resume !== undefined,
      reportMessages: run?.reportMessages !== undefined,
    };
  }

  scaffold(actor: PreparedHostedTurn['turn']['actor'], version: number): StoredRow {
    const row = actor.runtime.storage.sql<StoredRow>`
      SELECT * FROM scaffold_versions WHERE actor_id = ${actor.record.actorId} AND version = ${version}`[0];

    if (row !== undefined) return row;

    return settleSync(Effect.fail(new KinuError('missing', "The agent's selected scaffold has no stored version.")));
  }

  /** The profile the agent's isolate assembled the turn on: the workspace's tools and live block read it, never a
   *  resolution of their own. Answers the live block on it. */
  bindProfile(actorId: string, turnId: string, profile: ResolvedTurnProfile): DynamicContext {
    const turn = this.turn(actorId, turnId);

    turn.profile = profile;

    return this.dynamic(turn, this.prepared(turn));
  }

  async advise(actorId: string, { turnId, turn: completed, reachable, mode }: AgentReview): Promise<void> {
    const turn = this.turn(actorId, turnId);
    const advise = turn.request.run?.inference.advise;

    if (advise !== undefined) return await advise(completed, reachable, mode);

    const { session } = this.prepared(turn).turn.actor;

    if (!session.orchestrator.improvementLanesOpen('completed', mode)) return;

    await session.hireAdvisor(session.advisorSnapshot(completed, reachable));
  }

  async trace(actorId: string, turnId: string, event: AgentTrace): Promise<void> {
    await this.turn(actorId, turnId).request.run?.inference.reportStep?.(event.sequence, event.step);
  }

  /** Drained with no reader too: the step record waits on it. */
  async traceStream(actorId: string, turnId: string, deltas: ReadableStream<AgentHeadDelta>): Promise<void> {
    const inference = this.turn(actorId, turnId).request.run?.inference;

    for await (const { kind, delta } of deltas) inference?.reportDelta?.(kind, delta);
  }

  async resume(actorId: string, turnId: string) {
    const resumed = await this.turn(actorId, turnId).request.run?.inference.resume?.() ?? null;

    return resumed === null ? null : encodeModelMessageValues(resumed);
  }

  async guard(actorId: string, turnId: string, ...args: Parameters<MissionBudgetPort['guard']>) {
    return await this.turn(actorId, turnId).request.run?.inference.mission?.port.guard(...args) ?? null;
  }

  async debit(actorId: string, turnId: string, ...args: Parameters<MissionBudgetPort['debit']>): Promise<void> {
    await this.turn(actorId, turnId).request.run?.inference.mission?.port.debit(...args);
  }

  async program(actorId: string, turnId: string, ...[code, providers, opts]: Parameters<Executor['execute']>) {
    const turn = this.turn(actorId, turnId);
    const prepared = this.prepared(turn);
    const { actor } = prepared.turn;
    const supplied = Array.isArray(providers) ? providers : [{ name: 'codemode', fns: providers }];
    const signal = turn.request.run?.inference.signal;
    const control = signal === undefined ? {} : { signal };

    return await actor.runtime.executor.execute(code, [...supplied, ...scaffoldProviders(actor.runtime, control, this.mode(turn, prepared))], opts);
  }

  async execute(actorId: string, call: AgentToolCall): Promise<AgentToolAnswer> {
    await this.reread(actorId, call);
    const turn = this.turn(actorId, call.turnId);
    const prepared = this.prepared(turn);
    const execute = prepared.tools[call.name]?.execute;

    if (execute === undefined) return settleSync(Effect.fail(new KinuError('bad_input', `The agent called ${call.name}, which its turn's tool surface does not hold.`)));

    const { capture } = prepared.turn;

    const before = {
      evidence: capture.evidence.length, decisions: capture.decisions.length, artifacts: capture.artifacts.length,
      toolCalls: capture.toolCalls.length, childHeadIds: capture.childHeadIds.length,
    };

    const output = await runWorkModeInvocation(this.mode(turn, prepared), () => execute(call.input, { toolCallId: call.callId, messages: [], context: undefined }));

    return {
      output,
      captured: {
        evidence: capture.evidence.slice(before.evidence),
        decisions: capture.decisions.slice(before.decisions),
        artifacts: capture.artifacts.slice(before.artifacts),
        toolCalls: capture.toolCalls.slice(before.toolCalls),
        childHeadIds: capture.childHeadIds.slice(before.childHeadIds),
      },
      dynamic: this.dynamic(turn, prepared),
      reports: { ...prepared.turn.reports },
    };
  }
}
