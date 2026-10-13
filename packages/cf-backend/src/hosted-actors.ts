import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** Shared tools and roster for non-main agents; their turns run in AgentFacet. */

import { actorPolicy, assignmentDelivery, publishSubordinateReport, type Delivery, type OwedAdmission, type ConversationRecall, type HeadReport, isSubordinateOrigin, type SubordinateReportLedger, type ToolSurfaceNarrowing, type SeatedActor, type TierId } from '@kinu.run/core';
import type { LanguageModel, ModelMessage, Tool, ToolSet } from 'ai';
import { EventLog, titleActorFromMessage, spawnSeatedHead, admitSubordinateTask, describeSubordinateHandoff, readSubordinateLiveStatus, receiveSubordinateEvent, subordinateForkContext, type SubordinateInheritedContext, inheritedAsModelMessage, explorationActorKey, headStatusUnsettled, storedHeadReportStatus, registeredParent, subordinateDescendants, actorReferenceOf, terminalTaskReport, owedSubordinateTurnReport, taskAnswerIsLater, defaultLoopOrigin, delegationBudgetOf, delegationExhausted, type ActorHost, type ActorReference, type BoundActor, type DelegationBudget, type HeadId, type HeadInput, type RunInference, type HeadSplitRequest, type HeadSplitResult, type HeadStep, type HostedNodeSeat, type StepLoopJobSeat, type JobRetirement, type LoopOrigin, type MissionScope, type NodeIdentity, type NodeWorkspace, type ProfileAuthorityInputs, type ReportHeadDelta, type ResolvedTurnProfile, type SpawnedHead, type SqlExec, type SubordinateEventResult, type SubordinateHandoff, type SubordinateLifetime, type SubordinateReportOrigin, type SubordinateReportHandoff, type SubordinateReportStatus, type SubordinateRosterStore, type SubordinateRuntime, type SubordinateSeed, type TaskTurnEnding, type TemporaryAgentPort, type WebSearchProvider, type WorkMode, type WorkspaceActor, type WorkspaceActorDirectory, type WriteObserver } from '@kinu.run/core';
import { attempt, KinuError, settle, settleSync } from '@kinu.run/core/obs';
import type {
  AgentToolDescriptor, ArtifactOverrides, DynamicReads, ExecutionKey, ExecutionLane, FrozenAuthority, HeadCapture, HeadSeat, JsonObject, OperationProfile, OwedReport, PreparedAgentTurn,
  ReceiptExecution, ReportDeps, RunTurnSources, TaskPlan, TrialTurn, TurnAssemblySources, TurnLedgers,
  TurnOpening, TurnSurface,
} from '@kinu.run/core';
import { Effect } from 'effect';
import { isCFRuntime, type CFRuntime } from './runtime';
import { actorRetirementFor, type CFSeat } from './actor-hosting';

/*
 * Every agent's turn surface (design v2 §2, §9), from one factory (`OrchestratorAgent.actorSurface`): the workspace
 * agent's, a hire's, a head's, a swarm node's and a background run's alike. What the turn reaches is core's one decision
 * (`surfaceReach`); these are the shapes the factory is asked with and hands its turn's holder (`AgentTurns`).
 */

/** Where a turn is assembled from, read here; its tools' names and its eval's namespaces are the surface's own. */
type SurfaceSources = RunTurnSources & Pick<TurnAssemblySources, 'wiredToolNames' | 'codemodeCapabilities'>;

/** A head's or a swarm node's run, as its seat in this workspace hands it over: its tools, already receipted, the
 *  sources it assembles from and the capture its calls record into. */
interface RunSurface {
  readonly tools: ToolSet;
  readonly sources: RunTurnSources;
  readonly capture: HeadCapture;
}

/** What one turn's surface is built for. */
export interface SurfaceTurn {
  readonly key: ExecutionKey;
  readonly lane: ExecutionLane;
  /** The words that opened it; empty for a turn read again. */
  readonly text: string;
  readonly run?: RunSurface;
  /** A recovered execution's authority, as it froze at its bind: its profile is this, resolved from nothing current. */
  readonly frozen?: FrozenAuthority;
}

