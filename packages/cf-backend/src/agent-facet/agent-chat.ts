/** A non-main agent's chat in its own isolate (D9). */
import {
  CHAT_SESSION_ID, ChatSession, EventLog, HeadCapture, PendingSendStore, RECOVERY_BACKOFF_CEILING_MS, TerminalTransitions,
  PlanReviewActions, announcementOf, assembleActorTurn, authoredTurnMetadata, chatTerminalEffects, chatTurnParts, declareTerminalRoster, inspectWork,
  planHandoffStillOwed, approvedTaskPlan, missionGate, workModeUnderReview, projectJsonValue, declareHandoffRoster, HandedOffTurnSchema, terminalEffect,
  metadataTier, subordinateTerminalEffects, withCompactionTrigger,
  bindRoute, completeOnRoute, ownProfileChoices, planWorkspaceTitle, resolveAgentTurnProfile, resolveModelRoute, routedLlm, suggestWorkspaceTitle,
  type ActorTurnLease, type BroadcastEvent, type ChatTurnInput, type TurnOpening, type JsonObject, type ComposedRequest, type HostedActor, type OwedEffect, type OwedTerminalEffectsInput,
  type InspectedWork, type PreparedAgentTurn, type PreparedTurn, type TerminalTurnFacts, type TerminalTurnParts,
  type SessionEvent, type TurnAssemblyRequest, type WorkMode,
} from '@kinu.run/core';
import { createCompactionStateStore, type CompactionStateStore } from '@kinu.run/compaction';
import { attempt, diagnostics, hold, logged, settle, type KinuError } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import type { AgentDatabase } from './agent-database';
import type { StepPacer } from './step-pacer';
import { FacetSpend, facetTurnSources, facetTurnTools, type AgentWorkspace, type FacetModels, type LiveTurn } from './agent-turn';

/** The words reach the room on the turn's own stream, and a turn's end on its own call. */
const ROOM_EVENTS: ReadonlySet<SessionEvent['type']> = new Set(['turn-start', 'step-cut', 'error', 'broadcast', 'history-reverted']);

export interface FacetChatDeps {
  readonly actor: HostedActor;
  readonly database: AgentDatabase;
  readonly workspace: AgentWorkspace;
  readonly models: FacetModels;
  readonly storage: DurableObjectStorage;
  readonly pacer: StepPacer;
}

/** A hirer's or the harness's turn runs in the hirer's lane, with `report`; the owner's, and a plan's feedback or approval
 *  (the owner's decision), in the owner's. */
function parentDrivenTurn(item: ChatTurnInput): boolean {
  return item.kind === 'programmatic' && item.metadata?.kinuEvent !== 'plan_feedback' && item.metadata?.kinuEvent !== 'plan_approved';
}

export class FacetChat {
  readonly session: ChatSession;

  private readonly trigger: { readonly state: CompactionStateStore; readonly key: string };

  private readonly spend: FacetSpend;

  /** Whether an advisor reviews the turn running. */
  private reviewsTurns = false;

  /** Whether the turn running answers the agent's hirer (a delegated task), not its owner. */
  private parentDriven = false;

  /** The turn's author-stamped metadata, which its tool calls carry: a plan it submits is judged by it. */
  private driving: JsonObject | undefined;

  /** Each plan update in the order its transition happened, delivered as soon as it happened. */
  private planDelivery: Promise<void> = Promise.resolve();

  /** Its own plan reviews, in its own store: the owner reviews them through its window (D9). */
  readonly plans: PlanReviewActions;

  private activeSkills: readonly string[] = [];

  private terminalTransitions: TerminalTransitions | null = null;

  /** What it owes is told in the order it is read, so an older answer never lands over a newer one. */
  private telling: Promise<unknown> = Promise.resolve();

