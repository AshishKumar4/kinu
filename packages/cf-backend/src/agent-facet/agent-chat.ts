/** A non-main agent's chat in its own isolate (D9). */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CHAT_SESSION_ID, ChatSession, EventLog, PendingSendStore, RECOVERY_BACKOFF_CEILING_MS, TRANSCRIPT_WINDOW, TerminalTransitions,
  PlanReviewActions, announcementOf, assembleActorTurn, authoredTurnMetadata, chatTerminalEffects, chatTurnParts, declareTerminalRoster, inspectWork,
  planHandoffStillOwed, planAwaitingReply, approvedTaskPlan, missionGate, workModeUnderReview, projectJsonValue, declareHandoffRoster, HandedOffTurnSchema, runSettleEffect, SettledRunSchema, terminalEffect, turnAuthorship, turnLane, type TurnAuthorship,
  actorPolicy, metadataTier, workModeForTurnMetadata, reportReadsNarration, subordinateTerminalEffects, withCompactionTrigger, type ActorPolicy,
  bindRoute, completeOnRoute, ownProfileChoices, planWorkspaceTitle, resolveAgentTurnProfile, resolveModelRoute, routedLlm, suggestWorkspaceTitle,
  type ActorTurnLease, type BroadcastEvent, type ChatTurnInput, type TurnOpening, type JsonObject, type PlanReview, type ComposedRequest, type HostedActor, type OwedEffect, type OwedTerminalEffectsInput,
  type InspectedWork, type PreparedAgentTurn, type PreparedTurn, type TerminalTurnFacts, type TerminalTurnParts,
  type SessionEvent, type TurnAssemblyRequest, type WorkMode, type OwnerQuestionStore, type RunEndOutcome, type DeliveredRun, type AgentOwes, type AgentReport, type ClaimedRound,
  refusedRun, turnAttemptOf,
} from '@kinu.run/core';
import { createCompactionStateStore, type CompactionStateStore } from '@kinu.run/compaction';
import { attempt, diagnostics, hold, logged, settle, toKinuError, type KinuError } from '@kinu.run/core/obs';
import { Cause, Effect, Exit } from 'effect';
import { serialQueue } from '@kinu.run/agent-utils';
import type { AgentDatabase } from './agent-database';
import type { StepPacer } from './step-pacer';
import { FacetSpend, answerMetadataOf, deliveredRun, facetTurnSources, facetTurnTools, type AgentWorkspace, type FacetModels, type LiveTurn } from './agent-turn';

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

/** Who wrote a turn: the owner's words and decisions are the owner's, every other programmatic turn its hirer's. */
function authorshipOf(item: ChatTurnInput): TurnAuthorship {
  return turnAuthorship(item);
}

export class FacetChat {
  readonly session: ChatSession;

  private readonly trigger: { readonly state: CompactionStateStore; readonly key: string };

  private readonly spend: FacetSpend;

  /** What this agent is, from its row: its hierarchy and placement decide what its turns owe. */
  private get policy(): ActorPolicy {
    return actorPolicy(this.deps.actor.record);
  }

  /** Whether an advisor reviews the turn running. */
  private reviewsTurns = false;

  /** Whether the turn running answers the agent's hirer (a delegated task), not its owner. */
  private parentDriven = false;

  /** The turn's author-stamped metadata, which its tool calls carry: a plan it submits is judged by it. */
  private driving: JsonObject | undefined;

  /** Each plan update in the order its transition happened, delivered as soon as it happened; a refused one fails the
   *  action that announced it alone, and the next still goes. */
  private readonly planDelivery = serialQueue();

  /** The deliveries of the updates each plan action announced, by the action whose call they ran in: an action may wait
   *  on a turn that runs another (a decision on the plan its feedback turn revises). */
  private readonly announcing = new AsyncLocalStorage<Promise<void>[]>();

  /** The last update no plan action owned, delivered or reported. */
  private unowned: Promise<unknown> = Promise.resolve();

