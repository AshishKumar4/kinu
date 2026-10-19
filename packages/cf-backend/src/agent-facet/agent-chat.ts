/** An agent's chat in its own isolate (D9), the workspace agent's included. */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CHAT_SESSION_ID, ChatSession, EventLog, PendingSendStore, RECOVERY_BACKOFF_CEILING_MS, TerminalTransitions,
  PlanReviewActions, assembleActorTurn, authoredTurnMetadata, chatTerminalEffects, chatTurnParts, declareTerminalRoster, inspectWork,
  planHandoffStillOwed, planAwaitingReply, approvedTaskPlan, missionGate, workModeUnderReview, projectJsonValue, declareHandoffRoster, HandedOffTurnSchema, runSettleEffect, SettledRunSchema, terminalEffect, turnTags, turnLane, answerDrawsPages,
  actorPolicy, actorTerminalEffects, withCompactionTrigger, type ActorPolicy,
  bindRoute, completeOnRoute, ownProfileChoices, resolveTurnProfile, resolveModelRoute, routedLlm, suggestWorkspaceTitle,
  type ActorTurnLease, type BroadcastEvent, type ChatTurnInput, type TurnOpeningAsk, type JsonObject, type PlanReview, type ComposedRequest, type HostedActor, type OwedEffect, type OwedTerminalEffectsInput,
  type InspectedWork, type PreparedAgentTurn, type PreparedTurn, type TerminalActor, type TerminalTurnFacts,
  type SessionEvent, type TurnAssemblyRequest, type WorkMode, type OwnerQuestionStore, type RunEndOutcome, type DeliveredRun, type AgentOwes, type AgentReport, type ClaimedRound,
  refusedRun, turnAttemptOf, endedStandingOf, WORKSPACE_RUN_ID,
} from '@kinu.run/core';
import { createCompactionStateStore, type CompactionStateStore } from '@kinu.run/compaction';
import { attempt, diagnostics, hold, logged, settle, toKinuError, type KinuError } from '@kinu.run/core/obs';
import { Cause, Effect, Exit } from 'effect';
import * as v from 'valibot';
import { serialQueue } from '@kinu.run/agent-utils';
import type { AgentDatabase } from './agent-database';
import type { StepPacer } from './step-pacer';
import type { WorkspaceClient } from './workspace-rpc';
import { FacetSpend, answerMetadataOf, deliveredRun, facetTurnSources, facetTurnTools, modelOperations, type FacetModels, type LiveTurn, type TurnBound } from './agent-turn';

/** The words reach the room on the turn's own stream, and a turn's end on its own call. */
const ROOM_EVENTS: ReadonlySet<SessionEvent['type']> = new Set(['turn-start', 'step-cut', 'error', 'broadcast', 'history-reverted']);

export interface FacetChatDeps {
  readonly actor: HostedActor;
  readonly database: AgentDatabase;
  readonly workspace: WorkspaceClient;
  readonly models: FacetModels;
  readonly storage: DurableObjectStorage;
  readonly pacer: StepPacer;
}

/** The answer whose slates are owed, and the execution that answered it: its take is a close of that execution. */
const AnswerSlatesSchema = v.object({ turnId: v.string(), runId: v.string(), epoch: v.nullable(v.number()), messageId: v.string() });

type AnswerSlates = v.InferOutput<typeof AnswerSlatesSchema>;

