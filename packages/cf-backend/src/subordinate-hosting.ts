/**
 * A HIRED SUBORDINATE and an ASK-BY-ROLE TEMPORARY as hosted logical actors.
 *
 * WHAT WENT AWAY WITH THE FACET. A subordinate used to be a Durable Object of
 * its own, which is why the shape of everything here used to be an RPC:
 *
 *   • `setSubordinateIdentity` pushed a seed the child persisted into its OWN
 *     `actor_identity` row, and every accessor on the child re-read that row to
 *     learn its own name, mission, depth, lifetime and owner. The seed had to be
 *     validated against `getSubordinateBootstrapIdentity` on the parent, because
 *     the child's copy could disagree with the roster. There is one row now —
 *     the `workspace_actors` row, read through the directory — so the seed, the
 *     bootstrap RPC, the immutability check and the mismatch refusals all go.
 *   • `enqueueSubordinateTask` was an RPC that admitted work into the child's
 *     private event log. The child's event log is now `actor_id`-scoped in the
 *     workspace's one database, so admission is a call.
 *   • `receiveSubordinateEvent` was an RPC BACK to whoever hired the child,
 *     with a `sequenceId` dedupe key so a replayed report was recognised as the
 *     one the parent already held. The dedupe stays — a replay is still a
 *     replay — but the hop does not.
 *   • `parentActor()` walked `parentPath` and resolved a stub per hop, refusing
 *     when a class name did not match. Lineage is `workspace_actors.parent_actor_id`
 *     and the directory answers it; a class name was never an identity.
 *
 * WHAT STAYED, because none of it was about storage: the delegation depth cap
 * (the number a child would have to lie about is still one it never supplies —
 * it comes from the directory, not from its arguments), the lifetime split
 * between a `durable` hire and a `task` ask, the terminal report policy
 * (`terminalTaskReport` / `subordinateRelaysTurnEnd` / `temporaryRunSettles`
 * are core's closed decisions and are asked here exactly as before), and the
 * rule that only a run-SETTLING report answers an `agents.ask` while a progress
 * note leaves the caller waiting.
 *
 * ONE PROMOTED LOOP. A delegated task runs through the same claimed-turn runner
 * a head and a node run through: `runHeadInference` over the subordinate's own
 * `HostedActor`, so the turn is admitted under that actor's pinned program
 * version and digest, gets the per-step context plane, and is resumable from
 * its durable claim after an eviction. That is what open-41 asks for — the
 * subordinate's turn stops being a second inference loop that happened to agree
 * with the others.
 */

import { REAL_CLOCK, type HeadReport, type ObserveStream } from '@kinu.run/core';
import type { LanguageModel, ToolSet } from 'ai';
import {
  EventLog, HeadCapture, runHeadInference, titleActorFromMessage,
  admitSubordinateTask, describeSubordinateHandoff, readSubordinateLiveStatus,
  receiveSubordinateEvent, subordinateRelaysTurnEnd, temporaryRunSettles,
  subordinateForkContext, type SubordinateInheritedContext,
  inheritedAsModelMessage,
  classifyRunEnd, closeTurnRun, openTurnRun,
  terminalTaskReport, defaultLoopOrigin, delegationBudgetOf, delegationExhausted,
  type ActorHost, type ActorReference, type AssignedTurnFraming, type BoundActor,
  type DelegationBudget,
  type DynamicContext, type HeadInferenceDeps, type HeadInput, type HostedActor, type ResolvedTurnProfile,
  type MissionScope,
  type SqlExec, type SqlExecutor, type SubordinateEventResult, type SubordinateHandoff,
  type SubordinateLifetime, type SubordinateReportOrigin,
  type SubordinateReportHandoff,
  type SubordinateReportStatus, type SubordinateRosterStore, type SubordinateRuntime,
  type SubordinateSeed, type TaskTurnEnding, type TemporaryAgentPort, type VFS,
  type WorkMode, type WorkspaceActor, type WorkspaceActorDirectory,
} from '@kinu.run/core';
import { diagnostics, KinuError, toKinuError } from '@kinu.run/core/obs';
import { isCFRuntime, type CFRuntime } from './runtime';
import { actorRetirementFor, type ActorRetirementRequest } from './actor-hosting';
import type { ExplorationProfile } from './exploration-hosting';

