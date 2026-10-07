import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** Shared tools and roster for non-main agents; their turns run in AgentFacet. */

import { currentDateForPrompt, publishSubordinateReport, type ConversationRecall, type HeadReport, isSubordinateOrigin, type SubordinateReportLedger, type ToolSurfaceNarrowing } from '@kinu.run/core';
import type { LanguageModel, ModelMessage, Tool, ToolSet } from 'ai';
import { EventLog, HeadCapture, titleActorFromMessage, spawnSeatedHead, admitSubordinateTask, describeSubordinateHandoff, readSubordinateLiveStatus, receiveSubordinateEvent, subordinateRelaysTurnEnd, subordinateForkContext, type SubordinateInheritedContext, inheritedAsModelMessage, collectDynamicContext, explorationActorKey, headStatusUnsettled, storedHeadReportStatus, subordinateDelegatesOf, registeredParent, subordinateDescendants, actorReferenceOf, TEMPORARY_LIFETIME, terminalTaskReport, taskAnswerIsLater, defaultLoopOrigin, delegationBudgetOf, delegationExhausted, type ActorHost, type ActorReference, type BoundActor, type DelegationBudget, type DynamicContext, type HeadId, type HeadInput, type RunInference, type HeadSplitRequest, type HeadSplitResult, type HeadStep, type HostedActor, type HostedNodeSeat, type StepLoopJobSeat, type JobRetirement, type LoopOrigin, type MissionScope, type NodeIdentity, type NodeWorkspace, type ProfileAuthorityInputs, type ReportHeadDelta, type ResolvedTurnProfile, type SpawnedHead, type SqlExec, type SubordinateEventResult, type SubordinateHandoff, type SubordinateLifetime, type SubordinateReportOrigin, type SubordinateReportHandoff, type SubordinateReportStatus, type SubordinateRosterStore, type SubordinateRuntime, type SubordinateSeed, type TaskTurnEnding, type TemporaryAgentPort, type WebSearchProvider, type WorkMode, type WorkspaceActor, type WorkspaceActorDirectory, type WriteObserver } from '@kinu.run/core';
import { attempt, KinuError, settle, settleSync } from '@kinu.run/core/obs';
import type { AgentRuntime, HeadSeat, OwedReport, RunTurnSources } from '@kinu.run/core';
import { Effect } from 'effect';
import { isCFRuntime, type CFRuntime } from './runtime';
import { actorRetirementFor, type ActorRetirementRequest } from './actor-hosting';

/**
 * One delegated turn, decided once: claimed and tooled from the same `input`, under one
 * `model`/`profile` resolution (a second lookup can land a different digest than the claim).
 */
export interface HostedTaskTurn {
  /** The turn's id: keys its claim and effects. */
  readonly turnId: string;
  readonly parentDriven: boolean;
  readonly actor: HostedActor;
  readonly runtime: CFRuntime;
  readonly reports: SubordinateReportLedger;
  readonly input: HeadInput;
  readonly capture: HeadCapture;
  readonly model: LanguageModel;
  readonly profile: ExplorationProfile;
}

/** A hosted turn's tools, and where its turn is assembled from: the prompt's tool index is rendered from them. */
export interface HostedTaskProfile {
  readonly tools: ToolSet;
  readonly raw: ToolSet;
  readonly sources: RunTurnSources;
}