/** Owed by a turn that committed an answer: the workspace saw its slates change, and they are stamped on that answer. */
function answerSlatesEffect(close: TurnBound, messageId: string): OwedEffect[] {
  return messageId === '' ? [] : [{ name: 'answer_slates', scope: messageId, lane: 'detached', input: { ...close, messageId } }];
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

  /** The chat turn this isolate assembled last, and what its preparation and tools told it: written as a turn is
   *  assembled, read by its task reminder ({@link ChatSessionPorts.openWork}) only while that turn is the current one. */
  private liveTurn: { readonly turnId: string; readonly live: LiveTurn } | null = null;

  /** The wake the workspace holds for this agent as this isolate's newest report named it (`next`; null for none):
   *  written as each report leaves, a told one once the workspace took it; read by an arm it may already cover (`tell`). */
  private namedWake: number | null = null;

  /** Its standing moved since the newest report it sent, an arm having asked nothing new (`tell`): set there, dropped as
   *  any report leaves; the next crossing that can carry one does, a turn's preparation first (`prepareTurn`). */
  private standingUntold = false;

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
            // Its steps' grant answers: the turn ran its last.
            deps.pacer.release(event.turnId);

            return this.charged().then(async () => {
              // Its room is sent the transcript's newest messages with its end: they are this isolate's to read.
              const window = await deps.database.seed();

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
        // A failure answer has no narration: only the slates it showed are stamped on it.
        failedAnswerSlates: async (lease) => await answerMetadataOf(workspace, { turnId: lease.turnId, runId: lease.runId, epoch: actor.session.closeEpoch(lease) }, async () => []),
        terminal: () => this.terminal,
        driverGate: () => null,
        armTurnWake: (atMs) => this.tell(atMs),
        // It works from its queue's first turn until it is at rest: its port into its workspace is held only between.
        owed: () => { workspace.work(); },
        quiet: () => { this.atRest(); },
        // Its tasks tool and its jobs run in the workspace.
        // What the turn's preparation and its tools last answered: a turn that never prepared asks.
        openWork: async () => {
          const live = this.liveTurn;

          return live !== null && live.turnId === this.session.currentTurnId && live.live.openWork !== null ? live.live.openWork : await workspace.openWork();
        },
        // The lane that keeps its prompt cache warm is the workspace's, which holds the provider keys and the wake.
        cacheWarming: {
          armAfterTurn: (input) => workspace.armCacheWarm(input),
        },
        steerSkills: (text) => workspace.steerSkills(text, this.activeSkills),
        // Its tools run in the workspace, which holds their foreground calls.
        releaseForeground: (executing) => workspace.releaseForeground(executing),
        stillOwed: (metadata) => planHandoffStillOwed(metadata, actor.stores.planReviews),
        birthContext: (drainTurnId) => workspace.birthContext(drainTurnId),
        // The owner's decision as its intent delivers it: its plans are this store's, and an approval hands off its turn.
        decidePlan: (verdict) => this.planned((plans) => plans.decideAndHandOff(verdict, (turn) => this.session.enqueueTurn(turn))),
        // A run its workspace delivered: a typed input of this chat (D2), its end owed its workspace's caller.
        runs: {
          run: (run, signal, recordEnd) => this.runDelivered(run, signal, recordEnd),
          // Beside any rest it tells: its idle waits on both.
          tell: () => {
            this.resting = Promise.all([this.resting, hold(logged('agent.run_end_report_failed', { doing: "telling the workspace a delivered run's end", otherwise: 'unavailable' }, () => this.tell()))]);
          },
        },
      },
    });
  }

  /** A delivered run, run to its end in this chat's turn: its end, kept on its held input in the commit that answers it,
   *  is told as it ends, not at rest, since its caller awaits it and runs may wait behind it. Never fails: a run that
   *  failed before it kept its end keeps its refusal. */
  async runDelivered(run: DeliveredRun, signal: AbortSignal, recordEnd: (outcome: RunEndOutcome) => Promise<() => void>): Promise<void> {
    const { deps } = this;

    return await settle(Effect.gen({ self: this }, function* () {
      const exit = yield* Effect.exit(attempt({ doing: "running a delivered task in its agent's isolate", otherwise: 'io' }, () => deliveredRun({
        database: deps.database, workspace: deps.workspace, models: deps.models, pacer: deps.pacer,
      }, run.task, signal, recordEnd)));

      if (Exit.isFailure(exit)) {
        const refusal = refusedRun(toKinuError({ doing: 'running a delivered task', cause: Cause.squash(exit.cause), otherwise: 'io' }));

        (yield* Effect.promise(() => recordEnd(refusal)))();
      }

      yield* Effect.promise(() => hold(logged('agent.run_end_report_failed', { doing: "telling the workspace a delivered run's end", otherwise: 'unavailable' }, () => this.tell())));
    }));
  }

  private async assemble(prepared: PreparedAgentTurn, turn: { readonly id: string; readonly mode: WorkMode; readonly runId: string; readonly epoch: number | null }, asked: TurnAssemblyRequest, bind?: Parameters<typeof assembleActorTurn>[0]['settle']) {
    const { actor, database, workspace, models, pacer } = this.deps;
    const live: LiveTurn = { dynamic: prepared.dynamic, openWork: prepared.openWork ?? null };

    this.liveTurn = { turnId: turn.id, live };

    const tools = facetTurnTools(workspace, prepared, actor, {
      id: turn.id, runId: turn.runId, epoch: turn.epoch, mode: turn.mode, parentDriven: this.parentDriven, driving: this.driving, live, database,
      craft: actor.session.orchestrator.acc.ledgers.craft,
      // Its plans are its own store's, judged by the metadata its turn was admitted under.
      owner: {
        submitPlan: { submit: async (edits) => await this.planned((plans) => plans.submit(edits, this.driving)) },
        replyToComment: { reply: async (comment, text) => await this.planned((plans) => plans.reply(comment, text, this.driving)) },
      },
    });

    const { sources: bundle } = facetTurnSources({ actor, workspace, models, prepared, spend: this.spend, live, runId: turn.runId, turnId: turn.id, epoch: turn.epoch, pacer, recordsIn: turn.runId });

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
      // Its tools are the workspace's, run there, and so is its scaffold's program.
      toolset: () => ({ tools, stores: null }),
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

  private async prepareTurn(item: ChatTurnInput, lease: ActorTurnLease, opening: TurnOpeningAsk, round: ClaimedRound): Promise<PreparedTurn> {
    const { actor, database, workspace } = this.deps;
    const plans = actor.stores.planReviews;
    // Read once, by whichever of the review's mode and the reply's lane asks first.
    let active: PlanReview | null | undefined;
    const activePlan = (): PlanReview | null => (active === undefined ? (active = plans.getActive(CHAT_SESSION_ID)) : active);
    // The one place a turn's lane is decided; the workspace rebuilds a turn from this, never from its id.
    // A hirer's turn runs in the hirer's lane, with `report`, only for an agent that has a hirer.
    const tags = turnTags(item);

    this.parentDriven = turnLane(this.policy, tags.authorship) === 'hirer';
    this.driving = authoredTurnMetadata(item);
    // The owner's words while a plan awaits their decision are read as its review.
    const mode = workModeUnderReview(actor.session.workMode, this.driving, activePlan);
    // The workspace reads the turn's sources for the tier it runs on, and the turn is assembled on that same tier.
    const explicitTier = tags.tier;
    const taskPlan = approvedTaskPlan(item, plans);

    // The turn's capability (design v2 §3): the epoch its claim was minted with, which the workspace's fence holds while
    // it is this agent's current execution. Every call that runs more of the turn carries it.
    const bound = { turnId: lease.turnId, runId: lease.runId, epoch: round.capability.epoch };

    // What the turn's opening moved of its standing, which its arm did not tell, rides its preparation.
    const owes = this.standingUntold ? this.owesNow(undefined, []) : null;

    this.standingUntold = false;

    const prepared = await workspace.prepareChat({
      turnId: lease.turnId, mode, userText: item.text, parentDriven: this.parentDriven, driving: this.driving, opening,
      ...(owes !== null && { owes }),
      // A plan the owner sent back with comments awaits its answers on the owner's turns alone.
      awaitsReply: !this.parentDriven && planAwaitingReply(activePlan(), this.driving),
      // Its run, which the turn's recovery continues and its Retry starts anew; a recovered run's surface is built on what
      // it froze as it bound.
      runId: lease.runId, seq: bound.epoch, ...(round.frozen !== null && { frozen: round.frozen }),
      ...(explicitTier !== undefined && { explicitTier }), ...(taskPlan !== null && { taskPlan }),
    });

    if (owes !== null) this.namedWake = owes.next;
    database.prepare(bound, prepared);
    this.reviewsTurns = prepared.reviewsTurns;
    // A recovered execution assembles on what it froze as it first bound, and resolves nothing (D5).
    const { frozen } = round;

    const asked: TurnAssemblyRequest = {
      userText: item.text, workMode: mode, ...(explicitTier !== undefined && { explicitTier }), ...(frozen !== null && { frozen }),
      // Its hirer reads a turn it drives; a person reads the rest, in this chat or a terminal.
      pagesInAnswer: !this.parentDriven && answerDrawsPages(this.driving),
    };

    const assembled = await this.assemble(prepared, { id: lease.turnId, mode, runId: lease.runId, epoch: bound.epoch }, asked, round.bind);

    this.activeSkills = assembled.activeSkills?.active.map((skill) => skill.name) ?? [];
    const historyLength = actor.session.history.length;
    const { key, state } = this.trigger;

    return {
      execution: withCompactionTrigger(assembled.execution, state, key, historyLength),
      sessionKey: key, contextWindow: assembled.window.contextWindow, historyLength,
      cacheKeptAliveUntil: prepared.cacheKeptAliveUntil,
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

    // Its slates are taken once its answer committed, by a row of the roster committed with it (#75).
    const slates = answerSlatesEffect({ turnId, runId, epoch }, input.messageId);

    if (this.policy.workspaceAgent) {
      return [...slates, ...declareHandoffRoster(chatTurnParts(input), {
        turnId, runId, epoch, messageId: input.messageId, status: input.status, completed: input.completed,
        workMode: session.workMode, userText: input.userText, assistantText: input.assistantText, event: input.event ?? null,
        turn: projectJsonValue({ value: input.turn }), credited: input.credited, answeredDeliveries: [...input.answeredDeliveries],
        reachableTools: [...input.reachableTools], recordedAt: Date.now(), facts: opened,
      })];
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

    // Whether it reviews turns is the workspace's to say, which holds the port its advisor is hired through.
    const advisor: TerminalActor['advisor'] = { reviewsTurns: this.reviewsTurns, snapshot: (turn, reachable) => session.advisor.snapshot(turn, reachable) };

    // An assignment's turn is keyed by it, so a re-run after a reset answers it once.
    const turnReport = input.turnEnd === null ? {} : {
      turnReport: { ...input.turnEnd, sequenceId: input.turnEnd.taskId ?? `${this.deps.actor.record.actorId}:turn-end:${input.messageId}` },
    };

    // Its tools' receipts were kept in the workspace, which drops them once the run settled.
    return [
      ...slates,
      ...declareTerminalRoster(facts, { role: { kind: 'agent', opensConversation: input.opensConversation }, advisor, turn: scoped, reachableTools: input.reachableTools }, { ...chatTurnParts(input), ...turnReport }),
      runSettleEffect(input.messageId, { turnId, runId, epoch }),
    ];
  }

  private get terminal(): TerminalTransitions {
    const { actor, storage, workspace } = this.deps;

    this.terminalTransitions ??= new TerminalTransitions({
      sql: actor.runtime.storage.sql,
      holds: this.deps.database.held,
      actor: actor.handle,
      // Its identity is the workspace's, which refuses what an ended agent's effects ask with a refusal naming it: read off
      // that refusal's fields, with no call to ask (a settled turn's close crosses into the workspace a measured number of
      // times), and only where it names this agent.
      standing: async (failure) => endedStandingOf(failure, actor.handle.actorId) ?? 'live',
      effects: {
        ...chatTerminalEffects({ chat: () => this.session, orchestrator: () => actor.session.orchestrator, engine: { learnFromTurn: async () => {} } }),
        ...actorTerminalEffects({
          hireAdvisor: (advisor) => workspace.hireAdvisor(advisor),
          applyTitle: async (subject) => {
            await this.applyTitle(subject);

            return null;
          },
          // Decided where its hirer's roster is; what it told so far is its own, kept where the turn ran.
          report: (owed) => workspace.turnReport(
            { reports: this.deps.database.reports(owed.turnId), ownerDriven: owed.ownerDriven, taskId: owed.taskId },
            { ending: owed.ending, assistantText: owed.assistantText, narration: owed.narration },
            { sequenceId: owed.sequenceId, mode: owed.mode },
          ),
          sendReport: (report) => workspace.parentReport(report),
        }),
        answer_slates: terminalEffect({
          input: AnswerSlatesSchema,
          run: async (owed) => {
            await this.amendAnswerSlates(owed);

            return { status: 'completed' };
          },
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

  /** At rest, it tells its workspace what it owes, and then lets go of what it held open on it: an object an isolate
   *  holds a capability into cannot hibernate (#69). A turn that opened meanwhile is working, and keeps it. */
  private atRest(): void {
    if (this.session.pumping || this.terminal.closing) return;
    // No turn runs: no grant is held for one.
    this.deps.pacer.releaseAll();
    this.resting = hold(logged('agent.owed_report_failed', { doing: 'telling the workspace what an agent still owes', otherwise: 'unavailable' }, () => this.tell()))
      .then(() => {
        if (!this.session.pumping && !this.terminal.closing) this.deps.workspace.rest();
      });
  }

  /**
   * Its input taken: what it owes now, numbered behind every report it sent before, for its admission's answer to carry
   * (taken rides admit). An older rest cannot cancel the workspace's arm for the input, and a turn the input ran and
   * ended already leaves no arm behind. Its run ends ride the next report it tells, which retires them once it reached.
   */
  taken(): Promise<AgentOwes> {
    const reported = this.telling.then(() => {
      const owes = this.owesNow(undefined, []);

      this.namedWake = owes.next;
      this.standingUntold = false;

      return owes;
    });

    this.telling = hold(attempt({ doing: 'reporting what an agent owes for its input', otherwise: 'unavailable' }, () => reported));

    return reported;
  }

  /** Numbered as it leaves, in this agent's store: the workspace takes no report older than one it took. */
  private owesNow(at: number | undefined, runEnds: AgentReport['runEnds']): AgentOwes {
    const owed = this.owed();
    const standing = this.deps.database.standingReport();
    // A turn taken in and not yet opened is the run the owner sees as latest, as its opening will record it.
    const upcoming = this.session.nextRunWords();

    return {
      seq: this.deps.database.nextInSequence(), next: at === undefined ? owed : Math.min(at, owed ?? Infinity),
      holds: owed !== null || this.owedWork().length > 0 || runEnds.length > 0,
      report: {
        standing: upcoming === null ? standing : { ...standing, latestRun: { status: null, userMessage: upcoming, run: null } },
        runEnds, working: this.session.turnOwed,
      },
    };
  }

  /** `at` asks for a wake no later than it. Carries every run end kept and not yet told, each retired once the report
   *  reached. */
  private tell(at?: number): Promise<void> {
    const told = this.telling.then(async () => {
      const ends = await this.session.runEnds.owed();

      // An arm whose wake the workspace already holds, still to come and no later, asks nothing new: that wake comes first,
      // and the agent tells what it owes then. Its standing rides the next crossing that carries a report: the turn's
      // preparation, or the next tell. A run's end and a rest always go.
      if (at !== undefined && ends.length === 0 && this.namedWake !== null && Date.now() < this.namedWake && this.namedWake <= at) {
        this.standingUntold = true;

        return;
      }

      const { seq, next, holds, report } = this.owesNow(at, ends);

      this.standingUntold = false;
      await this.deps.workspace.owes(seq, next, holds, report);
      this.namedWake = next;
      this.session.runEnds.told(ends);
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

  /**
   * Its answer's slates, asked of the workspace that saw them change, stamped on the committed answer: its words promote
   * a slate it changed and did not show, so its narration is read only then. The workspace gives a replay the same, and
   * an answer rewound meanwhile is stamped with nothing. Its room is shown the answer again, unless a turn is live.
   */
  private async amendAnswerSlates({ messageId, ...close }: AnswerSlates): Promise<void> {
    const { actor, database, workspace } = this.deps;
    const transcript = actor.stores.history.transcript(CHAT_SESSION_ID);
    const answer = transcript.read(messageId);

    if (answer === null) return;
    const metadata = await answerMetadataOf(workspace, close, async () => await transcript.narration(answer.parts));

    if (metadata === null) return;
    await transcript.amendMetadata(messageId, metadata);
    await workspace.answerAmended(await database.seed());
  }

  /** The stand-in lands first, as every actor's does: the model's name may be refused. The workspace plans the title. */
  private async applyTitle(subject: string): Promise<void> {
    const { workspace } = this.deps;
    const mission = await workspace.autoTitle(subject, null);

    if (mission === null) return;
    await workspace.autoTitle(subject, await this.suggestTitle(mission));
  }

  /** Down the fast tier's chain on the agent's own models, as every actor's title is named. */
  private async suggestTitle(mission: string): Promise<string | null> {
    const { actor, workspace, models, pacer } = this.deps;
    const workMode = actor.session.workMode;
    const prepared = await workspace.prepareChat({ turnId: null, mode: workMode, userText: '', parentDriven: false, awaitsReply: false });

    // The title is no run of this agent's: its provider's words are the workspace's, as every actor's turnless call's are.
    const { sources } = facetTurnSources({
      actor, workspace, models, prepared, spend: this.spend, live: { dynamic: prepared.dynamic, openWork: null }, runId: prepared.runId, turnId: 'title', epoch: null, pacer,
      recordsIn: WORKSPACE_RUN_ID,
    });

    const inputs = await sources.profileInputs();
    const profile = resolveTurnProfile({ ...inputs, ...ownProfileChoices(sources.config, inputs, sources.ancestors?.()), workMode, availableTools: [], activeSkills: [] });
    const route = resolveModelRoute('fast', profile);
    const { routed } = sources.models;

    return await suggestWorkspaceTitle((system, prompt) => completeOnRoute(route, {
      llm: (resolution) => routedLlm((serving) => bindRoute(sources.models, serving), resolution, { report: this.spend.report, operations: modelOperations(actor, WORKSPACE_RUN_ID) }, system),
      ...(routed !== undefined && { attemptOf: (spec: string) => routed.attemptFor(spec) }),
    }, prompt), mission);
  }

  /** The workspace's model settings changed: the next request is measured on them, and a refusal they fix may answer. */
  async modelSettingsChanged(): Promise<void> {
    this.session.reviseContext({ counted: true });
    await this.terminal.ownerActed();
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
    const busy = this.session.turnRunnable || this.terminal.closing || this.terminal.hasIncomplete() || this.questions.owedResumes().length > 0;

    // The workspace keeps one wake per agent, the latest it was told: a turn waiting out its backoff names its end.
    const next = Math.min(
      this.terminal.nextRetryAt() ?? Infinity, this.session.reaskDeferredTo() ?? Infinity, busy ? Date.now() + RECOVERY_BACKOFF_CEILING_MS : Infinity,
    );

    return Number.isFinite(next) ? next : null;
  }
}