/**
 * WHAT A CHILD SAID THIS TURN, as two bits that are genuinely different
 * questions.
 *
 * Conflating them hung an ask, and the bug is worth naming because the fix is
 * this shape: a task child is invited to file a mid-task `progress` note, that
 * note means it SPOKE, and `temporaryRunSettles` correctly does not treat it as
 * the answer — so a child that filed one and then answered had its terminal
 * report suppressed while its caller waited forever. `spoke` is what the
 * DURABLE relay policy asks ("has this actor already said something worth
 * relaying"); `settled` is what the TEMPORARY rung asks ("has it already
 * answered"). The root's `report` tool writes both.
 */
export interface HostedReportLedger {
  spoke: boolean;
  settled: boolean;
}

/**
 * ONE DELEGATED TURN, as everything that is decided before it runs.
 *
 * Assembled once by {@link runHostedTask} and handed whole to the tool
 * builder, because every member of it is a decision the turn must not make
 * twice: the turn is CLAIMED under `input` and TOOLED from it, `model` and
 * `profile` are the one resolution this turn ran under — a second lookup can
 * land a different provider revision and a different digest from the claim —
 * `reports` is the ledger the `report` lane writes while the loop runs and the
 * relay reads after it, and `capture` is the run's one findings accumulator,
 * whose snapshot IS the report the caller gets back.
 */
export interface HostedTaskTurn {
  /** The hosted actor whose turn this is. Its handle keys every effect claim
   *  and every store the surface reaches. */
  readonly actor: HostedActor;
  /** That actor's runtime, narrowed to this backend's own. */
  readonly runtime: CFRuntime;
  readonly reports: HostedReportLedger;
  readonly input: HeadInput;
  readonly capture: HeadCapture;
  /** The model this turn reasons with, already bound. */
  readonly model: LanguageModel;
  /** The profile this turn resolved under, with the authority inputs beside
   *  it — what the delegation rungs narrow by and what the claim recorded. */
  readonly profile: ExplorationProfile;
}

/**
 * THE MODEL-FACING PROFILE of one delegated turn: what it can call, and what it
 * is told it is.
 *
 * The two are answered together because they are one decision seen twice: the
 * prompt's tool index and delegation rungs are RENDERED FROM the surface that
 * was built, so a builder that returned only the tools left its caller to
 * re-derive the prompt from something else — which is how a prompt comes to
 * advertise a tool the turn does not hold.
 */
export interface HostedTaskProfile {
  readonly tools: ToolSet;
  /** The framing, from core's one assigned-turn definition. */
  readonly framing: AssignedTurnFraming;
}

/** What the root lends the subordinate rung. Deliberately the same host and
 *  directory the exploration rung uses: there is one actor host per workspace
 *  and every kind is acquired from it. */
export interface SubordinateHostSeams {
  readonly host: ActorHost;
  readonly sql: SqlExecutor;
  /** The POSITIONAL executor for the same database. The event log takes this
   *  port, not the tagged-template one: same database, two ports, neither
   *  interchangeable. */
  readonly exec: SqlExec;
  readonly directory: WorkspaceActorDirectory;
  transaction<Result>(body: () => Result): Result;
  /** This actor's own roster of the children IT hired. Scoped to the actor, so
   *  a subordinate manages its own subtree and never the workspace's. */
  roster(actor: BoundActor): SubordinateRosterStore;
  /** The workspace file plane, for the report ingress's attachment check. */
  vfs(): VFS;
  /** THE profile authority a delegated turn resolves through — the same one an
   *  actor chat uses, so a role restriction narrows a hire's turn identically. */
  profile(input: {
    readonly actor: HostedActor;
    readonly availableTools: readonly string[];
    readonly workMode: WorkMode;
  }): Promise<ExplorationProfile>;
  resolveModel(spec: string): LanguageModel;
  /** The workspace's naming round-trip — the same prompt, model route and
   *  spend label the root's own auto-title uses. A hosted actor's title is not
   *  a second naming policy; it is this one, asked on that actor's behalf. */
  suggestTitle(mission: string): Promise<string | null>;
  /** What this hosted actor's delegated turn may call and what it is told it
   *  is, built over {@link HostedTaskTurn} — the whole turn, because the
   *  profile is a function of every part of it and a builder that took only
   *  some would resolve the rest a second time. */
  taskProfile(turn: HostedTaskTurn): Promise<HostedTaskProfile>;
  /** The per-step live plane the turn reports. */
  dynamic(actor: HostedActor, profile: ResolvedTurnProfile, tools: ToolSet): DynamicContext;
  /** The mission ledger a delegated turn charges, or null. */
  mission(actor: HostedActor): MissionScope | null;
  /** Announce a roster change to whoever is watching this actor's pane. */
  announce(actor: BoundActor): void;
  /** Ask this actor's own orchestration to drain its event log — a REACTION
   *  arrived (a report from one of its own children). Never for an assignment:
   *  `wakesADrain` excludes that variant, so the reactor would select nothing
   *  and the row's real runner is the durable wake below. */
  scheduleDrain(actor: HostedActor): void;
  /** Arm the wake whose frame RUNS this assignment, because one was just
   *  admitted. The row's runner is `drainAdmittedDelegations` and nothing in
   *  the admitting request may run it, so the implementation has to arm the
   *  chain that reaches that sweep — a backend with more than one wake chain
   *  cannot answer this with "re-derive the soonest wake". */
  armWake(): void;
  /** The temporary rung's waiter register, which lives on the PARENT: `ask`
   *  parks a waiter and the report ingress resolves it, and those are two
   *  different calls on one isolate. */
  temporary(actor: BoundActor): TemporaryAgentPort;
}

