/** Shared tools and roster for non-main agents; their turns run in AgentFacet. */

import { INTERRUPTED_TURN, type HeadReport, isSubordinateOrigin } from '@kinu.run/core';
import type { LanguageModel, ModelMessage, Tool, ToolSet } from 'ai';
import {
  EventLog, HeadCapture, titleActorFromMessage, spawnSeatedHead, buildHeadMessages, buildHeadSystemPrompt,
  admitSubordinateTask, describeSubordinateHandoff, readSubordinateLiveStatus,
  receiveSubordinateEvent, subordinateRelaysTurnEnd, temporaryRunSettles,
  subordinateForkContext, type SubordinateInheritedContext,
  inheritedAsModelMessage,
  collectDynamicContext, explorationActorKey, headStatusUnsettled, resolveModelRoute,
  storedHeadReportStatus, subordinateDelegatesOf,
  registeredParent, subordinateDescendants, actorReferenceOf, TEMPORARY_LIFETIME, terminalTaskReport, taskAnswerIsLater, defaultLoopOrigin, delegationBudgetOf, delegationExhausted,
  type ActorHost, type ActorReference, type AssignedTurnFraming, type BoundActor,
  type DelegationBudget,
  type DynamicContext, type HeadId, type HeadInput, type HeadInferenceDeps, type HeadSplitRequest, type HeadSplitResult,
  type HeadStep, type HostedActor, type HostedNodeSeat, type LoopOrigin, type MissionScope, type NodeIdentity,
  type NodeWorkspace, type ProfileAuthorityInputs, type ReportHeadDelta, type ResolvedTurnProfile,
  type SpawnedHead, type SqlExec, type SubordinateEventResult, type SubordinateHandoff,
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
  /** Positional executor for the same database; the event log needs this port, not the tagged one. */
  readonly exec: SqlExec;
  readonly directory: WorkspaceActorDirectory;
  turnInFlight(reference: ActorReference): boolean;
  infer(reference: ActorReference, input: HeadInput, inference: HeadInferenceDeps): Promise<HeadReport>;
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
  scheduleDrain(actor: BoundActor): void;
  /** Arm the wake chain that reaches the delegation runners; the admitting request must not run it. */
  armWake(): void;
  rederiveWake(): void;
  temporary(actor: BoundActor): TemporaryAgentPort;
  /** Inside the answer's transaction: the hirer's advisor answer is owed a delivery job. */
  oweAdvice(actor: BoundActor): Promise<void>;
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
    loop: defaultLoopOrigin('agent'),
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
    const busy = seams.turnInFlight(actor.reference);

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
    // here; the naming model runs after the turn (`settleHostedTask`), never inside admission.
    if (result.admitted && input.kind === 'message' && await titleActorFromMessage(actor.handle, input.body)) {
      seams.announce(actor);
    }

    // Arm the wake, not the reactor: an assignment is not a `wakesADrain` row, and its runner
    // The delegation runners must not start in this request.
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
    /** A Stop: wakes no one. */
    readonly quiet?: true;
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

  // Neither the hirer's queue (it may wait on this child's) nor its session (an idle hirer holds none).
  const hirer = seams.host.hosted(parent) ?? seams.host.bindStores(parent);

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
    onAdmitted: () => { if (!seams.turnInFlight(parent)) seams.scheduleDrain(hirer); },
    evolutionAnswerStored: () => seams.oweAdvice(hirer),
    onEvolutionAnswer: () => { seams.rederiveWake(); },
    temporary: seams.temporary(hirer),
  }, { fromSubordinate: name, ...event }, Date.now());
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

export interface HostedTurnRequest {
  readonly body: string;
  readonly mode: WorkMode;
  readonly sequenceId: string;
  readonly inheritedContext?: SubordinateInheritedContext;
  readonly run?: { readonly input: HeadInput; readonly inference: HeadInferenceDeps };
}

export interface PreparedHostedTurn {
  readonly turn: HostedTaskTurn;
  readonly model: string;
  readonly tools: ToolSet;
  readonly framing: AssignedTurnFraming;
  readonly birthContext: readonly ModelMessage[];
}

