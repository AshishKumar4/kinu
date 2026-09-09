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

import type { LanguageModel, ToolSet } from 'ai';
import {
  EventLog, HeadCapture, runHeadInference,
  admitSubordinateTask, describeSubordinateHandoff, readSubordinateLiveStatus,
  receiveSubordinateEvent, subordinateRelaysTurnEnd, temporaryRunSettles,
  terminalTaskReport, defaultLoopOrigin, delegationBudgetAtDepth, delegationExhausted,
  type ActorHost, type ActorReference, type BoundActor, type DelegationBudget,
  type DynamicContext, type HeadInferenceDeps, type HeadInput, type HostedActor,
  type MissionScope,
  type SqlExec, type SqlExecutor, type SubordinateEventResult, type SubordinateHandoff,
  type SubordinateLifetime, type SubordinateReportOrigin,
  type SubordinateReportStatus, type SubordinateRosterStore, type SubordinateRuntime,
  type SubordinateSeed, type TaskTurnEnding, type TemporaryAgentPort, type VFS,
  type WorkMode, type WorkspaceActor, type WorkspaceActorDirectory,
} from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import type { CFRuntime } from './runtime';
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
  /** The tool surface this hosted actor's delegated turn admits, built over
   *  {@link HostedTaskTurn} — the whole turn, because the surface is a
   *  function of every part of it and a builder that took only some would
   *  resolve the rest a second time. */
  taskTools(turn: HostedTaskTurn): ToolSet;
  /** The per-step live plane the turn reports. */
  dynamic(actor: HostedActor): DynamicContext;
  /** The mission ledger a delegated turn charges, or null. */
  mission(actor: HostedActor): MissionScope | null;
  /** Announce a roster change to whoever is watching this actor's pane. */
  announce(actor: BoundActor): void;
  /** Ask this actor's own orchestration to drain its event log. */
  scheduleDrain(actor: HostedActor): void;
  /** The temporary rung's waiter register, which lives on the PARENT: `ask`
   *  parks a waiter and the report ingress resolves it, and those are two
   *  different calls on one isolate. */
  temporary(actor: BoundActor): TemporaryAgentPort;
}

/** This child's own room in the tree, from the ONE row that states it.
 *
 *  Durable by construction rather than by a private copy: the old facet held
 *  `depth` in its own `actor_identity` row precisely because an evicted DO that
 *  kept it in memory would reset and rebuild the whole tree beneath itself. The
 *  directory row is that durability now, and it cannot disagree with the roster
 *  because it IS the roster. */
export function hostedDelegationBudget(
  seams: Pick<SubordinateHostSeams, 'host'>, actor: BoundActor,
): DelegationBudget {
  let depth = 0;
  let current: WorkspaceActor | null = actor.record;
  while (current !== null && current.parentActorId !== null) {
    depth += 1;
    current = seams.host.describe(current.parentActorId);
  }
  return delegationBudgetAtDepth(depth);
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
  task: { readonly body: string; readonly mode: WorkMode },
): HeadInput {
  return {
    id: record.name,
    rootId: record.name,
    parentId: record.parentActorId,
    depth: 0,
    task: task.body,
    mode: task.mode,
    rationale: task.body,
    // EMPTY, and not the admission's `inherited_context`. That field is PROSE a
    // hirer wrote for the brief; `HeadInput.inheritedContext` is
    // `SerializedMessage[]` — a conversation. Coercing one into the other would
    // fabricate a message nobody sent, so the prose stays where the ingress
    // renders it into the body and this stays honestly empty: a delegated
    // turn's framing is its brief, not a transcript.
    inheritedContext: [],
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
    readonly deadlineHint?: string;
    readonly inheritedContext?: string;
    readonly creationId?: string;
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
    if (input.deadlineHint) admission.deadlineHint = input.deadlineHint;
    if (input.inheritedContext) admission.inheritedContext = input.inheritedContext;
    if (input.creationId !== undefined) admission.creationId = input.creationId;
    const result = admitSubordinateTask(new EventLog(seams.exec, actor.handle), admission);
    if (result.admitted) seams.scheduleDrain(actor);
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
export async function runHostedTask(
  seams: SubordinateHostSeams,
  reference: ActorReference,
  task: {
    readonly body: string;
    readonly mode: WorkMode;
    readonly sequenceId: string;
  },
): Promise<{ readonly text: string; readonly relayed: SubordinateEventResult | null }> {
  return await seams.host.run(reference, async (actor) => {
    // SAFETY: this runtime is the one `ActorHostDeps.runtimeFor` built, which on
    // this backend IS `createCFRuntime`. The core seam declares the RETURN type
    // as `AgentRuntime` and does not narrow the value, so the cf members this
    // delegated turn reaches are present by construction. Teaching core the
    // backend's own runtime shape to satisfy a cf read is the wrong direction.
    const runtime = actor.runtime as CFRuntime;
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
    // Annotated with the NAMED interface and assembled in statements: `mission`
    // is added only when this turn is budgeted, so an UNBUDGETED turn carries no
    // key at all rather than a spread of nothing. Absent and present are
    // different instructions to the runner — a mission it cannot see is a turn
    // that charges nothing — and a conditional spread hides which one this is.
    const inference: HeadInferenceDeps = {
      actor,
      runId: crypto.randomUUID(),
      model: turn.model,
      tools: seams.taskTools(turn),
      capture,
      workspaceLayout: 'shared-workspace',
      // Cancellation is the session's. A delegated turn is not cancelled by the
      // parent hanging up, by a socket closing or by an eviction: an interrupted
      // turn leaves its claim unsettled, which is the record that work is owed.
      isAborted: () => false,
      profile: (request) => seams.profile({ actor, ...request }),
      dynamic: () => seams.dynamic(actor),
    };
    if (mission !== null) inference.mission = mission;
    const report = await runHeadInference(input, inference);
    const ending: TaskTurnEnding = report.status === 'completed'
      ? 'answered'
      : report.status === 'aborted' ? 'interrupted' : 'errored';
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