/** This child's own room in the tree, from the ONE row that states it — core's
 *  walk over this workspace's directory. */
export function hostedDelegationBudget(
  seams: Pick<SubordinateHostSeams, 'host'>, actor: BoundActor,
): DelegationBudget {
  return delegationBudgetOf((actorId) => seams.host.describe(actorId), actor.record);
}

/**
 * THE delegated turn's `HeadInput`, built once.
 *
 * One builder because a turn is CLAIMED under this shape and TOOLED under it,
 * and recovery verifies the claim: two literals for one turn is how a turn ends
 * up claimed under one shape and tooled under another, at which point arm 1 of
 * the activation sweep can no longer recognise what arm 2 admitted. So the
 * runner's `input` and `taskTools`' surface consume the SAME value.
 *
 * `maxDepth: 0` is the containment, not a default: a delegated task delegates
 * through `hire`/`ask` under its own depth cap — which is `budget`, off the
 * directory row — and never by splitting itself into heads it did not budget
 * for. `loop` is stated rather than defaulted because a delegated turn's origin
 * is a decision: a hire starts BUILTIN, since it is a new colleague with its
 * own role and inheriting a program tuned for someone else's role is the
 * misevolution the loop gate exists to prevent.
 *
 * NO `DelegationBudget` PARAMETER, deliberately, against the signature that was
 * proposed for this: the delegation cap governs how many further actors this
 * child may HIRE, which `hostedDelegationBudget` answers off the directory row
 * at the spawn site. `HeadInput.budget` is a `HeadBudget` — the SPLIT budget —
 * and passing the hire cap into it would put one cap in the other's field. The
 * two are different limits on different verbs, and the only honest way to build
 * this from both would be to take a value it then ignores.
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

/** This child's lifetime, off its immutable directory row. */
function hostedLifetime(record: WorkspaceActor): SubordinateLifetime {
  return record.lifetime;
}

/**
 * The parent that hired this actor, as a reference.
 *
 * Past depth 1 the parent is NOT the workspace, and using the workspace as one
 * is what sent a nested subordinate's reports to the orchestrator instead of to
 * whoever asked for the work. The directory row is the only authority.
 */
function hiringParent(seams: SubordinateHostSeams, record: WorkspaceActor): ActorReference {
  const parentId = record.parentActorId;

  if (parentId === null) throw new KinuError('denied', 'The workspace main actor was not hired by anyone.');
  const parent = seams.host.describe(parentId);

  if (parent === null) throw new KinuError('missing', 'The hiring actor is no longer registered.');

  return { actorId: parent.actorId, workspaceId: parent.workspaceId, parentActorId: parent.parentActorId };
}

/**
 * Admit work from the parent and tell it what happened to it.
 *
 * The delivery branch is decided HERE and not guessed by the caller, exactly as
 * it was on the facet: this is the only place that knows whether a turn is live
 * on this actor right now. Delegated work keeps its trusted Plan/Build mode and
 * therefore queues as its own turn when the actor is busy.
 */