/** What an agent's tools are built under: the execution they claim in, the ledgers they account into, the external
 *  tools its eval reaches, the operation they run under, and its hirer's report where its lane carries one. */
export interface ToolScope {
  readonly execution: () => ReceiptExecution;
  readonly ledgers: TurnLedgers;
  readonly external: () => ToolSet;
  readonly profile: () => OperationProfile | null;
  /** The metadata its turn was admitted under, which judges its plans. */
  readonly driving: JsonObject | undefined;
  readonly report?: ReportDeps;
}

/** The turn an agent's sources are read for: the surface it runs under, its resolution, its evolved text and the tools
 *  its MCP budget is measured against. */
export interface SourcesTurn {
  readonly surface: TurnSurface;
  readonly resolved: ResolvedSurface;
  readonly artifacts: ArtifactOverrides;
  readonly tools: ToolSet;
}

interface ResolvedSurface {
  readonly profile: ResolvedTurnProfile;
  readonly inputs: ProfileAuthorityInputs;
}

export interface ActorSurface {
  /** Its execution, its ledgers, the operation its tools run under and the external tools its eval reaches. */
  readonly surface: TurnSurface;
  /** The resolution its tools were built under, until its isolate binds the final one. */
  readonly resolved: ResolvedSurface;
  /** The tools the workspace runs for it. */
  readonly tools: ToolSet;
  /** Its turn's whole surface as its model is offered it: `tools`, and its owner's lane declared, which its own isolate
   *  runs. */
  readonly offered: ToolSet;
  /** Its tools as a retry of its job runs them: never handed to the background. */
  readonly raw: ToolSet;
  readonly sources: SurfaceSources;
  /** Its dynamic block's reads, held for the agent across its turns. */
  readonly reads: DynamicReads;
  /** A run's, which its inference reads; a chat turn records none. */
  readonly capture: HeadCapture | null;
  /** What the turn has told its hirer by now. */
  readonly reports: SubordinateReportLedger;
  /** Whether its turns are reviewed by an advisor. */
  readonly reviewsTurns: boolean;
  /** The workspace agent's live trial arm, when its fresh turn draws one. */
  readonly trial?: TrialTurn;
  /** What its isolate is told of its tools, and their digest: it is told them again only when the digest moves. */
  readonly descriptors: readonly AgentToolDescriptor[];
  readonly digest: string;
  /** The owner's lane its turn reaches, which its isolate builds over its own store; declared in `offered` alone. */
  readonly ownerLane: PreparedAgentTurn['ownerLane'];
  /** The profile its isolate assembled on: its tools run under it, and its eval reaches what that profile allows. */
  bind(profile: ResolvedTurnProfile): void;
}