/** One workspace's host and directory, for every hosted kind. */
export interface HostedActorSeams {
  readonly host: ActorHost;
  /** Positional executor for the same database; the event log needs this port, not the tagged one. */
  readonly exec: SqlExec;
  readonly directory: WorkspaceActorDirectory;
  turnInFlight(reference: ActorReference): boolean;
  infer(reference: ActorReference, input: HeadInput, inference: RunInference): Promise<HeadReport>;
  /** Where a run actor's turns are assembled from, read in this object; `dynamic` is its live block. */
  turnSources(actor: HostedActor, runtime: AgentRuntime, dynamic: RunTurnSources['dynamic']): RunTurnSources;
  transaction<Result>(body: () => Result): Result;
  /** Scoped to the actor, so a subordinate manages only its own subtree. */
  roster(actor: BoundActor): SubordinateRosterStore;
  conversations(reference: ActorReference): ConversationRecall;
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
  codemodeTool(runtime: CFRuntime, webSearch: WebSearchProvider): (finished: ToolSet, reach: ToolSurfaceNarrowing) => Tool;
  /** The workspace journal, so a depth-2 head's spawn row and step rows join. */
  recordStep(headId: HeadId, seq: number, step: HeadStep): Promise<void>;
  readonly publishDelta: ReportHeadDelta;
  /** A head's mission, from its labels; a hire is never budgeted here. */
  mission(input: HeadInput): MissionScope | null;
  split(actor: HostedActor, runtime: CFRuntime, input: HeadInput): (request: HeadSplitRequest) => Promise<HeadSplitResult>;
  taskProfile(turn: HostedTaskTurn): Promise<HostedTaskProfile>;
  announce(actor: BoundActor): void;
  /** Drain on a reaction (a child's report). Never for an assignment: `wakesADrain` excludes it. */
  scheduleDrain(actor: BoundActor): void;
  /** The workspace's half of a node's job runner. */
  jobSeat(actorId: string): StepLoopJobSeat;
  retireJobs(actorId: string): Promise<JobRetirement>;
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
    readonly idempotencyKey?: string;
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

    if (input.idempotencyKey !== undefined) admission.idempotencyKey = input.idempotencyKey;
    const result = admitSubordinateTask(new EventLog(seams.exec, actor.handle), admission);

    // No chat session means no `auto_title` effect: the first admitted message lands a stand-in title
    // here; the naming model runs after the turn (`settleHostedTask`), never inside admission.
    if (result.admitted && input.kind === 'message' && await titleActorFromMessage(actor.handle, input.body)) {
      seams.announce(actor);
    }

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

function hostedHirer(seams: HostedActorSeams, child: BoundActor): BoundActor {
  const parent = registeredParent(seams.host, child.record, {
    orphan: 'The workspace main actor was not hired by anyone.',
    unregistered: 'The hiring actor is no longer registered.',
  });

  // Neither the hirer's queue (it may wait on this child's) nor its session (an idle hirer holds none).
  return seams.host.hosted(parent) ?? seams.host.bindStores(parent);
}

/** A child's report to its hiring parent, in-process; `sequenceId` remains the ingress dedupe key. */
export async function relayHostedReport(
  seams: HostedActorSeams,
  child: BoundActor,
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
  const hirer = hostedHirer(seams, child);

  const name = child.record.name;
  const { answers, ...event } = report;

  const answered = (): void => {
    if (answers !== undefined) new EventLog(seams.exec, child.handle).markAnswered(answers);
  };

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
    onAdmitted: () => { if (!seams.turnInFlight(hirer.reference)) seams.scheduleDrain(hirer); },
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
  /** A hirer's turn carries `report`; an owner's chat with the actor does not. */
  readonly parentDriven: boolean;
  readonly run?: { readonly input: HeadInput; readonly inference: RunInference };
}

export interface PreparedHostedTurn {
  readonly turn: HostedTaskTurn;
  readonly model: string;
  readonly tools: ToolSet;
  readonly sources: RunTurnSources;
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
    const { turn, model } = yield* hostedTaskTurn(seams, actor, task, run);

    const profile = run === undefined
      ? yield* Effect.promise(() => seams.taskProfile(turn))
      : { tools: run.inference.tools, sources: run.inference.sources };

    return {
      turn, model, tools: profile.tools, sources: profile.sources,
      birthContext: run === undefined ? turn.input.inheritedContext.map(inheritedAsModelMessage) : [],
    };
  }));
}

/** The raw tools a turn of the hosted actor's own would hold in `mode`: a retry of its job runs on them, as it. */
export function hostedRetryTools(seams: HostedActorSeams, reference: ActorReference, mode: WorkMode, sequenceId: string): Promise<ToolSet> {
  return settle(Effect.gen(function* () {
    const actor = yield* Effect.promise(() => seams.host.acquire(reference));
    const { turn } = yield* hostedTaskTurn(seams, actor, { body: '', mode, sequenceId, parentDriven: true }, undefined);

    return (yield* Effect.promise(() => seams.taskProfile(turn))).raw;
  }));
}