export async function admitHostedTask(
  seams: SubordinateHostSeams,
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
  return await seams.host.run(reference, async (actor) => {
    if (input.creationId !== undefined && input.creationId !== actor.record.creationId) {
      throw new KinuError('denied', 'The birth assignment belongs to a different actor creation.');
    }

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

    // A hosted actor has no chat session, so no `auto_title` effect exists —
    // the first admitted message lands its PROVISIONAL title here instead, and
    // a landed title is announced so the parent's roster stops showing the
    // codename. The model that turns that stand-in into a name runs at the end
    // of the turn this admission hands over (`runHostedTask`): a model call
    // inside the admitting request would delay the handoff it exists to make.
    if (result.admitted && input.kind === 'message' && await titleActorFromMessage(actor.handle, input.body)) {
      seams.announce(actor);
    }

    // THE WAKE, not the child's reactor. This used to call `scheduleDrain` on
    // the actor it had just written to, and both halves of that were wrong once
    // the assignment stopped being a reaction: the debounced drain selects
    // `wakesADrain` rows and an assignment is not one, so it fired a drain that
    // could only find nothing. What admission genuinely owes is the arm on the
    // chain that RUNS the row — `drainAdmittedDelegations`, in the frame
    // `armWake` names — and nothing in this request may run it.
    if (result.admitted) seams.armWake();

    return {
      ...result,
      ...describeSubordinateHandoff({
        admission: result,
        turnInFlight: busy,
        live: readSubordinateLiveStatus(seams.exec, actor.handle),
      }),
    };
  });
}

/**
 * The report a child owes its hiring parent, delivered in-process.
 *
 * `sequenceId` still travels and is still the ingress DEDUPE KEY: a report
 * replayed by a recovered terminal sequence is the one the parent already
 * holds, not a second piece of progress. What changed is only that the parent's
 * ingress is a call on the parent actor's own orchestration rather than a
 * cross-Durable-Object RPC — so the "replayable because the parent dedupes"
 * property is unchanged and the failure mode it defended against (a lost report
 * with nowhere to go) is gone.
 */
export async function relayHostedReport(
  seams: SubordinateHostSeams,
  child: HostedActor,
  report: {
    readonly status: SubordinateReportStatus;
    readonly content: string;
    readonly origin: SubordinateReportOrigin;
    readonly mode: WorkMode;
    readonly sequenceId: string;
    /** The `report` tool's structured handoff. Absent on the automatic
     *  turn-end relay, which has only the assistant's closing prose. */
    readonly handoff?: SubordinateReportHandoff;
  },
): Promise<SubordinateEventResult> {
  const parent = hiringParent(seams, child.record);
  const name = child.record.name;

  return await seams.host.run(parent, async (hirer) => receiveSubordinateEvent({
    log: new EventLog(seams.exec, hirer.handle),
    roster: seams.roster(hirer),
    vfs: seams.vfs(),
    transaction: (body) => seams.transaction(body),
    announce: () => { seams.announce(hirer); },
    onAdmitted: () => { seams.scheduleDrain(hirer); },
    // A temporary child's answer belongs to the `agents.ask` waiting on it, so
    // the register gets first refusal on the name — through the very port that
    // parked the waiter.
    temporary: seams.temporary(hirer),
  }, { fromSubordinate: name, ...report }, Date.now()));
}

/**
 * ONE DELEGATED TURN on a hosted subordinate, as a claimed turn.
 *
 * `runHeadInference` is the common runner: it admits the turn on
 * `actor.session`, pins the program version and digest into the claim, runs the
 * loop with the per-step context plane, and settles. A delegated task is
 * precisely the agent this runner was written for — one that reports rather
 * than chats — so this is not a subordinate-shaped copy of the loop, it is the
 * loop.
 *
 * The report is decided from the ENDING, by core's closed map, and relayed to
 * the hiring parent afterwards. A `task` child owes its caller a terminal
 * answer on EVERY ending, because an `agents.ask` is blocked on it: a child that
 * returns without one goes quiet and the caller never comes back. A `durable`
 * child relays only a completed turn worth relaying. Both are suppressed by a
 * report that already SETTLED the run — a progress note leaves the caller
 * waiting and therefore leaves the answer owed, while a second settling
 * message would reach it as a second result for one question.
 */
export interface HostedTaskResult {
  readonly text: string;
  readonly relayed: SubordinateEventResult | null;
  readonly canonicalCompletion: HeadReport['canonicalCompletion'];
}