export function prepareHostedTurn(
  seams: HostedActorSeams,
  reference: ActorReference,
  task: HostedTurnRequest,
): Promise<PreparedHostedTurn> {
  return settle(Effect.gen(function* () {
    const run = task.run;
    const actor = run?.inference.actor ?? (yield* Effect.promise(() => seams.host.acquire(reference)));
    const runtime = yield* cfRuntimeOf(actor, 'a hosted agent');

    const resolved = yield* Effect.promise(() => run === undefined
      ? seams.profile({ actor, availableTools: [], workMode: task.mode })
      : run.inference.profile({ availableTools: [], workMode: task.mode }));

    const input = run?.input ?? delegatedHeadInput(actor.record, task);
    const model = run?.inference.modelSpec ?? input.model ?? resolved.profile.tier.model;

    yield* Effect.promise(() => seams.priceAs(actor, model));

    const turn: HostedTaskTurn = {
      turnId: task.sequenceId, actor, runtime, reports: { spoke: false, settled: false }, input,
      capture: run?.inference.capture ?? new HeadCapture(),
      model: run?.inference.model ?? seams.resolveModel(model),
      profile: resolved,
    };

    const profile = run === undefined ? yield* Effect.promise(() => seams.taskProfile(turn)) : {
      tools: run.inference.tools,
      framing: run.inference.framing ?? {
        system: buildHeadSystemPrompt(input, Object.keys(run.inference.tools), run.inference.workspaceLayout),
        messages: buildHeadMessages(input),
      },
    };

    return {
      turn, model, tools: profile.tools, framing: profile.framing,
      birthContext: run === undefined ? input.inheritedContext.map(inheritedAsModelMessage) : [],
    };
  }));
}

/** Only completion answers; abort resumes; the rest are errors. */
const TASK_TURN_ENDING: Readonly<Record<HeadReport['status'], TaskTurnEnding>> = {
  completed: 'answered',
  aborted: 'interrupted',
  budget_exceeded: 'errored',
  errored: 'errored',
};

export interface HostedTaskEnd {
  readonly status: HeadReport['status'];
  readonly summary: string;
  readonly errorMessage: string | null;
  readonly narration: string;
}

export function hostedTaskEnding(end: HostedTaskEnd): TaskTurnEnding {
  // An owner's Stop reaches the model call as an interrupted stream, which the head records as a failure.
  return end.status === 'errored' && end.errorMessage?.includes(INTERRUPTED_TURN) === true
    ? 'interrupted'
    : TASK_TURN_ENDING[end.status];
}

/**
 * The workspace half of a turn's end: the title, then the report the hirer is owed, relayed after the turn so a
 * hirer waiting on this agent's queue is not waited on in turn. A report the run already settled suppresses it.
 */
export function settleHostedTask(
  seams: HostedActorSeams,
  prepared: PreparedHostedTurn,
  task: HostedTurnRequest,
  end: HostedTaskEnd,
): Promise<SubordinateEventResult | null> {
  const { actor, reports } = prepared.turn;
  const ending = hostedTaskEnding(end);

  // Title upgrade (#18): no `auto_title` effect on a hosted actor, so name it after the run.
  // A failed titling model keeps the stand-in; the turn does not fail over its name.
  const titled = attempt(
    { doing: 'deriving a hosted actor title from its brief', otherwise: 'unavailable' },
    () => titleActorFromMessage(actor.handle, task.body, (brief) => seams.suggestTitle(brief)),
  ).pipe(Effect.match({
    onSuccess: (renamed) => { if (renamed) seams.announce(actor); },
    onFailure: (failure) => {
      diagnostics.failure('agent.auto_title_suggestion_failed', failure, { workspace: actor.record.workspaceId });
    },
  }));

  const owedReport = async (): Promise<{ readonly status: SubordinateReportStatus; readonly content: string; readonly quiet?: true } | null> => {
    const owed = reports.settled ? null : await terminalTaskReport({
      lifetime: hostedLifetime(actor.record), ending, assistantText: end.summary,
      delegating: taskAnswerIsLater({ roster: seams.roster(actor), log: new EventLog(seams.exec, actor.handle), turnTaskId: task.sequenceId }),
      narration: async () => (end.narration === '' ? [] : [end.narration]),
    });

    // A task agent reports only its terminal answer.
    return owed ?? (
      ending === 'answered' && hostedLifetime(actor.record) !== TEMPORARY_LIFETIME && subordinateRelaysTurnEnd({
        reportedThisTurn: reports.spoke, ownerDriven: false, assistantText: end.summary,
      })
        ? { status: 'progress' as const, content: end.summary }
        : null
    );
  };

  return settle(Effect.gen(function* () {
    yield* titled;
    const relayed = yield* Effect.promise(owedReport);

    if (relayed === null) {
      new EventLog(seams.exec, actor.handle).markAnswered(task.sequenceId);

      return null;
    }

    return yield* Effect.promise(() => relayHostedReport(seams, actor, {
      status: relayed.status, content: relayed.content, origin: 'turn_end',
      mode: task.mode, sequenceId: task.sequenceId, answers: task.sequenceId,
      ...(relayed.quiet === true && { quiet: true }),
    }));
  }));
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
        action, name: input.name, creationId: input.creationId, origin: input.origin, lifetime: input.lifetime,
      }).reference)));
  });

  const resolve = (name: string): Effect.Effect<ActorReference, KinuError> => Effect.suspend(() => {
    const owner = parent();

    const entry = seams.directory.apply(owner.reference, seams.directory.storagePath(owner.reference), {
      action: 'resolve', name,
    });

    return refusal(!isSubordinateOrigin(entry.origin), () => new KinuError('denied', 'The roster name does not identify a subordinate.'))
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
      await retireDescendants(seams, reference, keepHistory);
      const live = seams.host.hosted(reference);
      const claim = live === null ? null : live.session.turnClaim;
      // `observed` only when a claim was seen: the host's refusal depends on absent vs present.
      const request: ActorRetirementRequest = { reference, name, keepHistory, interrupt };

      if (claim !== null) request.observed = { turnId: claim.turnId, epoch: claim.epoch };
      await seams.host.retire(parent().reference, actorRetirementFor(request));
    },
  };
}

