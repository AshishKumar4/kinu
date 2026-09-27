/**
 * Every hosted non-root actor: hired subordinates and ask-by-role temporaries, and run actors (heads, swarm
 * nodes, steer and MCTS branches). Each is a `workspace_actors` row plus stores scoped over the root's one
 * `Storage`; a turn runs `runHeadInference` claimed on its actor's session (open-41), so a promotion landing
 * mid-run cannot take it over, and retirement is `host.retire`. `abort` is caller-requested only: no socket
 * close or eviction reaches it; an evicted run leaves an unsettled claim the root's activation resumes.
 * Not facets: `do.facet.cpu_shared` means hosted actors serialise as in one isolate.
 */

import { REAL_CLOCK, type HeadReport, type ObserveStream } from '@kinu.run/core';
import type { LanguageModel, Tool, ToolSet } from 'ai';
import {
  EventLog, HeadCapture, runHeadInference, titleActorFromMessage, buildHeadToolSet,
  admitSubordinateTask, describeSubordinateHandoff, readSubordinateLiveStatus,
  receiveSubordinateEvent, subordinateRelaysTurnEnd, temporaryRunSettles,
  subordinateForkContext, type SubordinateInheritedContext,
  inheritedAsModelMessage,
  classifyRunEnd, closeTurnRun, openTurnRun,
  collectDynamicContext, explorationActorKey, headStatusUnsettled, resolveModelRoute,
  storedHeadReportStatus, subordinateDelegatesOf,
  registeredParent, terminalTaskReport, defaultLoopOrigin, delegationBudgetOf, delegationExhausted, CHAT_SESSION_ID,
  type ActorHost, type ActorReference, type AssignedTurnFraming, type BoundActor,
  type BranchExploration, type BranchHandle, type BranchReflection, type CraftedTool,
  type DelegationBudget,
  type DynamicContext, type HeadId, type HeadInferenceDeps, type HeadInput, type HeadSplitRequest, type HeadSplitResult,
  type HeadStep, type HostedActor, type HostedNodeSeat, type LoopOrigin, type MissionScope, type NodeIdentity,
  type NodeWorkspace, type ProfileAuthorityInputs, type ReasoningEffort, type ReportHeadDelta, type ResolvedTurnProfile,
  type SpawnedHead, type SqlExec, type SqlExecutor, type SubordinateEventResult, type SubordinateHandoff,
  type SubordinateLifetime, type SubordinateReportOrigin,
  type SubordinateReportHandoff,
  type SubordinateReportStatus, type SubordinateRosterStore, type SubordinateRuntime,
  type SubordinateSeed, type TaskTurnEnding, type TemporaryAgentPort, type VFS, type WebSearchProvider,
  type WorkMode, type WorkspaceActor, type WorkspaceActorDirectory, type WriteObserver,
} from '@kinu.run/core';
import { attempt, diagnostics, KinuError, settle, settleSync } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import { isCFRuntime, type CFRuntime } from './runtime';
import { actorRetirementFor, type ActorRetirementRequest } from './actor-hosting';

/**
 * `spoke` (durable relay policy) and `settled` (temporary rung answered) are distinct: a `progress`
 * note speaks without settling, and conflating them suppressed the terminal report of an ask.
 */
export interface HostedReportLedger {
  spoke: boolean;
  settled: boolean;
}

/**
 * One delegated turn, decided once: claimed and tooled from the same `input`, under one
 * `model`/`profile` resolution (a second lookup can land a different digest than the claim).
 */
export interface HostedTaskTurn {
  /** The assignment row's id: keys this turn's claim and effects. */
  readonly turnId: string;
  readonly actor: HostedActor;
  readonly runtime: CFRuntime;
  readonly reports: HostedReportLedger;
  readonly input: HeadInput;
  readonly capture: HeadCapture;
  readonly model: LanguageModel;
  readonly profile: ExplorationProfile;
}

/** Tools and framing together: the prompt's tool index is rendered from the built surface. */
export interface HostedTaskProfile {
  readonly tools: ToolSet;
  readonly framing: AssignedTurnFraming;
}