/** How the runner's report status reads as an ending to the hiring parent.
 *  Only a completed turn answered; an abort is an interruption the caller may
 *  resume; a spent budget and a thrown turn are both a turn that failed. */
const TASK_TURN_ENDING: Readonly<Record<HeadReport['status'], TaskTurnEnding>> = {
  completed: 'answered',
  aborted: 'interrupted',
  budget_exceeded: 'errored',
  errored: 'errored',
};

export async function runHostedTask(
  seams: SubordinateHostSeams,
  reference: ActorReference,
  task: {
    readonly body: string;
    readonly mode: WorkMode;
    readonly sequenceId: string;
    readonly inheritedContext?: SubordinateInheritedContext;
  },
  observeStream?: ObserveStream,
): Promise<HostedTaskResult> {
  return await seams.host.run(reference, async (actor) => {
    // This runtime is the one `ActorHostDeps.runtimeFor` built, which on this
    // backend IS `createCFRuntime`. The core seam declares the RETURN type as
    // `AgentRuntime` and does not narrow the value, so the cf members this
    // delegated turn reaches are asked for here. Teaching core the backend's
    // own runtime shape to satisfy a cf read is the wrong direction.
    const runtime = actor.runtime;

    if (!isCFRuntime(runtime)) {
      throw new KinuError('unsupported', 'a hosted subordinate must run on the cf runtime');
    }

    const reports: HostedReportLedger = { spoke: false, settled: false };
    const resolved = await seams.profile({ actor, availableTools: [], workMode: task.mode });
    const mission = seams.mission(actor);
    // BUILT HERE, ONCE, and handed to both the runner and the tool surface. The
    // turn is claimed under this value and recovery verifies that claim, so the
    // caller does not supply it: a caller-supplied `HeadInput` is a second shape
    // that can disagree with the one the tools were built from.
    const input = delegatedHeadInput(actor.record, task);
    // THE RUN'S ONE FINDINGS ACCUMULATOR, built here beside the input and for
    // the same reason: the tools write it while the turn runs and
    // `runHeadInference` reads it into the report this call returns, so a
    // second instance is a working record nothing reads. With two, a delegated
    // turn's decisions, evidence, artifacts and tool calls all landed in the
    // tool surface's own copy, and the report came back with none of them —
    // which the caller sees as an answer synthesised from nothing when the
    // turn produced no closing prose.
    const capture = new HeadCapture();

    // THE TURN, assembled once. Every member is a decision already made above,
    // and the tool builder gets all of them rather than resolving any again:
    // the model and the profile in particular are this turn's own resolution,
    // which the claim recorded.
    const turn: HostedTaskTurn = {
      actor, runtime, reports, input, capture,
      model: seams.resolveModel(resolved.profile.tier.model),
      profile: resolved,
    };

    // WHAT THIS TURN MAY CALL AND WHAT IT IS TOLD IT IS, asked once. Without
    // the framing the shared runner falls to its own default, which is a
    // FORK's: a hire would be told it is one of several parallel reasoning
    // threads whose findings a merge will combine, none of which is true of an
    // actor working the brief its hirer wrote.
    const profile = await seams.taskProfile(turn);

    // Annotated with the NAMED interface and assembled in statements: `mission`
    // is added only when this turn is budgeted, so an UNBUDGETED turn carries no
    // key at all rather than a spread of nothing. Absent and present are
    // different instructions to the runner — a mission it cannot see is a turn
    // that charges nothing — and a conditional spread hides which one this is.
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
      // Cancellation is the session's. A delegated turn is not cancelled by the
      // parent hanging up, by a socket closing or by an eviction: an interrupted
      // turn leaves its claim unsettled, which is the record that work is owed.
      isAborted: () => false,
      profile: (request) => seams.profile({ actor, ...request }),
      dynamic: (resolvedProfile, tools) => seams.dynamic(actor, resolvedProfile, tools),
    };

    if (mission !== null) inference.mission = mission;

    if (observeStream !== undefined) inference.observeStream = observeStream;

    // THE RUN'S DURABLE BRACKET, and it is the LOCAL host's rule adopted here
    // rather than a cf invention: on the CLI an assignment is admitted as the
    // child's own turn, so `ChatSession.processTurn` opens and closes its run
    // (`openTurnRun`, caused by `subordinate_task`) and the child's `runs` view
    // names what it was asked and how it ended. This runner drives
    // `runHeadInference` directly, which never enters that queue, so the same
    // delegated turn wrote `model_call` and `step_finish` rows under a run id
    // with NO `run_start` and no `run_end` — measured 2026-09-17 in the workerd
    // pool: one hire produced a child ledger of `step_finish` alone. Every
    // reader of that plane then reads the run as causeless: `getRunSummaries`
    // folds `run_start` for the cause and the input and `run_end` for the
    // status, and `subordinateInspection`'s `runs` view is exactly that read on
    // a hired child. Same `caused_by` and same `userMessage` as the local host
    // writes, so one delegated turn is one shape of row on both backends.
    //
    // A run left open by a THROWN runner stays open on purpose: that is what an
    // unterminated run means, the assignment's own lease stays open beside it,
    // and the retry opens a new run rather than re-closing this one.
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

    // THE HOSTED ACTOR'S TITLE UPGRADE, and the counterpart of the provisional
    // one `admitHostedTask` landed. The root gets this from its `auto_title`
    // terminal effect; a hosted actor has no chat session and therefore no such
    // effect, so without this it kept the truncated first line of its brief as
    // its permanent name — half of what #18 reported. Here rather than at
    // admission because admission may not spend a model call, and after the run
    // rather than before it so the turn the caller is waiting on is never held
    // behind a naming call.
    //
    // One condition, handled: a titling model that failed. The provisional
    // title is already shown by then, the next admitted message plans again,
    // and a hired actor's turn is not failed over its own name.
    try {
      const titled = await titleActorFromMessage(actor.handle, task.body, (brief) => seams.suggestTitle(brief));

      if (titled) seams.announce(actor);
    } catch (cause) {
      diagnostics.failure('agent.auto_title_suggestion_failed', toKinuError({
        doing: 'deriving a hosted actor title from its brief', cause, otherwise: 'unavailable',
      }), { workspace: actor.record.workspaceId });
    }

    const ending: TaskTurnEnding = TASK_TURN_ENDING[report.status];

    const owed = reports.settled
      ? null
      : terminalTaskReport({ lifetime: hostedLifetime(actor.record), ending, assistantText: report.summary });

    const relayed = owed ?? (
      ending === 'answered' && subordinateRelaysTurnEnd({
        reportedThisTurn: reports.spoke, ownerDriven: false, assistantText: report.summary,
      })
        ? { status: 'progress' as const, content: report.summary }
        : null
    );

    if (relayed === null) return { text: report.summary, relayed: null, canonicalCompletion: report.canonicalCompletion };

    return {
      text: report.summary,
      canonicalCompletion: report.canonicalCompletion,
      relayed: await relayHostedReport(seams, actor, {
        status: relayed.status, content: relayed.content, origin: 'turn_end',
        mode: task.mode, sequenceId: task.sequenceId,
      }),
    };
  });
}