/** One workspace's host and directory, for every hosted kind. */
export interface HostedActorSeams {
  readonly host: ActorHost<CFSeat>;
  /** Positional executor for the same database; the event log needs this port, not the tagged one. */
  readonly exec: SqlExec;
  readonly directory: WorkspaceActorDirectory;
  turnInFlight(reference: ActorReference): boolean;
  infer(reference: ActorReference, input: HeadInput, inference: RunInference): Promise<HeadReport>;
  /** Where a run actor's turns are assembled from, read in this object. */
  sources(actor: CFSeat): Promise<RunTurnSources>;
  transaction<Result>(body: () => Result): Result;
  /** Scoped to the actor, so a subordinate manages only its own subtree. */
  roster(actor: BoundActor): SubordinateRosterStore;
  conversations(reference: ActorReference): ConversationRecall;
  vfs(): VFS;
  /** The same profile authority actor chat uses, so role restrictions narrow a hire identically. */
  profile(input: {
    readonly actor: SeatedActor;
    readonly availableTools: readonly string[];
    readonly workMode: WorkMode;
  }): Promise<ExplorationProfile>;
  resolveModel(spec: string): LanguageModel;
  priceAs(spec: string): Promise<void>;
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
  nodeHome(actor: SeatedActor): Promise<NodeWorkspace>;
  /** Typed as `Tool`: core widens `HeadToolDeps.codemodeTool` to `unknown`, this seam need not. */
  codemodeTool(actor: SeatedActor, runtime: CFRuntime, webSearch: WebSearchProvider): (finished: ToolSet, reach: ToolSurfaceNarrowing) => Tool;
  /** The workspace journal, so a depth-2 head's spawn row and step rows join. */
  recordStep(headId: HeadId, seq: number, step: HeadStep): Promise<void>;
  readonly publishDelta: ReportHeadDelta;
  /** A head's mission, from its labels; a hire is never budgeted here. */
  mission(input: HeadInput): MissionScope | null;
  split(actor: SeatedActor, runtime: CFRuntime, input: HeadInput): (request: HeadSplitRequest) => Promise<HeadSplitResult>;
  /** Every agent's turn surface, from the one factory. */
  surface(actor: CFSeat, turn: SurfaceTurn): Promise<ActorSurface>;
  /** Where each of an actor's calls keeps its receipt: the store its effects commit to. */
  receipts(actor: SeatedActor): HostedNodeSeat['receipts'];
  announce(actor: BoundActor): void;
  /** Drain on a reaction (a child's report). Never for an assignment: `wakesADrain` excludes it. */
  scheduleDrain(actor: BoundActor): void;
  /** The workspace's half of a node's job runner. */
  jobSeat(actorId: string): StepLoopJobSeat;
  retireJobs(actorId: string): Promise<JobRetirement>;
  /**
   * What `admit` writes and the delivery it owes the actor, committed as one, then crossed once: the actor's wake is armed
   * before the crossing, and crosses it again if this one does not reach it. Answers what `admit` answered.
   */
  deliver<A>(actor: BoundActor, admit: () => OwedAdmission<A>): Promise<A>;
  /** Who assigns the actor its work, as its chat shows it. */
  hirerName(actor: BoundActor): string;
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
function cfRuntimeOf(actor: SeatedActor, what: string): Effect.Effect<CFRuntime, KinuError> {
  const runtime = actor.runtime;

  return isCFRuntime(runtime) ? Effect.succeed(runtime) : Effect.fail(new KinuError('unsupported', `${what} must run on the cf runtime`));
}

function hostedLifetime(record: WorkspaceActor): SubordinateLifetime {
  return record.lifetime;
}

/** Admit work and report the delivery branch; only this actor knows whether a turn is live. */
function admitHostedTask(
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
): Effect.Effect<{ id: string; admitted: boolean } & SubordinateHandoff, KinuError> {
  const admitAs = async (actor: SeatedActor): Promise<{ id: string; admitted: boolean } & SubordinateHandoff> => {
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
    const log = new EventLog(seams.exec, actor.handle);
    const brief = log.query({ variant: 'subordinate_task', limit: 1 }).length === 0;

    // Admitted and owed to the agent as one: the row is the record, the delivery what opens its turn.
    const result = await seams.deliver(actor, () => {
      const admitted = admitSubordinateTask(log, admission);
      const delivery: Delivery | null = admitted.admitted ? assignmentDelivery(log, { id: admitted.id, body: input.body.trim(), mode: input.mode, from: seams.hirerName(actor) }) : null;

      return { value: admitted, delivery };
    });

    // The first work an agent is given is its brief: its stand-in title shows at once, before the turn that opens its
    // chat names it from the same words. A later message ("Continue") never titles it.
    if (result.admitted && brief && await titleActorFromMessage(actor.handle, input.body)) seams.announce(actor);

    return {
      ...result,
      ...describeSubordinateHandoff({
        admission: result,
        turnInFlight: busy,
        live: readSubordinateLiveStatus(seams.exec, actor.handle),
      }),
    };
  };

  return refusal(input.creationId !== undefined && input.creationId !== seams.directory.retained(reference.actorId)?.creationId,
    () => new KinuError('denied', 'The birth assignment belongs to a different actor creation.'))
    .pipe(Effect.andThen(Effect.promise(() => seams.host.run(reference, { kind: 'actor' }, admitAs))));
}

function hostedHirer(seams: HostedActorSeams, child: BoundActor): BoundActor {
  const parent = registeredParent(seams.host, child.record, {
    orphan: 'The workspace main actor was not hired by anyone.',
    unregistered: 'The hiring actor is no longer registered.',
  });

  // Its stores alone: neither its queue (it may wait on this child's) nor its seat, which its rest releases mid-relay.
  return seams.host.bindStores(parent);
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
  child: SeatedActor,
  turn: { readonly turnId: string; readonly workMode: WorkMode },
): Promise<void> {
  new EventLog(seams.exec, child.handle).dismiss(turn.turnId, 'stalled: cut off at one step too many times', 'system');

  const owed = await terminalTaskReport({
    lifetime: hostedLifetime(child.record),
    ending: 'recovered',
    assistantText: 'This task was cut off at the same step too many times by resets of the workspace (a platform memory or '
      + 'time limit), so it is not being run again. A reset may have come from other work in the workspace, not from this task.',
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
  /** The id its producer keyed it under (`announcementOf`), a programmatic turn's prefix stripped. */
  readonly sequenceId: string;
  /** The id the agent's own chat runs the turn under, when a chat prepared it: its execution's turn. */
  readonly chatTurnId?: string;
  /** The run answering it: a recovery continues it, a Retry starts another. */
  readonly runId?: string;
  readonly inheritedContext?: SubordinateInheritedContext;
  /** A hirer's turn carries `report`; an owner's chat with the actor does not. */
  readonly parentDriven: boolean;
  readonly driving: JsonObject | undefined;
  readonly opening?: TurnOpening;
  readonly taskPlan?: TaskPlan;
  readonly explicitTier?: TierId;
  /** Whether a plan of the agent's, sent back with comments, awaits its answers, as its isolate read it. */
  readonly awaitsReply: boolean;
  readonly run?: { readonly input: HeadInput; readonly inference: RunInference };
  /** A recovered execution's authority, which its surface is built on (D5). */
  readonly frozen?: FrozenAuthority;
}

export interface PreparedHostedTurn {
  readonly actor: SeatedActor;
  readonly input: HeadInput;
  readonly model: string;
  readonly surface: ActorSurface;
  readonly birthContext: readonly ModelMessage[];
}

export function prepareHostedTurn(
  seams: HostedActorSeams,
  reference: ActorReference,
  task: HostedTurnRequest,
): Promise<PreparedHostedTurn> {
  return settle(Effect.gen(function* () {
    const { run } = task;
    // A run's actor is its run's seat; a chat's, the seat it holds, which a run of its may have taken.
    const seated = run?.inference.actor ?? seams.host.hosted(reference) ?? (yield* Effect.promise(() => seams.host.acquire(reference, { kind: 'actor' })));
    // A run's actor is seated here, over a runtime of this backend's.
    const actor: CFSeat = { ...seated, runtime: yield* cfRuntimeOf(seated, 'a hosted agent') };
    const turnId = task.chatTurnId ?? task.sequenceId;

    const surface = yield* Effect.promise(() => seams.surface(actor, {
      key: { actorId: actor.handle.actorId, turnId, runId: task.runId ?? run?.inference.runId ?? turnId },
      lane: {
        authorship: task.parentDriven ? 'hirer' : 'owner', mode: task.mode, parentDriven: task.parentDriven, awaitsReply: task.awaitsReply,
        ...(task.driving !== undefined && { driving: task.driving }),
        ...(task.opening !== undefined && { opening: task.opening }),
        ...(task.taskPlan !== undefined && { taskPlan: task.taskPlan }),
        ...(task.explicitTier !== undefined && { explicitTier: task.explicitTier }),
      },
      text: task.body,
      ...(run !== undefined && { run: { tools: run.inference.tools, sources: run.inference.sources, capture: run.inference.capture } }),
      ...(task.frozen !== undefined && { frozen: task.frozen }),
    }));

    const input = run?.input ?? delegatedHeadInput(actor.record, task);
    const model = input.model ?? surface.resolved.profile.tier.model;

    yield* Effect.promise(() => seams.priceAs(model));

    return { actor, input, model, surface, birthContext: run === undefined ? input.inheritedContext.map(inheritedAsModelMessage) : [] };
  }));
}

/** The owner writing to an agent that waits on input answers that wait, as a message from its hirer does. The root
 *  agent has no hirer to wait on. */
export function ownerAnswersWait(seams: HostedActorSeams, actor: BoundActor): void {
  if (actorPolicy(actor.record).hirer === null) return;
  const hirer = hostedHirer(seams, actor);
  const roster = seams.roster(hirer);

  if (roster.get(actor.record.name)?.status !== 'awaiting_input') return;
  roster.resumeAfterMessage(actor.record.name);
  seams.announce(hirer);
}

/** The raw tools a turn of the hosted actor's own would hold in `mode`: a retry of its job runs on them, as it. */
export function hostedRetryTools(seams: HostedActorSeams, reference: ActorReference, mode: WorkMode, sequenceId: string): Promise<ToolSet> {
  return settle(Effect.gen(function* () {
    const actor = yield* Effect.promise(() => seams.host.acquire(reference, { kind: 'actor' }));

    const surface = yield* Effect.promise(() => seams.surface(actor, {
      key: { actorId: actor.handle.actorId, turnId: sequenceId, runId: sequenceId },
      lane: { authorship: 'hirer', mode, parentDriven: true, awaitsReply: false },
      text: '',
    }));

    return surface.raw;
  }));
}

/** The report a hosted turn's ending owes its hirer, as a CLI hire's relay decides it: the hirer's roster first,
 *  then a terminal answer, else a durable child's turn-end progress. A report the turn already settled suppresses it. */
export function hostedOwedReport(
  seams: HostedActorSeams,
  actor: BoundActor,
  turn: { readonly reports: SubordinateReportLedger; readonly ownerDriven: boolean; readonly taskId: string | null },
  ended: { readonly ending: TaskTurnEnding; readonly assistantText: string; readonly narration: readonly string[] },
): Promise<OwedReport | null> {
  return settle(Effect.gen(function* () {
    const hirer = hostedHirer(seams, actor);

    if (seams.roster(hirer).finishTurn(actor.record.name, ended.ending, Date.now())) seams.announce(hirer);

    return yield* Effect.promise(() => owedSubordinateTurnReport({
      lifetime: hostedLifetime(actor.record), ending: ended.ending, assistantText: ended.assistantText, narration: async () => ended.narration,
      reports: turn.reports, ownerDriven: turn.ownerDriven,
      delegating: taskAnswerIsLater({ roster: seams.roster(actor), log: new EventLog(seams.exec, actor.handle), ...(turn.taskId !== null && { turnTaskId: turn.taskId }) }),
    }));
  }));
}

/** A settled turn's report, relayed to the hirer's ingress, which dedupes on its sequence id; answers its disposition.
 *  It answers the assignment it is keyed on, in the relay's own commit; any other key names none. */
export async function hostedParentReport(
  seams: HostedActorSeams,
  actor: BoundActor,
  report: { readonly text: string; readonly status: SubordinateReportStatus; readonly mode: WorkMode; readonly sequenceId: string; readonly quiet?: true },
): Promise<string> {
  const relayed = await publishSubordinateReport({ mode: report.mode, reports: null }, {
    status: report.status, content: report.text, origin: 'turn_end', sequenceId: report.sequenceId,
    ...(report.quiet === true && { quiet: true }),
  }, (published) => relayHostedReport(seams, actor, { ...published, answers: report.sequenceId }));

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
      seams.host.run(reference, { kind: 'actor' }, (actor) => {
        actor.stores.config.setDisplayNameOrigin(input.displayName, input.nameOrigin);
        actor.stores.config.setRoleSelection(input.role);
        actor.stores.config.setAssignedTier(input.tier ?? null);

        return Promise.resolve();
      }))))),
    cancelBirth: (input) => settle(registerChild(input, 'cancelCreation')),
    assign: (name, input) => settle(resolve(name).pipe(Effect.flatMap((reference) => admitHostedTask(seams, reference, { kind: 'task' as const, ...input })))),
    status: (name) => settle(asHire(name, (reference) => seams.host.run(reference, { kind: 'actor' }, async (actor) =>
      readSubordinateLiveStatus(seams.exec, actor.handle)))),
    message: (name, content, mode) => settle(resolve(name).pipe(Effect.flatMap((reference) => admitHostedTask(seams, reference, { kind: 'message', body: content, mode })))),
    rename: (name, displayName, nameOrigin) => settle(asHire(name, (reference) => seams.host.run(reference, { kind: 'actor' }, async (actor) => {
      actor.stores.config.setDisplayNameOrigin(displayName, nameOrigin);
    }))),
    /** Wipe removes rows, home and state subtree; archive keeps them. */
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
      yield* Effect.promise(() => seams.host.retire(parent().reference, actorRetirementFor({ reference, name, keepHistory, interrupt })));

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
interface ExplorationActorRequest {
  readonly creationId: string;
  /** Absent lets `defaultLoopOrigin` stand (`inherit`). */
  readonly loop?: LoopOrigin;
}