/** One workspace's host and directory, for every hosted kind. */
export interface HostedActorSeams {
  readonly host: ActorHost;
  readonly sql: SqlExecutor;
  /** Positional executor for the same database; the event log needs this port, not the tagged one. */
  readonly exec: SqlExec;
  readonly directory: WorkspaceActorDirectory;
  transaction<Result>(body: () => Result): Result;
  /** Scoped to the actor, so a subordinate manages only its own subtree. */
  roster(actor: BoundActor): SubordinateRosterStore;
  vfs(): VFS;
  /** The same profile authority actor chat uses, so role restrictions narrow a hire identically. */
  profile(input: {
    readonly actor: HostedActor;
    readonly availableTools: readonly string[];
    readonly workMode: WorkMode;
  }): Promise<ExplorationProfile>;
  resolveModel(spec: string): LanguageModel;
  priceAs(actor: HostedActor, spec: string): Promise<void>;
  /** Register (or re-find) a run actor for this creation id. The root owns the directory. */
  register(input: ExplorationActorRequest): Promise<ActorReference>;
  /**
   * Watch writes the actor makes through its own file view until the disposer runs.
   * Named per run, before the first acquire builds the runtime, and dropped after so a
   * later run cannot inherit the capture (`WorkspaceHostSeams.chosenWriteObserver`).
   */
  watchWrites(reference: ActorReference, writes: WriteObserver): () => void;
  webSearch(): WebSearchProvider;
  /** The same provisioner the host uses, so the home a node is told about is the one it has. */
  nodeHome(actor: HostedActor): Promise<NodeWorkspace>;
  /** Typed as `Tool`: core widens `HeadToolDeps.codemodeTool` to `unknown`, this seam need not. */
  codemodeTool(runtime: CFRuntime, webSearch: WebSearchProvider): (finished: ToolSet) => Tool;
  /** The workspace journal, so a depth-2 head's spawn row and step rows join. */
  recordStep(headId: HeadId, seq: number, step: HeadStep): Promise<void>;
  readonly publishDelta: ReportHeadDelta;
  /** A head's mission, from its labels; a hire is never budgeted here. */
  mission(input: HeadInput): MissionScope | null;
  split(actor: HostedActor, runtime: CFRuntime, input: HeadInput): (request: HeadSplitRequest) => Promise<HeadSplitResult>;
  /** The root's own auto-title round-trip, asked on the hosted actor's behalf. */
  suggestTitle(mission: string): Promise<string | null>;
  taskProfile(turn: HostedTaskTurn): Promise<HostedTaskProfile>;
  dynamic(actor: HostedActor, profile: ResolvedTurnProfile, tools: ToolSet): DynamicContext;
  announce(actor: BoundActor): void;
  /** Drain on a reaction (a child's report). Never for an assignment: `wakesADrain` excludes it. */
  scheduleDrain(actor: HostedActor): void;
  /** Arm the wake chain that reaches `drainAdmittedDelegations`; the admitting request must not run it. */
  armWake(): void;
  /** Lives on the parent: `ask` parks a waiter and the report ingress resolves it. */
  temporary(actor: BoundActor): TemporaryAgentPort;
}

export function hostedDelegationBudget(
  seams: Pick<HostedActorSeams, 'host'>, actor: BoundActor,
): DelegationBudget {
  return delegationBudgetOf((actorId) => seams.host.describe(actorId), actor.record);
}

/**
 * One builder: recovery verifies the claim, so the runner and `taskTools` must share one `HeadInput`.
 * `maxDepth: 0` is containment (delegation is via `hire`/`ask`); a hire starts on the builtin loop.
 * No `DelegationBudget` parameter: `HeadInput.budget` is the split budget, a different limit.
 */
function delegatedHeadInput(
  record: WorkspaceActor,
  task: { readonly body: string; readonly mode: WorkMode; readonly inheritedContext?: SubordinateInheritedContext },
): HeadInput {
  return {
    id: record.name,
    rootId: record.name,
    parentId: record.parentActorId,
    depth: 0,
    task: task.body,
    mode: task.mode,
    rationale: task.body,
    inheritedContext: subordinateForkContext(task.inheritedContext),
    mergeStrategy: 'synthesize',
    budget: { maxDepth: 0, spawnedAt: Date.now() },
    loop: defaultLoopOrigin('subordinate'),
  };
}

function refusal(refused: boolean, error: () => KinuError): Effect.Effect<void, KinuError> {
  return refused ? Effect.fail(error()) : Effect.void;
}

/** `ActorHostDeps.runtimeFor` is `createCFRuntime` here, but core types it `AgentRuntime`. */
function cfRuntimeOf(actor: HostedActor, what: string): Effect.Effect<CFRuntime, KinuError> {
  const runtime = actor.runtime;

  return isCFRuntime(runtime) ? Effect.succeed(runtime) : Effect.fail(new KinuError('unsupported', `${what} must run on the cf runtime`));
}