/**
 * THE child substrate of one actor: how a subordinate is born, addressed and
 * retired now that it is a logical actor.
 *
 * Every verb is a call on the workspace's ONE host. `spawn` is the shape that
 * changed most and shrank most: it used to register the actor, resolve a facet
 * stub, push a seed, verify the seed against a bootstrap RPC, and — on any
 * failure — delete the half-seeded facet's storage and report a reclamation
 * failure louder than the seeding one, because a swallowed cleanup left a
 * permanent database inside the root charged against a shared quota. There is
 * no half-seeded state to clean up: `host.acquire` binds a registered row and
 * seeds the loop, or it refuses and the row is cancelled.
 */
export function hostedSubordinateRuntime(
  seams: SubordinateHostSeams,
  parent: () => BoundActor,
): SubordinateRuntime {
  const registerChild = async (
    input: SubordinateSeed & { creationId: string },
    action: 'register' | 'cancelCreation',
  ): Promise<ActorReference> => {
    const owner = parent();
    const budget = hostedDelegationBudget(seams, owner);

    if (action === 'register' && delegationExhausted(budget)) {
      throw new KinuError('denied', 'This actor cannot create a subordinate below its delegation depth.');
    }

    const entry = seams.directory.apply(owner.reference, seams.directory.storagePath(owner.reference), {
      action, name: input.name, creationId: input.creationId, kind: 'subordinate', lifetime: input.lifetime,
    });

    return entry.reference;
  };

  const resolve = (name: string): ActorReference => {
    const owner = parent();

    const entry = seams.directory.apply(owner.reference, seams.directory.storagePath(owner.reference), {
      action: 'resolve', name,
    });

    if (entry.kind !== 'subordinate') throw new KinuError('denied', 'The roster name does not identify a subordinate.');

    return entry.reference;
  };

  return {
    spawn: async (input) => {
      const reference = await registerChild(input, 'register');
      // A hire starts on the BUILTIN loop: it is a new colleague with its own
      // role, and inheriting a program tuned for someone else's role is the
      // misevolution the promotion gate exists to prevent. Named explicitly
      // rather than left to the default so the decision is at the call site.
      // The child's own naming, role and tier, written to ITS config rows. The
      // roster row on the parent — the name, the mission, the birth state — is
      // core's to write (`createTeamToolDeps`), and this deliberately does not
      // duplicate it: one writer per fact is what stopped a rename landing on
      // one side and not the other.
      await seams.host.run(reference, (actor) => {
        actor.stores.config.setDisplayNameOrigin(input.displayName, input.nameOrigin);
        actor.stores.config.setRoleSelection(input.role);
        actor.stores.config.setAssignedTier(input.tier ?? null);

        return Promise.resolve();
      });

      return reference;
    },
    cancelBirth: (input) => registerChild(input, 'cancelCreation'),
    assign: async (name, input) => {
      const task = { kind: 'task' as const, ...input };

      return await admitHostedTask(seams, resolve(name), task);
    },
    status: async (name) => await seams.host.run(resolve(name), async (actor) =>
      readSubordinateLiveStatus(seams.exec, actor.handle)),
    message: (name, content, mode) => admitHostedTask(seams, resolve(name), { kind: 'message', body: content, mode }),
    rename: async (name, displayName, nameOrigin) => {
      await seams.host.run(resolve(name), async (actor) => {
        actor.stores.config.setDisplayNameOrigin(displayName, nameOrigin);
      });
    },
    /**
     * A wipe takes the rows, the home and the state subtree; an archive keeps
     * all three, because an archived subordinate's history stays readable and so
     * does its tree. `observed` travels when this actor was mid-turn, so the
     * host settles that claim instead of leaving a turn nobody named an outcome
     * for.
     */
    dismiss: async (name, keepHistory, reference) => {
      const live = seams.host.hosted(reference);
      const claim = live === null ? null : live.session.turnClaim;
      // `observed` is added only when a live claim was actually SEEN. Absent
      // means "this caller saw no turn", which is what lets the host settle
      // rather than guess; a spread of nothing reads as the same thing and is
      // not, because the host's refusal depends on which it was told.
      const request: ActorRetirementRequest = { reference, name, keepHistory };

      if (claim !== null) request.observed = { turnId: claim.turnId, epoch: claim.epoch };
      await seams.host.retire(parent().reference, actorRetirementFor(request));
    },
  };
}