  /** Its own plan reviews, in its own store: the owner reviews them through its window (D9). */
  readonly plans: PlanReviewActions;

  /** Its own questions to its owner, in its own store: the workspace's stack lists and answers them (D9). */
  get questions(): OwnerQuestionStore {
    return this.deps.actor.session.questions;
  }

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
      holds: deps.database.held,
      eventLog: new EventLog(deps.database.exec, actor.handle),
      eventRecorder: actor.stores.eventRecorder,
      compactionState: this.trigger.state,
      transaction: (body) => storage.transactionSync(body),
      transport: {
        deliver: (event) => {
          // Its last charge lands before its end is told: nothing the workspace reads of the turn can miss it.
          if (event.type === 'turn-end') {
            return this.charged().then(async () => {
              // Its room is sent the transcript's newest messages with its end: they are this isolate's to read.
              const window = await deps.database.history(TRANSCRIPT_WINDOW);

              await workspace.turnEnded(event, deps.database.figures(), deps.database.takeActivity(), window);
            });
          }

          return ROOM_EVENTS.has(event.type) ? workspace.chatEvent(event) : undefined;
        },
      },
      mintAnswerId: () => crypto.randomUUID(),
      ports: {
        prepareTurn: (item, lease, opening, round) => this.prepareTurn(item, lease, opening, round),
        composeRequest: () => this.composeRequest(),
        owedTerminalEffects: (input) => this.owedTerminalEffects(input),
        answerMetadata: async (lease, texts) => await answerMetadataOf(workspace, { turnId: lease.turnId, runId: lease.runId, epoch: actor.session.closeEpoch(lease) }, texts),
        // What the turn already told its hirer is the agent's own record, so a reset of the workspace cannot repeat it.
        // An agent with no hirer owes no report, so it asks the workspace for none.
        owedReport: async (ending, assistantText, narration) => (this.policy.hirer === null ? null : await workspace.owedReport(
          {
            reports: this.deps.database.reports(this.session.currentTurnId ?? ''), ownerDriven: !this.parentDriven,
            taskId: this.parentDriven ? announcementOf(this.session.currentTurnId ?? '') : null,
          },
          { ending, assistantText, narration: reportReadsNarration(ending) ? await narration() : [] },
        )),
        // Its hirer waits on the work, not on a turn: one that ended without an answer is answered to it as blocked, keyed by
        // the work.
        unanswered: async (item, failure) => {
          if (turnLane(this.policy, authorshipOf(item)) !== 'hirer' || item.idempotencyKey === undefined) return;
          await workspace.parentReport({
            text: `${this.deps.actor.record.name} failed to run its assigned turn: ${failure.message}`,
            status: 'blocked', mode: workModeForTurnMetadata(item.metadata), sequenceId: item.idempotencyKey,
          });
        },
        terminal: () => this.terminal,
        driverGate: () => null,
        armTurnWake: (atMs) => this.tell(atMs),
        quiet: () => { this.atRest(); },
        // Its tasks tool and its jobs run in the workspace.
        openWork: () => workspace.openWork(),
        // The lane that keeps its prompt cache warm is the workspace's, which holds the provider keys and the wake.
        cacheWarming: {
          noteRequest: (lastRequestAt) => workspace.noteModelRequest(lastRequestAt),
          armAfterTurn: (input) => workspace.armCacheWarm(input),
        },
        steerSkills: (text) => workspace.steerSkills(text, this.activeSkills),
        stillOwed: (metadata) => planHandoffStillOwed(metadata, actor.stores.planReviews),
        birthContext: (drainTurnId) => workspace.birthContext(drainTurnId),
        // The owner's decision as its intent delivers it: its plans are this store's, and an approval hands off its turn.
        decidePlan: (verdict) => this.planned((plans) => plans.decideAndHandOff(verdict, (turn) => this.session.enqueueTurn(turn))),
        // A run its workspace delivered: a typed input of this chat (D2), its end owed its workspace's caller.
        runs: {
          run: (run, signal, recordEnd) => this.runDelivered(run, signal, recordEnd),
          tell: () => { this.resting = hold(logged('agent.run_end_report_failed', { doing: "telling the workspace a delivered run's end", otherwise: 'unavailable' }, () => this.tell())); },
        },
      },
    });
  }

  /** A delivered run, run to its end in this chat's turn: its end, kept on its held input in the commit that answers it,
   *  is told as it ends, not at rest, since its caller awaits it and runs may wait behind it. Never fails: a run that
   *  failed before it kept its end keeps its refusal. */
  async runDelivered(run: DeliveredRun, signal: AbortSignal, recordEnd: (outcome: RunEndOutcome) => void): Promise<void> {
    const { deps } = this;

    return await settle(Effect.gen({ self: this }, function* () {
      const exit = yield* Effect.exit(attempt({ doing: "running a delivered task in its agent's isolate", otherwise: 'io' }, () => deliveredRun({
        database: deps.database, workspace: deps.workspace, models: deps.models, pacer: deps.pacer,
      }, run.task, signal, recordEnd)));

      if (Exit.isFailure(exit)) recordEnd(refusedRun(toKinuError({ doing: 'running a delivered task', cause: Cause.squash(exit.cause), otherwise: 'io' })));
      yield* Effect.promise(() => hold(logged('agent.run_end_report_failed', { doing: "telling the workspace a delivered run's end", otherwise: 'unavailable' }, () => this.tell())));
    }));
  }

  private async assemble(prepared: PreparedAgentTurn, turn: { readonly id: string; readonly mode: WorkMode; readonly runId: string; readonly epoch: number | null }, asked: TurnAssemblyRequest, bind?: Parameters<typeof assembleActorTurn>[0]['settle']) {
    const { actor, database, workspace, models, pacer } = this.deps;
    const live: LiveTurn = { dynamic: prepared.dynamic };

    const tools = facetTurnTools(workspace, prepared, actor, {
      id: turn.id, runId: turn.runId, epoch: turn.epoch, mode: turn.mode, parentDriven: this.parentDriven, driving: this.driving, live, database,
      // Its plans are its own store's, judged by the metadata its turn was admitted under.
      owner: {
        submitPlan: { submit: async (edits) => await this.planned((plans) => plans.submit(edits, this.driving)) },
        replyToComment: { reply: async (comment, text) => await this.planned((plans) => plans.reply(comment, text, this.driving)) },
      },
    });

    const { sources: bundle } = facetTurnSources({ actor, workspace, models, prepared, spend: this.spend, live, runId: turn.runId, turnId: turn.id, epoch: turn.epoch, pacer });

    // A chat turn under a mission of its workspace's spends there, as each model call is guarded and charged.
    const { missionLabels } = prepared;

    const mission = missionLabels === undefined ? null : this.missionCharges = missionGate({
      labels: missionLabels,
      port: {
        guard: async (seam, labels) => await workspace.guard({ turnId: turn.id, runId: turn.runId, epoch: turn.epoch }, seam, labels),
        debit: async (tokens, opts) => { await workspace.debit({ turnId: turn.id, runId: turn.runId, epoch: turn.epoch }, tokens, opts); },
      },
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

  private async prepareTurn(item: ChatTurnInput, lease: ActorTurnLease, opening: TurnOpening, round: ClaimedRound): Promise<PreparedTurn> {
    const { actor, database, workspace } = this.deps;
    const plans = actor.stores.planReviews;
    // Read once, by whichever of the review's mode and the reply's lane asks first.
    let active: PlanReview | null | undefined;
    const activePlan = (): PlanReview | null => (active === undefined ? (active = plans.getActive(CHAT_SESSION_ID)) : active);
    // The one place a turn's lane is decided; the workspace rebuilds a turn from this, never from its id.
    // A hirer's turn runs in the hirer's lane, with `report`, only for an agent that has a hirer.
    this.parentDriven = turnLane(this.policy, authorshipOf(item)) === 'hirer';
    this.driving = authoredTurnMetadata(item);
    // The owner's words while a plan awaits their decision are read as its review.
    const mode = workModeUnderReview(actor.session.workMode, this.driving, activePlan);
    // The workspace reads the turn's sources for the tier it runs on, and the turn is assembled on that same tier.
    const explicitTier = metadataTier(item.metadata);
    const taskPlan = approvedTaskPlan(item, plans);

    // The turn's capability (design v2 §3): the epoch its claim was minted with, which the workspace's fence holds while
    // it is this agent's current execution. Every call that runs more of the turn carries it.
    const bound = { turnId: lease.turnId, runId: lease.runId, epoch: round.capability.epoch };

    const prepared = await workspace.prepareChat({
      turnId: lease.turnId, mode, userText: item.text, parentDriven: this.parentDriven, driving: this.driving, opening,
      // A plan the owner sent back with comments awaits its answers on the owner's turns alone.
      awaitsReply: !this.parentDriven && planAwaitingReply(activePlan(), this.driving),
      // Its run, which the turn's recovery continues and its Retry starts anew; a recovered run's surface is built on what
      // it froze as it bound.
      runId: lease.runId, seq: bound.epoch, ...(round.frozen !== null && { frozen: round.frozen }),
      ...(explicitTier !== undefined && { explicitTier }), ...(taskPlan !== null && { taskPlan }),
    });

    database.prepare(bound, prepared);
    this.reviewsTurns = prepared.reviewsTurns;
    // A recovered execution assembles on what it froze as it first bound, and resolves nothing (D5).
    const { frozen } = round;

    const asked: TurnAssemblyRequest = {
      userText: item.text, workMode: mode, ...(explicitTier !== undefined && { explicitTier }), ...(frozen !== null && { frozen }),
    };

    const assembled = await this.assemble(prepared, { id: lease.turnId, mode, runId: lease.runId, epoch: bound.epoch }, asked, round.bind);

    this.activeSkills = assembled.activeSkills?.active.map((skill) => skill.name) ?? [];
    const historyLength = actor.session.history.length;
    const { key, state } = this.trigger;

    return {
      execution: withCompactionTrigger(assembled.execution, state, key, historyLength),
      sessionKey: key, contextWindow: assembled.window.contextWindow, historyLength, trial: prepared.trial ?? null,
    };
  }

  /** The update's delivery, owned by the plan action it ran in. One no action owns has no caller to answer: its refusal
   *  is reported, and the chat is idle once it settled. */
  private announcePlan(event: BroadcastEvent): void {
    const delivered = this.planDelivery(async () => { await this.deps.workspace.chatEvent({ type: 'broadcast', event }); });
    const own = this.announcing.getStore();

    if (own !== undefined) own.push(delivered);
    else this.unowned = hold(logged('plan.delivery_failed', { doing: "announcing a plan update in the agent's window", otherwise: 'unavailable' }, () => delivered));
  }

  /** A plan action, answered once each update it announced has reached the agent's window; an update refused there is
   *  its failure, and the next action's updates are announced all the same. */
  async planned<A>(act: (plans: PlanReviewActions) => A | Promise<A>): Promise<A> {
    const own: Promise<void>[] = [];
    const result = await this.announcing.run(own, async () => await act(this.plans));

    await Promise.all(own);

    return result;
  }

  private async composeRequest(): Promise<ComposedRequest> {
    const mode = this.deps.actor.session.workMode;
    const prepared = await this.deps.workspace.prepareChat({ turnId: null, mode, userText: '', parentDriven: false, awaitsReply: false });
    const assembled = await this.assemble(prepared, { id: 'measure', mode, runId: prepared.runId, epoch: null }, { userText: '', workMode: mode });

    return { execution: assembled.execution, profile: assembled.profile, sessionKey: this.trigger.key };
  }

  /** As a CLI hire's: never sleep-time. The workspace's own agent owes its chat's follow-ups here and hands the rest of
   *  its settled turn to the workspace, whose evolution, event log and titles its lanes are. */
  private owedTerminalEffects(input: OwedTerminalEffectsInput): OwedEffect[] {
    const { session } = this.deps.actor;

    const turnId = this.session.currentTurnId ?? '';
    const runId = this.session.currentRunId ?? turnId;
    const opened = this.deps.database.factsOf({ turnId, runId });
    // The claim the turn ran under, which its settle names as its close (design v2 §3).
    const epoch = session.turnClaim?.epoch ?? null;

    if (this.policy.workspaceAgent) {
      return declareHandoffRoster(chatTurnParts(input), {
        turnId, runId, epoch, messageId: input.messageId, status: input.status, completed: input.completed,
        workMode: session.workMode, userText: input.userText, assistantText: input.assistantText, event: input.event ?? null,
        turn: projectJsonValue({ value: input.turn }), credited: input.credited, answeredDeliveries: [...input.answeredDeliveries],
        reachableTools: [...input.reachableTools], recordedAt: Date.now(), facts: opened,
      });
    }

    // A replay already carries the scope its first attempt recorded.
    const scoped = input.turn.missionLabels !== undefined || opened.missionLabels.length === 0 ? input.turn : { ...input.turn, missionLabels: [...opened.missionLabels] };

    const facts: TerminalTurnFacts = {
      messageId: input.messageId,
      status: input.status,
      workMode: session.workMode,
      continuity: opened.continuity,
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
      ...(this.reviewsTurns && { advisor: projectJsonValue({ value: session.advisor.snapshot(scoped, input.reachableTools) }) }),
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

    // Its tools' receipts were kept in the workspace, which drops them once the run settled.
    return [...declareTerminalRoster(facts, parts), runSettleEffect(input.messageId, { turnId, runId, epoch })];
  }

  private get terminal(): TerminalTransitions {
    const { actor, storage, workspace } = this.deps;

    this.terminalTransitions ??= new TerminalTransitions({
      sql: actor.runtime.storage.sql,
      holds: this.deps.database.held,
      actor: actor.handle,
      effects: {
        ...chatTerminalEffects({ chat: () => this.session, orchestrator: () => actor.session.orchestrator, engine: { learnFromTurn: async () => {} } }),
        ...subordinateTerminalEffects({
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
        run_settle: terminalEffect({
          input: SettledRunSchema,
          run: async (run) => {
            await workspace.runSettled(run);

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
    await this.unowned;
    await this.spend.settled();
  }

  /** Every wake re-arms what is still owed, so an effect still closing when it fires keeps a wake after it; the pump
   *  it ends on tells the workspace what is left once it rests. */
  wake(): Promise<void> {
    return settle(attempt({ doing: "resuming what an agent's isolate owed", otherwise: 'unavailable' }, async () => {
      this.session.reclaimStrandedEventDeliveries();
      await this.terminal.replayOwedAndRearm();
      await this.session.flushPendingDrains();
      // An answer the isolate took and died before running: its turn is re-derived from the store.
      this.session.resumeAnswered();
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

  /**
   * Its input taken: what it owes now, numbered behind every report it sent before, for its admission's answer to carry
   * (taken rides admit). An older rest cannot cancel the workspace's arm for the input, and a turn the input ran and
   * ended already leaves no arm behind. Its run ends ride the next report it tells, which retires them once it reached.
   */
  taken(): Promise<AgentOwes> {
    const reported = this.telling.then(() => this.owesNow(undefined, []));

    this.telling = hold(attempt({ doing: 'reporting what an agent owes for its input', otherwise: 'unavailable' }, () => reported));

    return reported;
  }

  /** Numbered as it leaves, in this agent's store: the workspace takes no report older than one it took. */
  private owesNow(at: number | undefined, runEnds: AgentReport['runEnds']): AgentOwes {
    const owed = this.owed();

    return {
      seq: this.deps.database.nextInSequence(), next: at === undefined ? owed : Math.min(at, owed ?? Infinity),
      holds: owed !== null || this.owedWork().length > 0 || runEnds.length > 0,
      report: { standing: this.deps.database.standingReport(), runEnds, working: this.session.turnOwed },
    };
  }

  /** `at` asks for a wake no later than it. Carries every run end kept and not yet told, each retired once the report
   *  reached. */
  private tell(at?: number): Promise<void> {
    const told = this.telling.then(async () => {
      const ends = this.session.runEndsOwed();
      const { seq, next, holds, report } = this.owesNow(at, ends);

      await this.deps.workspace.owes(seq, next, holds, report);
      this.session.runEndsTold(ends);
    });

    this.telling = hold(attempt({ doing: 'telling the workspace what an agent still owes', otherwise: 'unavailable' }, () => told));

    return told;
  }

  /** What it owes, told: a delivery its own isolate admitted has no answer to carry it. A failure is logged, as the rest's. */
  async told(): Promise<null> {
    await hold(logged('agent.owed_report_failed', { doing: 'telling the workspace what an agent owes for its input', otherwise: 'unavailable' }, () => this.tell()));

    return null;
  }

  /** Its own turns and effects still owed, folded as the workspace's read folds the root's. */
  owedWork(): InspectedWork[] {
    const { actor } = this.deps;
    const { ledger } = this.terminal;
    const name = actor.record.name;
    const running = actor.session.turnClaim?.turnId;

    return inspectWork({
      claims: actor.stores.claims.unsettled().map((claim) => ({ claim, actor: name, attempt: turnAttemptOf(actor.runtime.storage.sql, claim) })),
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
    const prepared = await workspace.prepareChat({ turnId: null, mode: workMode, userText: '', parentDriven: false, awaitsReply: false });
    const { sources } = facetTurnSources({ actor, workspace, models, prepared, spend: this.spend, live: { dynamic: prepared.dynamic }, runId: prepared.runId, turnId: 'title', epoch: null, pacer });
    const inputs = await sources.profileInputs();
    const profile = resolveAgentTurnProfile({ ...inputs, ...ownProfileChoices(sources.config, inputs, sources.ancestors?.()), workMode, availableTools: [], activeSkills: [] });
    const route = resolveModelRoute('fast', profile);
    const { routed } = sources.models;

    return await suggestWorkspaceTitle((system, prompt) => completeOnRoute(route, {
      llm: (resolution) => routedLlm((serving) => bindRoute(sources.models, serving), resolution, { report: this.spend.report, operations: this.spend.operations }, system),
      ...(routed !== undefined && { attemptOf: (spec: string) => routed.attemptFor(spec) }),
    }, prompt), mission);
  }

  /** The workspace's model settings changed: the next request is measured on them, and a refusal they fix may answer. */
  async modelSettingsChanged(): Promise<void> {
    this.session.reviseContext({ counted: true });
    await this.terminal.modelSettingsChanged();
  }

  /** The forced rebuild the next turn assembly takes, under the key it reads. */
  armCompaction(): void {
    this.trigger.state.armCompaction(this.trigger.key);
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
    const busy = this.session.turnOwed || this.terminal.closing || this.terminal.hasIncomplete() || this.questions.owedResumes().length > 0;

    // The workspace keeps one wake per agent, the latest it was told: a turn waiting out its backoff names its end.
    const next = Math.min(
      this.terminal.nextRetryAt() ?? Infinity, this.session.reaskDeferredTo() ?? Infinity, busy ? Date.now() + RECOVERY_BACKOFF_CEILING_MS : Infinity,
    );

    return Number.isFinite(next) ? next : null;
  }
}