function hostedLifetime(record: WorkspaceActor): SubordinateLifetime {
  return record.lifetime;
}

/** Admit work and report the delivery branch; only this actor knows whether a turn is live. */
export async function admitHostedTask(
  seams: HostedActorSeams,
  reference: ActorReference,
  input: {
    readonly kind: 'task' | 'message';
    readonly body: string;
    readonly mode: WorkMode;
    readonly deliverable?: string;
    readonly inheritedContext?: SubordinateInheritedContext;
    readonly creationId?: string;
    readonly messageId?: string;
  },
): Promise<{ id: string; admitted: boolean } & SubordinateHandoff> {
  const admitAs = async (actor: HostedActor): Promise<{ id: string; admitted: boolean } & SubordinateHandoff> => {
    const busy = actor.session.inFlight;

    const admission: Parameters<typeof admitSubordinateTask>[1] = {
      fromWorkspace: actor.record.workspaceId,
      kind: input.kind,
      body: input.body,
      mode: input.mode,
      now: Date.now(),
    };

    if (input.deliverable) admission.deliverable = input.deliverable;

    if (input.inheritedContext) admission.inheritedContext = input.inheritedContext;

    if (input.creationId !== undefined) admission.creationId = input.creationId;

    if (input.messageId !== undefined) admission.messageId = input.messageId;
    const result = admitSubordinateTask(new EventLog(seams.exec, actor.handle), admission);

    // No chat session means no `auto_title` effect: the first admitted message lands a stand-in title
    // here; the naming model runs after the turn (`runHostedTask`), never inside admission.
    if (result.admitted && input.kind === 'message' && await titleActorFromMessage(actor.handle, input.body)) {
      seams.announce(actor);
    }

    // Arm the wake, not the reactor: an assignment is not a `wakesADrain` row, and its runner
    // `drainAdmittedDelegations` must not run in this request.
    if (result.admitted) seams.armWake();

    return {
      ...result,
      ...describeSubordinateHandoff({
        admission: result,
        turnInFlight: busy,
        live: readSubordinateLiveStatus(seams.exec, actor.handle),
      }),
    };
  };

  return await seams.host.run(reference, (actor) => settle(
    refusal(input.creationId !== undefined && input.creationId !== actor.record.creationId,
      () => new KinuError('denied', 'The birth assignment belongs to a different actor creation.'))
      .pipe(Effect.andThen(Effect.promise(() => admitAs(actor)))),
  ));
}

/** A child's report to its hiring parent, in-process; `sequenceId` remains the ingress dedupe key. */
export async function relayHostedReport(
  seams: HostedActorSeams,
  child: HostedActor,
  report: {
    readonly status: SubordinateReportStatus;
    readonly content: string;
    readonly origin: SubordinateReportOrigin;
    readonly mode: WorkMode;
    readonly sequenceId: string;
    /** Absent on the automatic turn-end relay. */
    readonly handoff?: SubordinateReportHandoff;
    /** The assignment this report answers; closed on delivery. */
    readonly answers?: string;
  },
): Promise<SubordinateEventResult> {
  // Past depth 1 the hiring parent is not the workspace.
  const parent = registeredParent(seams.host, child.record, {
    orphan: 'The workspace main actor was not hired by anyone.',
    unregistered: 'The hiring actor is no longer registered.',
  });

  const name = child.record.name;
  const { answers, ...event } = report;

  const answered = (): void => {
    if (answers !== undefined) new EventLog(seams.exec, child.handle).markAnswered(answers);
  };

  return await seams.host.run(parent, async (hirer) => {
    const temporary = seams.temporary(hirer);

    return await receiveSubordinateEvent({
      log: new EventLog(seams.exec, hirer.handle),
      roster: seams.roster(hirer),
      vfs: seams.vfs(),
      transaction: (body) => seams.transaction(() => {
        const written = body();
        answered();

        return written;
      }),
      announce: () => { seams.announce(hirer); },
      onAdmitted: () => { seams.scheduleDrain(hirer); },
      // A task child's answer goes first to its waiter, and closes before the waiter retires the child.
      temporary: {
        ...temporary,
        settle: (input) => {
          const settled = temporary.settle(input);

          if (settled) answered();

          return settled;
        },
      },
    }, { fromSubordinate: name, ...event }, Date.now());
  });
}