interface ExplorationProfile {
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

/** Retire an exploration actor; its turn's claim is its own isolate's. */
async function retireExploration(
  seams: HostedActorSeams, reference: ActorReference, name: string,
): Promise<void> {
  const retirement = actorRetirementFor({ reference, name, keepHistory: true, interrupt: true });
  await seams.host.retire(registeredParent(seams.host, reference, {
    orphan: 'An exploration actor always has a parent.',
    unregistered: 'The exploration actor has no registered parent.',
  }), retirement);
}

/** A branching head, hosted on the one head runner. The actor is retired when `run()` settles. */
export async function hostHead(seams: HostedActorSeams, input: HeadInput): Promise<SpawnedHead> {
  const { reference, retire } = await hostRunActor(seams, { creationId: input.id, loop: input.loop });

  return spawnSeatedHead(input, {
    // The watch is named before the acquire that builds the runtime over it; a later one sees no writes.
    seat: async (_input, writes) => {
      const unwatch = seams.watchWrites(reference, writes);

      return await settle(Effect.map(runActorSeat(seams, reference, 'head'), (seat): HeadSeat => ({
        ...seat,
        queue: (body) => seams.host.run(reference, { kind: 'head' }, body),
        release: async () => {
          unwatch();
          await retire();
        },
      })));
    },
    codemodeTool: (seat) => settleSync(cfRuntimeOf(seat.actor, 'a hosted head').pipe(
      Effect.map((runtime) => seams.codemodeTool(seat.actor, runtime, seams.webSearch())),
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
function runActorSeat(seams: HostedActorSeams, reference: ActorReference, kind: 'head' | 'node'): Effect.Effect<HostedNodeSeat, KinuError> {
  return Effect.gen(function* () {
    const actor = yield* attempt({ doing: 'acquiring a hosted run actor', otherwise: 'io' }, () => seams.host.acquire(reference, { kind }));
    const sources = yield* Effect.promise(() => seams.sources(actor));

    return {
      actor,
      infer: (input: HeadInput, inference: RunInference) => seams.infer(reference, input, inference),
      runId: crypto.randomUUID(),
      // A run delegates nothing: its seat builds its tools, and its prompt offers none of its owner's.
      sources: { ...sources, agentsActions: () => [], temporaryAsk: () => false },
      conversations: seams.conversations(reference),
      jobs: seams.jobSeat(reference.actorId),
      receipts: seams.receipts(actor),
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

  return await settle(runActorSeat(seams, reference, 'node'));
}

/** A swarm node's `eval`, over the hosted actor the node runs as. */
export function nodeCodemodeTool(seams: HostedActorSeams, actor: SeatedActor): (finished: ToolSet, reach: ToolSurfaceNarrowing) => Tool {
  return settleSync(cfRuntimeOf(actor, 'a swarm node').pipe(Effect.map((runtime) => seams.codemodeTool(actor, runtime, seams.webSearch()))));
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