  private resting: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: FacetChatDeps) {
    const { actor, storage, workspace } = deps;
    const sql = actor.runtime.storage.sql;

    this.trigger = { state: createCompactionStateStore(sql, actor.handle), key: actor.record.actorId };
    this.plans = new PlanReviewActions(actor.stores.planReviews, { broadcast: (event) => { this.announcePlan(event); } });
    this.spend = new FacetSpend(workspace);

    this.session = new ChatSession({
      actorSession: actor.session,
      sessionId: CHAT_SESSION_ID,
      transcript: actor.stores.history.transcript(CHAT_SESSION_ID),
      pendingSends: new PendingSendStore(sql, actor.handle.actorId),
      eventLog: new EventLog({ exec: (query, ...bindings) => storage.sql.exec(query, ...bindings) }, actor.handle),
      eventRecorder: actor.stores.eventRecorder,
      compactionState: this.trigger.state,
      transaction: (body) => storage.transactionSync(body),
      transport: {
        deliver: (event) => {
          // Its last charge lands before its end is told: nothing the workspace reads of the turn can miss it.
          if (event.type === 'turn-end') return this.charged().then(async () => { await workspace.turnEnded(event, deps.database.figures()); });

          return ROOM_EVENTS.has(event.type) ? workspace.chatEvent(event) : undefined;
        },
      },
      mintAnswerId: () => crypto.randomUUID(),
      ports: {
        prepareTurn: (item, lease, opening) => this.prepareTurn(item, lease, opening),
        composeRequest: () => this.composeRequest(),
        owedTerminalEffects: (input) => this.owedTerminalEffects(input),
        answerMetadata: async (turnId, texts) => await workspace.answerMetadata(turnId, await texts()),
        // What the turn already told its hirer is the agent's own record, so a reset of the workspace cannot repeat it.
        owedReport: async (ending, assistantText, narration) => await workspace.owedReport(
          { reports: this.deps.database.reports(this.session.currentTurnId ?? ''), ownerDriven: !this.parentDriven },
          { ending, assistantText, narration: await narration() },
        ),
        terminal: () => this.terminal,
        driverGate: () => null,
        armTurnWake: (atMs) => this.tell(atMs),
        quiet: () => { this.atRest(); },
        taskList: () => actor.stores.taskList,
        // Its jobs run in the workspace, whose settle wakes it.
        hasPendingAsyncWake: () => false,
        steerSkills: (text) => workspace.steerSkills(text, this.activeSkills),
        stillOwed: (metadata) => planHandoffStillOwed(metadata, actor.stores.planReviews),
        birthContext: (drainTurnId) => workspace.birthContext(drainTurnId),
      },
    });
  }

  private async assemble(prepared: PreparedAgentTurn, turn: { readonly id: string; readonly mode: WorkMode; readonly runId: string }, asked: TurnAssemblyRequest, bind?: Parameters<typeof assembleActorTurn>[0]['settle']) {
    const { actor, database, workspace, models, pacer } = this.deps;
    const live: LiveTurn = { dynamic: prepared.dynamic };

    const tools = facetTurnTools(workspace, prepared, actor, {
      id: turn.id, mode: turn.mode, parentDriven: this.parentDriven, driving: this.driving, live, capture: new HeadCapture(), database,
    });

    const { sources: bundle } = facetTurnSources({ actor, workspace, models, prepared, spend: this.spend, live, runId: turn.runId, turnId: turn.id, pacer });

    // A chat turn under a mission of its workspace's spends there, as each model call is guarded and charged.
    const { missionLabels } = prepared;

    const mission = missionLabels === undefined ? null : this.missionCharges = missionGate({
      labels: missionLabels,
      port: { guard: async (seam, labels) => await workspace.guard(turn.id, seam, labels), debit: async (tokens, opts) => { await workspace.debit(turn.id, tokens, opts); } },
    });

    return await assembleActorTurn({
      ...bundle,
      ...(mission !== null && { budget: mission }),
      toolset: () => tools,
      externalTools: async () => ({}),
      // A measure between turns binds nothing: no turn is open to bind it to.
      settle: async (profile, inputs) => {
        if (bind === undefined) return;
        await bind(profile, inputs);
        await bundle.settle?.(profile, inputs);
      },
    }, asked);
  }

  /** The running turn's charges to its workspace's missions, if it runs under any. */
  private missionCharges: { settled(): Promise<void> } | null = null;

  private async charged(): Promise<void> {
    const charges = this.missionCharges;

    this.missionCharges = null;
    await charges?.settled();
  }

  private async prepareTurn(item: ChatTurnInput, lease: ActorTurnLease, opening: TurnOpening): Promise<PreparedTurn> {
    const { actor, database, workspace } = this.deps;
    const plans = actor.stores.planReviews;
    // The one place a turn's lane is decided; the workspace rebuilds a turn from this, never from its id.
    this.parentDriven = parentDrivenTurn(item);
    this.driving = authoredTurnMetadata(item);
    // The owner's words while a plan awaits their decision are read as its review.
    const mode = workModeUnderReview(actor.session.workMode, this.driving, () => plans.getActive(CHAT_SESSION_ID));
    // The workspace reads the turn's sources for the tier it runs on, and the turn is assembled on that same tier.
    const explicitTier = metadataTier(item.metadata);
    const taskPlan = approvedTaskPlan(item, plans);

    const prepared = await workspace.prepareChat({
      turnId: lease.turnId, mode, userText: item.text, parentDriven: this.parentDriven, driving: this.driving, opening,
      ...(explicitTier !== undefined && { explicitTier }), ...(taskPlan !== null && { taskPlan }),
    });

    database.prepare(lease.turnId, prepared);
    this.reviewsTurns = prepared.reviewsTurns;

    const assembled = await this.assemble(prepared, { id: lease.turnId, mode, runId: lease.runId }, { userText: item.text, workMode: mode, ...(explicitTier !== undefined && { explicitTier }) }, (profile, inputs) => {
      actor.session.bindProfile(lease, profile, inputs);
    });

    this.activeSkills = assembled.activeSkills?.active.map((skill) => skill.name) ?? [];
    const historyLength = actor.session.history.length;
    const { key, state } = this.trigger;

    return {
      execution: withCompactionTrigger(assembled.execution, state, key, historyLength),
      sessionKey: key, contextWindow: assembled.window.contextWindow, historyLength, trial: prepared.trial ?? null,
    };
  }

  private announcePlan(event: BroadcastEvent): void {
    this.planDelivery = this.planDelivery.then(async () => { await this.deps.workspace.chatEvent({ type: 'broadcast', event }); });
  }

  /** A plan action, answered once each update it announced has reached the agent's window. */
  async planned<A>(act: (plans: PlanReviewActions) => A | Promise<A>): Promise<A> {
    const result = await act(this.plans);
    await this.planDelivery;

    return result;
  }

  private async composeRequest(): Promise<ComposedRequest> {
    const mode = this.deps.actor.session.workMode;
    const prepared = await this.deps.workspace.prepareChat({ turnId: null, mode, userText: '', parentDriven: false });
    const assembled = await this.assemble(prepared, { id: 'measure', mode, runId: prepared.runId }, { userText: '', workMode: mode });

    return { execution: assembled.execution, profile: assembled.profile, sessionKey: this.trigger.key };
  }

  /** As a CLI hire's: never sleep-time. The workspace's own agent owes its chat's follow-ups here and hands the rest of
   *  its settled turn to the workspace, whose evolution, event log and titles its lanes are. */
  private owedTerminalEffects(input: OwedTerminalEffectsInput): OwedEffect[] {
    const { session } = this.deps.actor;

    if (this.deps.actor.record.parentActorId === null) {
      return declareHandoffRoster(chatTurnParts(input), {
        turnId: this.session.currentTurnId ?? '', messageId: input.messageId, status: input.status, completed: input.completed,
        workMode: session.workMode, userText: input.userText, assistantText: input.assistantText, event: input.event ?? null,
        turn: projectJsonValue({ value: input.turn }), credited: input.credited, answeredDeliveries: [...input.answeredDeliveries],
        reachableTools: [...input.reachableTools], recordedAt: Date.now(),
      });
    }

    const scoped = session.orchestrator.scopedTurn(input.turn);

    const facts: TerminalTurnFacts = {
      messageId: input.messageId,
      status: input.status,
      workMode: session.workMode,
      continuity: 'conversation',
      completed: input.completed,
      userText: input.userText,
      assistantText: input.assistantText,
      scopedTurn: projectJsonValue({ value: scoped }),
      recordedAt: Date.now(),
      // Its lanes run in the workspace; this isolate's engine records nothing.
      evolutionEnabled: false,
    };

    const report = input.owedReport;

    const parts: TerminalTurnParts = {
      ...chatTurnParts(input),
      // Named once, from its brief (the turn that opened its conversation), however that turn ended: a later turn's
      // words ("Continue") are no name for it.
      ...(input.opensConversation() && { autoTitle: { mission: input.userText, standIn: true } }),
      sleepTime: false,
      ...(this.reviewsTurns && { advisor: projectJsonValue({ value: session.advisorSnapshot(scoped, input.reachableTools) }) }),
      ...(report !== null && {
        parentReport: {
          text: report.content,
          status: report.status,
          // An assignment's turn is keyed by it, so a re-run after a reset answers it once.
          sequenceId: this.parentDriven ? announcementOf(this.session.currentTurnId ?? '') : `${this.deps.actor.record.actorId}:turn-end:${input.messageId}`,
          ...(report.quiet === true && { quiet: true as const }),
        },
      }),
    };

    return declareTerminalRoster(facts, parts);
  }

  private get terminal(): TerminalTransitions {
    const { actor, storage, workspace } = this.deps;

    this.terminalTransitions ??= new TerminalTransitions({
      sql: actor.runtime.storage.sql,
      actor: actor.handle,
      effects: {
        ...chatTerminalEffects({ chat: () => this.session, orchestrator: actor.session.orchestrator, engine: { learnFromTurn: async () => {} } }),
        ...subordinateTerminalEffects({
          orchestrator: actor.session.orchestrator,
          hireAdvisor: (advisor) => workspace.hireAdvisor(advisor),
          applyTitle: (subject) => this.applyTitle(subject),
          sendReport: (report) => workspace.parentReport(report),
        }),
        workspace_settle: terminalEffect({
          input: HandedOffTurnSchema,
          run: async (settled) => {
            await workspace.turnSettled(settled);

            return { status: 'completed' };
          },
        }),
      },
      now: () => Date.now(),
      transaction: (body) => storage.transactionSync(body),
      turnIsLive: (turnId) => this.session.turnMayStillRun(turnId),
      scheduleRetry: (atMs) => this.tell(atMs),
      settled: async () => {},
      // An eviction leaves the effects owed; the workspace's wake re-drives them.
      hold: async (close) => {
        await close();
        this.atRest();
      },
    });

    return this.terminalTransitions;
  }

  async idle(): Promise<void> {
    while (this.session.pumpPromise !== null || this.terminal.closing) {
      await this.session.pumpPromise;
      await this.terminal.idle();
    }

    await this.resting;
    await this.spend.settled();
  }

  /** Every wake re-arms what is still owed, so an effect still closing when it fires keeps a wake after it; the pump
   *  it ends on tells the workspace what is left once it rests. */
  wake(): Promise<void> {
    return settle(attempt({ doing: "resuming what an agent's isolate owed", otherwise: 'unavailable' }, async () => {
      this.session.reclaimStrandedEventDeliveries();
      await this.terminal.replayOwedAndRearm();
      await this.session.flushPendingDrains();
    }).pipe(
      Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('agent.wake_failed', failure); })),
      Effect.ensuring(Effect.sync(() => { this.session.pump(); })),
    ));
  }

  /** At rest once no turn runs or waits and no close is held, and each rest is told once. */
  private atRest(): void {
    if (this.session.pumping || this.terminal.closing) return;
    this.resting = hold(logged('agent.owed_report_failed', { doing: 'telling the workspace what an agent still owes', otherwise: 'unavailable' }, () => this.tell()));
  }

  /** Its input taken: what it owes now is told behind every answer it sent before, and has landed. An older rest cannot
   *  cancel the workspace's arm for the input, and a turn the input ran and ended already leaves no arm behind. */
  async taken(): Promise<void> {
    await hold(logged('agent.owed_report_failed', { doing: 'telling the workspace what an agent owes for its input', otherwise: 'unavailable' }, () => this.tell()));
  }

  /** `at` asks for a wake no later than it. */
  private tell(at?: number): Promise<void> {
    const told = this.telling.then(() => {
      const owed = this.owed();

      return this.deps.workspace.owes(at === undefined ? owed : Math.min(at, owed ?? Infinity), owed !== null || this.owedWork().length > 0);
    });

    this.telling = hold(attempt({ doing: 'telling the workspace what an agent still owes', otherwise: 'unavailable' }, () => told));

    return told;
  }

  /** Its own turns and effects still owed, folded as the workspace's read folds the root's. */
  owedWork(): InspectedWork[] {
    const { actor } = this.deps;
    const { ledger } = this.terminal;
    const name = actor.record.name;
    const running = actor.session.turnClaim?.turnId;

    return inspectWork({
      claims: actor.stores.claims.unsettled().map((claim) => ({ claim, actor: name })),
      agentTurns: [],
      executing: new Set(running === undefined ? [] : [running]),
      effects: ledger.pendingSequences().flatMap((sequence) => ledger.owed(sequence)).map((effect) => ({ effect, actor: name })),
      now: Date.now(),
    });
  }

  /** The stand-in lands first, as every actor's does: the model's name may be refused, and parks here. */
  private async applyTitle(subject: string): Promise<void> {
    const { actor, workspace } = this.deps;
    const { config } = actor.stores;
    const plan = planWorkspaceTitle({ slug: actor.record.name, displayName: config.getDisplayName(), nameOrigin: config.getNameOrigin(), mission: subject });

    if (plan === null) return;

    if (plan.provisional !== null) await workspace.autoTitle(subject, null);
    await workspace.autoTitle(subject, await this.suggestTitle(plan.mission));
  }

  /** Down the fast tier's chain on the agent's own models, as every actor's title is named. */
  private async suggestTitle(mission: string): Promise<string | null> {
    const { actor, workspace, models, pacer } = this.deps;
    const workMode = actor.session.workMode;
    const prepared = await workspace.prepareChat({ turnId: null, mode: workMode, userText: '', parentDriven: false });
    const { sources } = facetTurnSources({ actor, workspace, models, prepared, spend: this.spend, live: { dynamic: prepared.dynamic }, runId: prepared.runId, turnId: 'title', pacer });
    const inputs = await sources.profileInputs();
    const profile = resolveAgentTurnProfile({ ...inputs, ...ownProfileChoices(sources.config, inputs, sources.ancestors?.()), workMode, availableTools: [], activeSkills: [] });
    const route = resolveModelRoute('fast', profile);
    const { routed } = sources.models;

    return await suggestWorkspaceTitle((system, prompt) => completeOnRoute(route, {
      llm: (resolution) => routedLlm((serving) => bindRoute(sources.models, serving), resolution, { report: this.spend.report, operations: this.spend.operations }, system),
      ...(routed !== undefined && { credentialOf: (spec: string) => routed.credentialFor(spec) }),
    }, prompt), mission);
  }

  /** The workspace's model settings changed: the next request is measured on them, and a refusal they fix may answer. */
  async modelSettingsChanged(): Promise<void> {
    this.session.reviseContext({ counted: true });
    await this.terminal.modelSettingsChanged();
  }

  /** The owner's Clear, refused while a turn runs; its compaction plan goes with the conversation. Answers why the
   *  emptied request went unmeasured, if it did. */
  async clear(): Promise<KinuError | null> {
    const unmeasured = await this.session.clear();

    await this.trigger.state.plans.save(this.trigger.key, null);

    return unmeasured;
  }

  /** The next instant to wake it, or none: a turn running or queued, or effects still closing, is looked at again a lap
   *  later. */
  private owed(): number | null {
    const busy = this.session.turnOwed || this.terminal.closing || this.terminal.hasIncomplete();

    // The workspace keeps one wake per agent, the latest it was told: a turn waiting out its backoff names its end.
    const next = Math.min(
      this.terminal.nextRetryAt() ?? Infinity, this.session.reaskDeferredTo() ?? Infinity, busy ? Date.now() + RECOVERY_BACKOFF_CEILING_MS : Infinity,
    );

    return Number.isFinite(next) ? next : null;
  }
}