export async function retireStalledTask(
  seams: HostedActorSeams,
  child: HostedActor,
  turn: { readonly turnId: string; readonly runs: number; readonly workMode: WorkMode },
): Promise<void> {
  new EventLog(seams.exec, child.handle).dismiss(turn.turnId, `stalled after ${String(turn.runs)} runs`, 'system');

  const owed = await terminalTaskReport({
    lifetime: hostedLifetime(child.record),
    ending: 'recovered',
    assistantText: 'This task was cut off twice at the same step by resets of the workspace (a platform memory or time '
      + 'limit), so it is not being run again. A reset may have come from other work in the workspace, not from this task.',
    narration: () => Promise.resolve([]),
  });

  if (owed === null) return;
  await relayHostedReport(seams, child, {
    status: owed.status, content: owed.content, origin: 'turn_end', mode: turn.workMode, sequenceId: turn.turnId,
  });
}

/**
 * One delegated turn via `runHeadInference`. A `task` child owes a terminal answer on every ending
 * (an `agents.ask` is blocked on it); a `durable` child relays only a completed turn. A report that
 * already settled the run suppresses both.
 */
export interface HostedTaskResult {
  readonly text: string;
  readonly relayed: SubordinateEventResult | null;
}

/** The actor's chat room, told the answer before the title model and the parent relay run. */
export interface HostedChatSink {
  readonly observeStream?: ObserveStream;
  answered(outcome: { readonly completion: HeadReport['canonicalCompletion']; readonly error: string | null }): Promise<void>;
}

/** Only completion answers; abort is resumable; spent budget and throws are errors. */
const TASK_TURN_ENDING: Readonly<Record<HeadReport['status'], TaskTurnEnding>> = {
  completed: 'answered',
  aborted: 'interrupted',
  budget_exceeded: 'errored',
  errored: 'errored',
};

export async function runHostedTask(
  seams: HostedActorSeams,
  reference: ActorReference,
  task: {
    readonly body: string;
    readonly mode: WorkMode;
    readonly sequenceId: string;
    readonly inheritedContext?: SubordinateInheritedContext;
  },
  chat?: HostedChatSink,
): Promise<HostedTaskResult> {
  const runTurn = async (actor: HostedActor, runtime: CFRuntime) => {
    const reports: HostedReportLedger = { spoke: false, settled: false };
    const resolved = await seams.profile({ actor, availableTools: [], workMode: task.mode });
    await seams.priceAs(actor, resolved.profile.tier.model);
    // Built once for both runner and tools: recovery verifies the claim against it.
    const input = delegatedHeadInput(actor.record, task);
    // One findings accumulator: the tools write it and `runHeadInference` reports from it; a second
    // copy returned reports with no findings.
    const capture = new HeadCapture();

    const turn: HostedTaskTurn = {
      turnId: task.sequenceId, actor, runtime, reports, input, capture,
      model: seams.resolveModel(resolved.profile.tier.model),
      profile: resolved,
    };

    // Without this framing the runner defaults to a fork's, telling a hire it is a parallel thread.
    const profile = await seams.taskProfile(turn);

    const runId = crypto.randomUUID();

    const inference: HeadInferenceDeps = {
      actor,
      runId,
      clock: REAL_CLOCK,
      delegation: {
        assignmentId: task.sequenceId,
        birthContext: input.inheritedContext.map(inheritedAsModelMessage),
      },
      model: turn.model,
      tools: profile.tools,
      framing: {
        system: profile.framing.system,
        messages: profile.framing.messages,
      },
      capture,
      workspaceLayout: 'shared-workspace',
      // Never aborted by parent hang-up, socket close, or eviction: an unsettled claim records owed work.
      isAborted: () => false,
      profile: (request) => seams.profile({ actor, ...request }),
      dynamic: (resolvedProfile, tools) => seams.dynamic(actor, resolvedProfile, tools),
    };

    if (chat?.observeStream !== undefined) inference.observeStream = chat.observeStream;

    // The run bracket the local host writes via `ChatSession.processTurn`; `runHeadInference` bypasses
    // it (measured 2026-09-17 in the workerd pool: a hire's child ledger held only `step_finish`).
    // A thrown runner leaves the run open on purpose; the retry opens a new one.
    openTurnRun(actor.stores.eventRecorder, runId, {
      agentId: actor.record.actorId,
      causedBy: 'subordinate_task',
      userMessage: task.body,
      turnIndex: actor.session.orchestrator.sessionTurnIndex,
    });

    const report = await runHeadInference(input, inference);

    closeTurnRun(actor.stores.eventRecorder, runId, {
      turnIndex: actor.session.orchestrator.sessionTurnIndex,
      usage: report.usage,
      workMode: task.mode,
      ...classifyRunEnd({
        completed: report.status === 'completed',
        interrupted: report.status === 'aborted',
        errorText: report.errorMessage,
      }),
    });

    const ending: TaskTurnEnding = TASK_TURN_ENDING[report.status];

    await chat?.answered({
      completion: report.canonicalCompletion,
      error: ending === 'errored' ? report.errorMessage ?? report.summary : null,
    });

    return { report, ending, reports };
  };

  // Title upgrade (#18): no `auto_title` effect on a hosted actor, so name it after the run.
  // A failed titling model keeps the stand-in; the turn does not fail over its name.
  const titled = (actor: HostedActor): Effect.Effect<void> => attempt(
    { doing: 'deriving a hosted actor title from its brief', otherwise: 'unavailable' },
    () => titleActorFromMessage(actor.handle, task.body, (brief) => seams.suggestTitle(brief)),
  ).pipe(Effect.match({
    onSuccess: (renamed) => { if (renamed) seams.announce(actor); },
    onFailure: (failure) => {
      diagnostics.failure('agent.auto_title_suggestion_failed', failure, { workspace: actor.record.workspaceId });
    },
  }));

  const relayEnding = async (
    actor: HostedActor,
    { report, ending, reports }: Awaited<ReturnType<typeof runTurn>>,
  ): Promise<HostedTaskResult> => {
    const owed = reports.settled ? null : await terminalTaskReport({
      lifetime: hostedLifetime(actor.record), ending, assistantText: report.summary,
      narration: () => actor.stores.history.transcript(CHAT_SESSION_ID).narration(report.canonicalCompletion?.outputPartReferences ?? []),
    });

    const relayed = owed ?? (
      ending === 'answered' && subordinateRelaysTurnEnd({
        reportedThisTurn: reports.spoke, ownerDriven: false, assistantText: report.summary,
      })
        ? { status: 'progress' as const, content: report.summary }
        : null
    );

    if (relayed === null) {
      new EventLog(seams.exec, actor.handle).markAnswered(task.sequenceId);

      return { text: report.summary, relayed: null };
    }

    return {
      text: report.summary,
      relayed: await relayHostedReport(seams, actor, {
        status: relayed.status, content: relayed.content, origin: 'turn_end',
        mode: task.mode, sequenceId: task.sequenceId, answers: task.sequenceId,
      }),
    };
  };

  return await seams.host.run(reference, (actor) => settle(Effect.gen(function* () {
    const runtime = yield* cfRuntimeOf(actor, 'a hosted subordinate');
    const ran = yield* Effect.promise(() => runTurn(actor, runtime));

    yield* titled(actor);

    return yield* Effect.promise(() => relayEnding(actor, ran));
  })));
}