/**
 * The temporary's SEED and the delegated loop ORIGIN both used to be stated
 * here. Both are core's now, and both were checked rather than assumed:
 *
 *   • the seed is built by `createTemporaryAgentPort` itself
 *     (`subordinates/temporary.ts`), which takes this backend's `createName`
 *     and assembles `{ displayName: '', nameOrigin: 'auto', role, mission,
 *     lifetime: TEMPORARY_LIFETIME }` plus a fresh creation id. This file's
 *     copy was a second assembly of the same record, and the temporary rung is
 *     already wired to that port.
 *   • the origin is `defaultLoopOrigin('subordinate')` — BUILTIN, because a
 *     hire is a new colleague whose role is its own. Nothing here overrode it:
 *     `registerChild` names no origin, so `loopFor` reaches core's per-kind
 *     default, and `delegatedHeadInput` states the same call for the turn.
 *
 * Neither was an unreached PRODUCER — the distinction that mattered for
 * `runHostedTask` and `announceSubordinatePlan`, whose implementations were the
 * only ones and whose callers had gone. These two had a live implementation
 * elsewhere, so a copy here was only a second chance to disagree.
 */

/** Whether a report SETTLES the run an `agents.ask` is blocked on. Core's
 *  predicate, asked at the one place a hosted child's report is admitted, so
 *  the child cannot come to believe it has answered while its caller waits. */
export function reportSettlesRun(status: SubordinateReportStatus, origin: SubordinateReportOrigin): boolean {
  return temporaryRunSettles({ status, origin });
}