async function retireDescendants(seams: HostedActorSeams, below: ActorReference, keepHistory: boolean): Promise<void> {
  for (const descendant of subordinateDescendants(seams.directory.list(), below.actorId)) {
    const hirer = seams.directory.retained(descendant.parentActorId ?? '');

    if (hirer === null) continue;
    const roster = seams.roster(seams.host.bindStores(actorReferenceOf(hirer)));

    if (roster.get(descendant.name)?.status !== 'dismissed') roster.dismiss(descendant.name, Date.now());

    await seams.host.retire(actorReferenceOf(hirer), actorRetirementFor({
      reference: actorReferenceOf(descendant), name: descendant.name, keepHistory, interrupt: true,
    }));
  }
}

/** Core's predicate at the one place a hosted child's report is admitted. */
export function reportSettlesRun(status: SubordinateReportStatus, origin: SubordinateReportOrigin): boolean {
  return temporaryRunSettles({ status, origin });
}

/** Heads, swarm nodes and steer branches are run actors. */
export interface ExplorationActorRequest {
  readonly creationId: string;
  /** Absent lets `defaultLoopOrigin` stand (`inherit`). */
  readonly loop?: LoopOrigin;
}

export interface ExplorationProfile {
  readonly profile: ResolvedTurnProfile;
  readonly inputs: ProfileAuthorityInputs;
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
  const request: ActorRetirementRequest = { reference, name, keepHistory: true, interrupt: true };

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
  request: { readonly source: 'head' | 'swarm'; readonly workMode: WorkMode; readonly what: string },
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

/** A branching head, hosted on the one head runner. The actor is retired when `run()` settles. */
export async function hostHead(seams: HostedActorSeams, input: HeadInput): Promise<SpawnedHead> {
  const { reference, retire } = await hostRunActor(seams, { creationId: input.id, loop: input.loop });

  return spawnSeatedHead(input, {
    // The watch is named before the acquire that builds the runtime over it; a later one sees no writes.
    seat: async (_input, writes) => {
      const unwatch = seams.watchWrites(reference, writes);
      const seat = await runActorSeat(seams, reference);

      return {
        ...seat,
        queue: (body) => seams.host.run(reference, body),
        release: async () => {
          unwatch();
          await retire();
        },
      };
    },
    model: (head, seat) => settle(explorationModelSpec(seams, seat.actor, 'head', head.model).pipe(
      Effect.tap((spec) => Effect.promise(() => seams.priceAs(seat.actor, spec))),
      Effect.map((spec) => ({ model: seams.resolveModel(spec), spec })),
    )),
    codemodeTool: (seat) => settleSync(cfRuntimeOf(seat.actor, 'a hosted head').pipe(
      Effect.map((runtime) => seams.codemodeTool(runtime, seams.webSearch())),
    )),
    webSearch: seams.webSearch(),
    split: (seat, head) => settleSync(cfRuntimeOf(seat.actor, 'a hosted head').pipe(
      Effect.map((runtime) => seams.split(seat.actor, runtime, head)),
    )),
    mission: (head, spec) => {
      const mission = seams.mission(head);

      return mission === null || spec === null ? mission
        : { ...mission, port: { ...mission.port, debit: (tokens, opts) => mission.port.debit(tokens, { ...opts, spec }) } };
    },
    reportStep: (headId, seq, step) => seams.recordStep(headId, seq, step),
    reportDelta: seams.publishDelta,
  });
}

/** One run actor's turn seams, over its acquired actor. */
async function runActorSeat(seams: HostedActorSeams, reference: ActorReference): Promise<HostedNodeSeat> {
  const actor = await seams.host.acquire(reference);

  return {
    actor,
    infer: (input, inference) => seams.infer(reference, input, inference),
    runId: crypto.randomUUID(),
    profile: (request) => seams.profile({ actor, ...request }),
    dynamic: (profile, tools) => explorationDynamicContext(actor, profile, tools),
  };
}

/**
 * A factory, not a value: `swarm-expansion.ts` shallow-copies node deps per child, so a
 * single `actor` would give every node one claim ledger and row set.
 */
export async function hostNodeSeat(
  seams: HostedActorSeams, node: NodeIdentity,
): Promise<HostedNodeSeat> {
  return await runActorSeat(seams, (await hostRunActor(seams, { creationId: node.nodeId })).reference);
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

    if (record === null || record.origin !== 'swarm') {
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