/** One actor's child substrate: every verb is a call on the workspace's one host. */
export function hostedSubordinateRuntime(
  seams: HostedActorSeams,
  parent: () => BoundActor,
): SubordinateRuntime {
  const registerChild = (
    input: SubordinateSeed & { creationId: string },
    action: 'register' | 'cancelCreation',
  ): Effect.Effect<ActorReference, KinuError> => Effect.suspend(() => {
    const owner = parent();

    return refusal(action === 'register' && delegationExhausted(hostedDelegationBudget(seams, owner)),
      () => new KinuError('denied', 'This actor cannot create a subordinate below its delegation depth.'))
      .pipe(Effect.andThen(Effect.sync(() => seams.directory.apply(owner.reference, seams.directory.storagePath(owner.reference), {
        action, name: input.name, creationId: input.creationId, kind: 'subordinate', lifetime: input.lifetime,
      }).reference)));
  });

  const resolve = (name: string): Effect.Effect<ActorReference, KinuError> => Effect.suspend(() => {
    const owner = parent();

    const entry = seams.directory.apply(owner.reference, seams.directory.storagePath(owner.reference), {
      action: 'resolve', name,
    });

    return refusal(entry.kind !== 'subordinate', () => new KinuError('denied', 'The roster name does not identify a subordinate.'))
      .pipe(Effect.as(entry.reference));
  });

  /** Runs `body` as the named hire. */
  const asHire = <Result>(name: string, body: (reference: ActorReference) => Promise<Result>): Effect.Effect<Result, KinuError> =>
    resolve(name).pipe(Effect.flatMap((reference) => Effect.promise(() => body(reference))));

  return {
    spawn: (input) => settle(registerChild(input, 'register').pipe(Effect.tap((reference) => Effect.promise(() =>
      // The child's own config rows only; the parent's roster row is core's (`createTeamToolDeps`),
      // one writer per fact.
      seams.host.run(reference, (actor) => {
        actor.stores.config.setDisplayNameOrigin(input.displayName, input.nameOrigin);
        actor.stores.config.setRoleSelection(input.role);
        actor.stores.config.setAssignedTier(input.tier ?? null);

        return Promise.resolve();
      }))))),
    cancelBirth: (input) => settle(registerChild(input, 'cancelCreation')),
    assign: (name, input) => settle(asHire(name, (reference) => admitHostedTask(seams, reference, { kind: 'task' as const, ...input }))),
    status: (name) => settle(asHire(name, (reference) => seams.host.run(reference, async (actor) =>
      readSubordinateLiveStatus(seams.exec, actor.handle)))),
    message: (name, content, mode) => settle(asHire(name, (reference) => admitHostedTask(seams, reference, { kind: 'message', body: content, mode }))),
    rename: (name, displayName, nameOrigin) => settle(asHire(name, (reference) => seams.host.run(reference, async (actor) => {
      actor.stores.config.setDisplayNameOrigin(displayName, nameOrigin);
    }))),
    /** Wipe removes rows, home and state subtree; archive keeps them. `observed` lets the host settle a live claim. */
    dismiss: async (name, { keepHistory, interrupt }, reference) => {
      const live = seams.host.hosted(reference);
      const claim = live === null ? null : live.session.turnClaim;
      // `observed` only when a claim was seen: the host's refusal depends on absent vs present.
      const request: ActorRetirementRequest = { reference, name, keepHistory, interrupt };

      if (claim !== null) request.observed = { turnId: claim.turnId, epoch: claim.epoch };
      await seams.host.retire(parent().reference, actorRetirementFor(request));
    },
  };
}