function hostedTaskTurn(
  seams: HostedActorSeams, actor: HostedActor,
  task: Omit<HostedTurnRequest, 'run'>,
  run: HostedTurnRequest['run'],
) {
  return Effect.gen(function* () {
    const runtime = yield* cfRuntimeOf(actor, 'a hosted agent');

    const resolved = yield* Effect.promise(() => seams.profile({ actor, availableTools: [], workMode: task.mode }));

    const input = run?.input ?? delegatedHeadInput(actor.record, task);
    const model = input.model ?? resolved.profile.tier.model;

    yield* Effect.promise(() => seams.priceAs(actor, model));

    const turn: HostedTaskTurn = {
      turnId: task.sequenceId, parentDriven: task.parentDriven, actor, runtime, reports: { spoke: false, settled: false }, input,
      capture: run?.inference.capture ?? new HeadCapture(),
      model: seams.resolveModel(model),
      profile: resolved,
    };

    return { turn, model };
  });
}

/** The report a hosted turn's ending owes its hirer, as a CLI hire's relay decides it: the hirer's roster first,
 *  then a terminal answer, else a durable child's turn-end progress. A report the turn already settled suppresses it. */
export function hostedOwedReport(
  seams: HostedActorSeams,
  actor: BoundActor,
  turn: { readonly reports: SubordinateReportLedger; readonly ownerDriven: boolean },
  ended: { readonly ending: TaskTurnEnding; readonly assistantText: string; readonly narration: readonly string[] },
): Promise<OwedReport | null> {
  return settle(Effect.gen(function* () {
    const hirer = hostedHirer(seams, actor);

    if (seams.roster(hirer).finishTurn(actor.record.name, ended.ending, Date.now())) seams.announce(hirer);

    if (turn.reports.settled) return null;

    const terminal = yield* Effect.promise(() => terminalTaskReport({
      lifetime: hostedLifetime(actor.record), ending: ended.ending, assistantText: ended.assistantText,
      delegating: taskAnswerIsLater({ roster: seams.roster(actor), log: new EventLog(seams.exec, actor.handle) }),
      narration: async () => ended.narration,
    }));

    if (terminal !== null) return terminal;

    // A task agent reports only its terminal answer.
    return ended.ending === 'answered' && hostedLifetime(actor.record) !== TEMPORARY_LIFETIME && subordinateRelaysTurnEnd({
      reportedThisTurn: turn.reports.spoke, ownerDriven: turn.ownerDriven, assistantText: ended.assistantText,
    }) ? { status: 'progress', content: ended.assistantText } : null;
  }));
}

/** A settled turn's report, relayed to the hirer's ingress, which dedupes on its sequence id; answers its disposition. */
export async function hostedParentReport(
  seams: HostedActorSeams,
  actor: BoundActor,
  report: { readonly text: string; readonly status: SubordinateReportStatus; readonly mode: WorkMode; readonly sequenceId: string; readonly quiet?: true },
): Promise<string> {
  const relayed = await publishSubordinateReport({ mode: report.mode, reports: null }, {
    status: report.status, content: report.text, origin: 'turn_end', sequenceId: report.sequenceId,
    ...(report.quiet === true && { quiet: true }),
  }, (published) => relayHostedReport(seams, actor, published));

  return relayed.disposition;
}

/** Names a hosted actor after the work it was given, with the title its own isolate suggested (null: the stand-in
 *  only). A failure throws, so the agent's owed row keeps it. */
