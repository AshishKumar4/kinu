/**
 * Hired subordinates and ask-by-role temporaries as hosted logical actors. Identity and lineage come
 * from the `workspace_actors` directory row; a delegated turn runs through `runHeadInference` over the
 * actor's own `HostedActor` (open-41), so it is claimed, pinned, and resumable after eviction.
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
  terminalTaskReport, defaultLoopOrigin, delegationBudgetOf, delegationExhausted, CHAT_SESSION_ID,
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

/** The same actor host and directory the exploration rung uses: one host per workspace. */
export interface SubordinateHostSeams {
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
  /** The root's own auto-title round-trip, asked on the hosted actor's behalf. */
  suggestTitle(mission: string): Promise<string | null>;
  taskProfile(turn: HostedTaskTurn): Promise<HostedTaskProfile>;
  dynamic(actor: HostedActor, profile: ResolvedTurnProfile, tools: ToolSet): DynamicContext;
  mission(actor: HostedActor): MissionScope | null;
  announce(actor: BoundActor): void;
  /** Drain on a reaction (a child's report). Never for an assignment: `wakesADrain` excludes it. */
  scheduleDrain(actor: HostedActor): void;
  /** Arm the wake chain that reaches `drainAdmittedDelegations`; the admitting request must not run it. */
  armWake(): void;
  /** Lives on the parent: `ask` parks a waiter and the report ingress resolves it. */
  temporary(actor: BoundActor): TemporaryAgentPort;
}

export function hostedDelegationBudget(
  seams: Pick<SubordinateHostSeams, 'host'>, actor: BoundActor,
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

function hostedLifetime(record: WorkspaceActor): SubordinateLifetime {
  return record.lifetime;
}

/** The hiring parent from the directory row; past depth 1 it is not the workspace. */
function hiringParent(seams: SubordinateHostSeams, record: WorkspaceActor): ActorReference {
  const parentId = record.parentActorId;

  if (parentId === null) throw new KinuError('denied', 'The workspace main actor was not hired by anyone.');
  const parent = seams.host.describe(parentId);

  if (parent === null) throw new KinuError('missing', 'The hiring actor is no longer registered.');

  return { actorId: parent.actorId, workspaceId: parent.workspaceId, parentActorId: parent.parentActorId };
}

/** Admit work and report the delivery branch; only this actor knows whether a turn is live. */
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
  });
}

/** A child's report to its hiring parent, in-process; `sequenceId` remains the ingress dedupe key. */
export async function relayHostedReport(
  seams: SubordinateHostSeams,
  child: HostedActor,
  report: {
    readonly status: SubordinateReportStatus;
    readonly content: string;
    readonly origin: SubordinateReportOrigin;
    readonly mode: WorkMode;
    readonly sequenceId: string;
    /** Absent on the automatic turn-end relay. */
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
    // A temporary child's answer goes first to the `agents.ask` waiter, via the port that parked it.
    temporary: seams.temporary(hirer),
  }, { fromSubordinate: name, ...report }, Date.now()));
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
  seams: SubordinateHostSeams,
  reference: ActorReference,
  task: {
    readonly body: string;
    readonly mode: WorkMode;
    readonly sequenceId: string;
    readonly inheritedContext?: SubordinateInheritedContext;
  },
  chat?: HostedChatSink,
): Promise<HostedTaskResult> {
  return await seams.host.run(reference, async (actor) => {
    // `ActorHostDeps.runtimeFor` is `createCFRuntime` here, but core types it `AgentRuntime`; narrow locally.
    const runtime = actor.runtime;

    if (!isCFRuntime(runtime)) {
      throw new KinuError('unsupported', 'a hosted subordinate must run on the cf runtime');
    }

    const reports: HostedReportLedger = { spoke: false, settled: false };
    const resolved = await seams.profile({ actor, availableTools: [], workMode: task.mode });
    const mission = seams.mission(actor);
    // Built once for both runner and tools: recovery verifies the claim against it.
    const input = delegatedHeadInput(actor.record, task);
    // One findings accumulator: the tools write it and `runHeadInference` reports from it; a second
    // copy returned reports with no findings.
    const capture = new HeadCapture();

    const turn: HostedTaskTurn = {
      actor, runtime, reports, input, capture,
      model: seams.resolveModel(resolved.profile.tier.model),
      profile: resolved,
    };

    // Without this framing the runner defaults to a fork's, telling a hire it is a parallel thread.
    const profile = await seams.taskProfile(turn);

    // `mission` is set only when budgeted: absent and present are different instructions to the runner.
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

    if (mission !== null) inference.mission = mission;

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

    // Title upgrade (#18): no `auto_title` effect on a hosted actor, so name it after the run.
    // A failed titling model keeps the stand-in; the turn does not fail over its name.
    try {
      const titled = await titleActorFromMessage(actor.handle, task.body, (brief) => seams.suggestTitle(brief));

      if (titled) seams.announce(actor);
    } catch (cause) {
      diagnostics.failure('agent.auto_title_suggestion_failed', toKinuError({
        doing: 'deriving a hosted actor title from its brief', cause, otherwise: 'unavailable',
      }), { workspace: actor.record.workspaceId });
    }

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

    if (relayed === null) return { text: report.summary, relayed: null };

    return {
      text: report.summary,
      relayed: await relayHostedReport(seams, actor, {
        status: relayed.status, content: relayed.content, origin: 'turn_end',
        mode: task.mode, sequenceId: task.sequenceId,
      }),
    };
  });
}

/** One actor's child substrate: every verb is a call on the workspace's one host. */
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
      // The child's own config rows only; the parent's roster row is core's (`createTeamToolDeps`),
      // one writer per fact.
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
    /** Wipe removes rows, home and state subtree; archive keeps them. `observed` lets the host settle a live claim. */
    dismiss: async (name, keepHistory, reference) => {
      const live = seams.host.hosted(reference);
      const claim = live === null ? null : live.session.turnClaim;
      // `observed` only when a claim was seen: the host's refusal depends on absent vs present.
      const request: ActorRetirementRequest = { reference, name, keepHistory };

      if (claim !== null) request.observed = { turnId: claim.turnId, epoch: claim.epoch };
      await seams.host.retire(parent().reference, actorRetirementFor(request));
    },
  };
}

/** Core's predicate at the one place a hosted child's report is admitted. */
export function reportSettlesRun(status: SubordinateReportStatus, origin: SubordinateReportOrigin): boolean {
  return temporaryRunSettles({ status, origin });
}