/** Core's predicate at the one place a hosted child's report is admitted. */
export function reportSettlesRun(status: SubordinateReportStatus, origin: SubordinateReportOrigin): boolean {
  return temporaryRunSettles({ status, origin });
}

/** Heads, swarm nodes and steer branches are full run actors; an MCTS branch is a toolless one. */
export interface ExplorationActorRequest {
  readonly creationId: string;
  readonly toolProfile: 'full' | 'toolless';
  /** Absent lets `defaultLoopOrigin` stand (`inherit`). */
  readonly loop?: LoopOrigin;
}

export interface ExplorationProfile {
  readonly profile: ResolvedTurnProfile;
  readonly inputs: ProfileAuthorityInputs;
}

export interface BranchCompletionRequest {
  readonly actor: HostedActor;
  readonly spec: string;
  /** The route's own reasoning effort; spec and effort are one decision and travel together. */
  readonly effort: ReasoningEffort | null;
  readonly system?: string;
  readonly user: string;
}

/** Supplied by the root because the provider registry and operation sink are its own. */
export interface BranchRunnerDeps {
  explorePrompt(input: {
    readonly mode: WorkMode;
    readonly context: string;
    readonly craftedTools: CraftedTool[];
    readonly languages: readonly [string, ...string[]];
    readonly siblings: readonly string[];
  }): { readonly system: string; readonly user: string };
  reflectionPrompt(task: string, traces: string, outcome?: string): string;
  complete(request: BranchCompletionRequest): Promise<BranchExploration>;
}


/** One run actor: registered (or re-found) under its creation id, retired when its run settles. */
async function hostRunActor(seams: HostedActorSeams, request: ExplorationActorRequest): Promise<{
  readonly reference: ActorReference;
  readonly retire: () => Promise<void>;
}> {
  const reference = await seams.register(request);

  return { reference, retire: () => retireExploration(seams, reference, explorationActorKey(request.creationId)) };
}

/** Retire an exploration actor. `observed` travels when a live claim was seen, so the host settles it. */
async function retireExploration(
  seams: HostedActorSeams, reference: ActorReference, name: string,
): Promise<void> {
  const live = seams.host.hosted(reference);
  const claim = live === null ? null : live.session.turnClaim;
  const request: ActorRetirementRequest = { reference, name, keepHistory: false, interrupt: true };

  if (claim !== null) request.observed = { turnId: claim.turnId, epoch: claim.epoch };
  const retirement = actorRetirementFor(request);
  await seams.host.retire(registeredParent(seams.host, reference, {
    orphan: 'An exploration actor always has a parent.',
    unregistered: 'The exploration actor has no registered parent.',
  }), retirement);
}

/** The caller's pinned spec wins (heterogeneous heads); else the route's, resolved through the
 *  profile, since the account default would ignore the role's tier. */