export async function hostedAutoTitle(seams: HostedActorSeams, actor: BoundActor, subject: string, title: string | null): Promise<void> {
  if (await titleActorFromMessage(actor.handle, subject, async () => title)) seams.announce(actor);
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
    dismiss: (name, { keepHistory, interrupt }, reference) => settle(Effect.gen(function* () {
      // Its subtree's jobs stop first, or none retires.
      const stoppedJobs: string[] = [];
      const refused: string[] = [];

      for (const descendant of [...subordinateDescendants(seams.directory.list(), reference.actorId).map((record) => record.actorId), reference.actorId]) {
        const retirement = yield* Effect.promise(() => seams.retireJobs(descendant));

        stoppedJobs.push(...retirement.stopped);
        refused.push(...retirement.refused);
      }

      yield* refusal(refused.length > 0, () => new KinuError('unavailable',
        `${name} keeps running: nothing confirmed its job(s) ${refused.join(', ')} stopped${stoppedJobs.length === 0 ? '' : `; ${stoppedJobs.join(', ')} stopped`}.`));
      yield* Effect.promise(() => retireDescendants(seams, reference, keepHistory));
      const live = seams.host.hosted(reference);
      const claim = live === null ? null : live.session.turnClaim;
      // `observed` only when a claim was seen: the host's refusal depends on absent vs present.
      const request: ActorRetirementRequest = { reference, name, keepHistory, interrupt };

      if (claim !== null) request.observed = { turnId: claim.turnId, epoch: claim.epoch };
      yield* Effect.promise(() => seams.host.retire(parent().reference, actorRetirementFor(request)));

      return { stoppedJobs };
    })),
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

/** `memoryTail` absent and `missingCapabilities` empty by fact: heads don't read MEMORY.md and connect no MCP servers. */
function explorationDynamicContext(actor: HostedActor, profile: ResolvedTurnProfile, tools: ToolSet): DynamicContext {
  return collectDynamicContext({
    rt: actor.runtime,
    stores: actor.stores,
    profile,
    tools,
    runtime: { backend: 'cf', model: { id: profile.tier.model }, date: currentDateForPrompt() },
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

      return await settle(Effect.map(runActorSeat(seams, reference), (seat): HeadSeat => ({
        ...seat,
        queue: (body) => seams.host.run(reference, body),
        release: async () => {
          unwatch();
          await retire();
        },
      })));
    },
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
        // The serving model prices a step: a fallback that took over names itself.
        : { ...mission, port: { ...mission.port, debit: (tokens, opts) => mission.port.debit(tokens, { ...opts, spec: opts.spec ?? spec }) } };
    },
    reportStep: (headId, seq, step) => seams.recordStep(headId, seq, step),
    reportDelta: seams.publishDelta,
  });
}

/** One run actor's turn seams, over its acquired actor. */
function runActorSeat(seams: HostedActorSeams, reference: ActorReference): Effect.Effect<HostedNodeSeat, KinuError> {
  return Effect.gen(function* () {
    const actor = yield* attempt({ doing: 'acquiring a hosted run actor', otherwise: 'io' }, () => seams.host.acquire(reference));
    const runtime = yield* cfRuntimeOf(actor, 'a hosted run');

    return {
      actor,
      infer: (input: HeadInput, inference: RunInference) => seams.infer(reference, input, inference),
      runId: crypto.randomUUID(),
      sources: seams.turnSources(actor, runtime, () => (profile: ResolvedTurnProfile, tools: ToolSet) => explorationDynamicContext(actor, profile, tools)),
      conversations: seams.conversations(reference),
      jobs: seams.jobSeat(reference.actorId),
    };
  });
}

/**
 * A factory, not a value: `swarm-expansion.ts` shallow-copies node deps per child, so a
 * single `actor` would give every node one claim ledger and row set.
 */
export async function hostNodeSeat(
  seams: HostedActorSeams, node: NodeIdentity,
): Promise<HostedNodeSeat> {
  const { reference } = await hostRunActor(seams, { creationId: node.nodeId });

  return await settle(runActorSeat(seams, reference));
}

/** A swarm node's `eval`, over the hosted actor the node runs as. */
export function nodeCodemodeTool(seams: HostedActorSeams, actor: HostedActor): (finished: ToolSet, reach: ToolSurfaceNarrowing) => Tool {
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