function explorationModelSpec(
  seams: HostedActorSeams,
  actor: HostedActor,
  source: 'head' | 'swarm',
  pinned: string | null | undefined,
): Effect.Effect<string, KinuError> {
  if (pinned) return Effect.succeed(pinned);

  return runRoute(seams, actor, { source, workMode: 'build', what: `a hosted ${source} run` }).pipe(Effect.map((route) => route.model));
}

/** The route a run actor's model call takes, resolved through its profile. */
function runRoute(
  seams: HostedActorSeams,
  actor: HostedActor,
  request: { readonly source: 'head' | 'swarm' | 'mcts'; readonly workMode: WorkMode; readonly what: string },
): Effect.Effect<NonNullable<ReturnType<typeof resolveModelRoute>>, KinuError> {
  return Effect.promise(() => seams.profile({ actor, availableTools: [], workMode: request.workMode })).pipe(
    Effect.flatMap(({ profile }) => {
      const route = resolveModelRoute(request.source, profile);

      return route ? Effect.succeed(route) : Effect.fail(new KinuError('denied', `${request.what} cannot use the fixed platform model route`));
    }),
  );
}

/** `memoryTail` absent and `missingCapabilities` empty by fact: heads don't read MEMORY.md and connect no MCP servers. */
function explorationDynamicContext(actor: HostedActor, profile: ResolvedTurnProfile, tools: ToolSet): DynamicContext {
  return collectDynamicContext({
    rt: actor.runtime,
    stores: actor.stores,
    profile,
    tools,
    memoryTail: undefined,
    missingCapabilities: [],
    subordinateDelegates: () => subordinateDelegatesOf([]),
  });
}

/** A branching head, hosted. The actor is retired when `run()` settles. */
export async function hostHead(seams: HostedActorSeams, input: HeadInput): Promise<SpawnedHead> {
  const { reference, retire } = await hostRunActor(seams, { creationId: input.id, toolProfile: 'full', loop: input.loop });
  /** The caller's explicit stop; a socket close or evicted isolate must leave this false. */
  let stopped: string | null = null;

  return {
    id: input.id,
    run: async (): Promise<HeadReport> => {
      // Created before `host.run` because acquiring builds the runtime over the watched
      // file view; a later capture would report no file changes.
      const capture = new HeadCapture();
      const unwatch = seams.watchWrites(reference, capture.files);

      const runHead = async (actor: HostedActor, runtime: CFRuntime, spec: string): Promise<HeadReport> => {
        const webSearch = seams.webSearch();
        await seams.priceAs(actor, spec);

        const deps: HeadInferenceDeps = {
          actor,
          runId: crypto.randomUUID(),
          clock: REAL_CLOCK,
          model: seams.resolveModel(spec),
          tools: buildHeadToolSet({
            input, capture, rt: runtime, history: actor.stores.history,
            codemodeTool: seams.codemodeTool(runtime, webSearch),
            webSearch,
            split: seams.split(actor, runtime, input),
          }),
          capture,
          workspaceLayout: 'shared-workspace',
          isAborted: () => stopped !== null,
          abortReason: () => stopped,
          profile: (request) => seams.profile({ actor, ...request }),
          dynamic: (profile, tools) => explorationDynamicContext(actor, profile, tools),
          reportStep: (seq, step) => seams.recordStep(input.id, seq, step),
          reportDelta: seams.publishDelta,
        };

        const mission = seams.mission(input);

        if (mission !== null) {
          deps.mission = { ...mission, port: { ...mission.port, debit: (tokens, opts) => mission.port.debit(tokens, { ...opts, spec }) } };
        }

        return await runHeadInference(input, deps);
      };

      try {
        return await seams.host.run(reference, (actor) => settle(Effect.gen(function* () {
          const runtime = yield* cfRuntimeOf(actor, 'a hosted head');
          const spec = yield* explorationModelSpec(seams, actor, 'head', input.model);

          return yield* Effect.promise(() => runHead(actor, runtime, spec));
        })));
      } finally {
        unwatch();
        await retire();
      }
    },
    /** Explicit stop: records the reason and interrupts the live turn. Not reachable from a transport close. */
    abort: async (reason: string): Promise<void> => {
      stopped = reason;
      seams.host.hosted(reference)?.session.interrupt();
    },
  };
}

/**
 * A factory, not a value: `swarm-expansion.ts` shallow-copies node deps per child, so a
 * single `actor` would give every node one claim ledger and row set.
 */
export async function hostNodeSeat(
  seams: HostedActorSeams, node: NodeIdentity,
): Promise<HostedNodeSeat> {
  const { reference } = await hostRunActor(seams, { creationId: node.nodeId, toolProfile: 'full' });
  const actor = await seams.host.acquire(reference);

  return {
    actor,
    runId: crypto.randomUUID(),
    profile: (request) => seams.profile({ actor, ...request }),
    dynamic: (profile, tools) => explorationDynamicContext(actor, profile, tools),
  };
}

/** A swarm node's `eval`, over the hosted actor the node runs as. */
export function nodeCodemodeTool(seams: HostedActorSeams, actor: HostedActor): (finished: ToolSet) => Tool {
  return settleSync(cfRuntimeOf(actor, 'a swarm node').pipe(Effect.map((runtime) => seams.codemodeTool(runtime, seams.webSearch()))));
}

/**
 * Retire exploration actors whose work is provably finished. The ledger is the only
 * status authority: any reported status is terminal, unknown statuses are not, and
 * an unledgered actor is retired only when nothing live claims exploration work,
 * because a search creates its actor before its node row.
 */
export async function reclaimSettledExplorationActors(
  seams: HostedActorSeams,
  ledger: {
    readHead(id: string): { readonly status: string } | null;
    hasLiveExploration(): boolean;
  },
): Promise<{ readonly retired: number; readonly retained: number }> {
  let retired = 0;
  let retained = 0;
  const live = ledger.hasLiveExploration();

  for (const reference of seams.host.list()) {
    const record = seams.host.describe(reference.actorId);

    if (record === null || record.kind === 'main' || record.kind === 'subordinate') {
      retained += 1;
      continue;
    }

    const head = ledger.readHead(parseExplorationId(record.storageKey, record.name));

    const settled = head === null
      ? !live
      : !headStatusUnsettled(head.status) && storedHeadReportStatus(head.status) !== null;

    if (!settled) {
      retained += 1;
      continue;
    }

    await retireExploration(seams, reference, record.name);
    retired += 1;
  }

  return { retired, retained };
}

/** Only the actor name carries the `exp:` marker, so a generated id never collides with a roster slug. */
function parseExplorationId(storageKey: string, name: string): string {
  const marked = name.startsWith('exp:') ? name.slice(4) : name;

  return marked === '' ? storageKey : marked;
}

/**
 * An MCTS rollout branch: no ToolSet, no plane, no home. The durable trace is
 * `search_nodes.observation`. The engine releases it in the `finally` after every reflection.
 */
export async function hostBranch(
  seams: HostedActorSeams,
  branchId: string,
  deps: BranchRunnerDeps,
): Promise<BranchHandle> {
  const { reference, retire } = await hostRunActor(seams, { creationId: branchId, toolProfile: 'toolless' });
  /** Held in memory for the reflection that may follow; the handle's life is the window. */
  let trace = '';

  return {
    explore: (request) => seams.host.run(reference, (actor) => settle(Effect.gen(function* () {
      const { priorHistory, craftedTools, languages, mode, siblings } = request;
      const route = yield* runRoute(seams, actor, { source: 'mcts', workMode: mode, what: 'an MCTS branch' });

      const { system, user } = deps.explorePrompt({
        mode,
        context: priorHistory.map((turn) => `${turn.role}: ${turn.content}`).join('\n\n'),
        craftedTools, languages, siblings: siblings ?? [],
      });

      const answer = yield* Effect.promise(() => deps.complete({
        actor, spec: route.model, effort: route.reasoningEffort, system, user,
      }));

      trace = answer.text;

      return answer;
    }))),
    generateReflection: (task, outcome) => seams.host.run(reference, (actor) => settle(Effect.gen(function* () {
      const route = yield* runRoute(seams, actor, { source: 'mcts', workMode: 'build', what: 'an MCTS reflection' });

      const answer = yield* Effect.promise(() => deps.complete({
        actor, spec: route.model, effort: route.reasoningEffort,
        user: deps.reflectionPrompt(task, trace, outcome),
      }));

      return { text: answer.text, usage: answer.usage } satisfies BranchReflection;
    }))),
    release: retire,
  };
}

/**
 * Stop one branch by id; ends at `retireExploration` like `release()`. `register` re-finds
 * (idempotent on the creation id). Wired beside `spawn` and never without it.
 */
export async function abortHostedBranch(
  seams: HostedActorSeams, branchId: string,
): Promise<void> {
  await (await hostRunActor(seams, { creationId: branchId, toolProfile: 'toolless' })).retire();
}
