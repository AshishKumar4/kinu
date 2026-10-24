/** Subagents: roster, identity, admission and the one orchestration policy, platform-neutral. */

import { Effect, Cause } from 'effect';
import { settle, settleSync } from '../obs/effect';
import * as v from 'valibot';
import type { EventLog, PublishResult } from '../events/hub/log';
import type { SubagentReportHandoff, SubagentReportStatus } from '../events/hub/types';
import type { SpilledContent } from '../events/hub/content-spill';
import type { SerializedMessage } from '../heads/types';
import type { SqlExec } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { DelegationBudget } from './depth';
import { SubagentRosterStore } from './roster';
import { requireSubagentActorName } from '../identity/actor-key';
import { codenameFor, mintAgentName, type NameOrigin } from '../identity/naming';
import type { WorkspaceActor, WorkspaceActorDirectory } from '../identity/workspace-actors';
import type { ActorReference } from '../identity/actor-handle';
import { admitSubagentBirth, type SubagentSeed } from './birth';
import type { WorkMode } from '../types/turn';
import type { AgentConfigStore } from '../config/store';
import type { RoleId, TierId } from '../profiles/catalog';
import type {
  SubagentDismissal,
  SubagentHandoff,
  SubagentRosterEntry,
  TeamToolDeps,
} from '../delegation/agents-tool';
import { TEMPORARY_LIFETIME, taskAnswerIsLater, terminalTaskReport, type OwedReport, type SubagentLifetime, type TaskTurnEnding, type TemporaryAgentPort } from './temporary';
import { KinuError, renderThrownChain } from '../obs/index';
import type { OwedReads } from '../tasks/reminder';
import type { SubagentInheritedContext } from '../types/subagents';
import type { ModelMessage } from 'ai';
import { inheritedContextFromHistory } from '../orchestrator/heads-support';
import { agentTree, unreadReports } from '../delegation/agent-tree';
import type { PanelAgent } from '../read-models/workspace-agents';

export interface SubagentLiveStatus {
  lastActivity: number | null;
  recentSteps: Array<{
    event: string;
    summary: string;
    elapsedMs: number;
    createdAt: number;
  }>;
}

const ActivityRowSchema = v.object({
  event: v.string(),
  detail: v.nullable(v.string()),
  elapsed_ms: v.number(),
  created_at: v.number(),
});

export function readSubagentLiveStatus(
  sql: SqlExec, actor: ActorHandle,
): SubagentLiveStatus {
  actor.assertCurrent();

  const recentSteps = sql.exec(
    `SELECT event, detail, elapsed_ms, created_at
     FROM activity_log
     WHERE actor_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 5`,
    actor.actorId,
  ).toArray().flatMap((row) => {
    const parsed = v.safeParse(ActivityRowSchema, row);

    if (!parsed.success) return [];
    const { event, detail, elapsed_ms: elapsedMs, created_at: createdAt } = parsed.output;
    const summary = detail?.trim();

    return [{
      event,
      // A step with no detail of its own is named by the event it was.
      summary: summary === undefined || summary === '' ? event : summary,
      elapsedMs,
      createdAt,
    }];
  });

  return {
    lastActivity: recentSteps[0]?.createdAt ?? null,
    recentSteps,
  };
}

/** Read from the child's own `actor_config`, the single authority; never persisted elsewhere. */
interface SubagentDescriptor {
  displayName: string;
  nameOrigin: NameOrigin;
  role: RoleId;
  /** Null derives from the role. */
  tier: TierId | null;
}

/** Null when the child cannot be asked; callers render unavailable rather than stale. */
export interface SubagentDescriptorSource {
  read(): SubagentDescriptor | null;
}

export function subagentDescriptorSource(config: AgentConfigStore): SubagentDescriptorSource {
  return {
    read: () => ({
      displayName: config.getDisplayName() ?? '',
      nameOrigin: config.getNameOrigin() ?? 'auto',
      role: config.getRoleSelection(),
      tier: config.getAssignedTier(),
    }),
  };
}


function requiredText(value: string, field: string): Effect.Effect<string> {
  const text = value.trim();

  if (!text) return Effect.die(new Error(`${field} must be non-empty`));

  return Effect.succeed(text);
}

function optionalText(value: string | undefined): string | undefined {
  const text = value?.trim();

  return text === undefined || text === '' ? undefined : text;
}

/**
 * What names a new hire: a model's hire its mission; an owner's agent the words it was opened with or the mission
 * they gave it, never the workspace's mission it inherits.
 */
function namingBrief(input: { readonly brief?: string; readonly mission?: string }, ownerCreated: boolean, mission: string): string | null {
  return ownerCreated ? optionalText(input.brief) ?? optionalText(input.mission) ?? null : mission;
}

/** Only the birth assignment carries a fork; later tasks have no new prefix. */
export function subagentForkContext(context?: SubagentInheritedContext): SerializedMessage[] {
  return context?.kind === 'fork' ? context.messages : [];
}

export function subagentTurnContext(log: EventLog, turnId: string): SerializedMessage[] {
  return log.query({ turn_id: turnId, variant: 'subagent_task' }).flatMap((event) =>
    event.variant === 'subagent_task' && (event.payload_visibility === 'full' || event.payload_visibility === 'redact')
      ? subagentForkContext(event.payload.inherited_context)
      : []);
}

export function admitSubagentTask(log: EventLog, input: {
  fromWorkspace: string;
  kind: 'task' | 'message';
  body: string;
  deliverable?: string;
  inheritedContext?: SubagentInheritedContext;
  creationId?: string;
  messageId?: string;
  idempotencyKey?: string;
  mode: WorkMode;
  now: number;
}): PublishResult {
  return settleSync(Effect.gen(function* () {
    const fromWorkspace = yield* requiredText(input.fromWorkspace, 'fromWorkspace');
    const body = yield* requiredText(input.body, 'body');
    const deliverable = optionalText(input.deliverable);
    const inheritedContext = input.inheritedContext;

    const payload = {
      from_workspace: fromWorkspace,
      kind: input.kind,
      body,
      kinu_mode: input.mode,
    };

    if (deliverable) Object.assign(payload, { deliverable });

    if (inheritedContext) Object.assign(payload, { inherited_context: inheritedContext });

    if (input.creationId !== undefined) Object.assign(payload, { creation_id: yield* requiredText(input.creationId, 'creationId') });

    if (input.messageId !== undefined) Object.assign(payload, { message_id: yield* requiredText(input.messageId, 'messageId') });

    if (input.idempotencyKey !== undefined) Object.assign(payload, { idempotency_key: requiredText(input.idempotencyKey, 'idempotencyKey') });

    return log.publish({
      descriptor: {
        ingress: 'subagent',
        variant: 'subagent_task',
        payload,
      },
      now: input.now,
    });
  }));
}

/** Delegated work carries a trusted Plan/Build mode, so it gets its own turn rather than splicing into live work. A duplicate schedules no drain. */
export function describeSubagentHandoff(input: {
  admission: PublishResult;
  turnInFlight: boolean;
  live: SubagentLiveStatus;
}): SubagentHandoff {
  return {
    eventId: input.admission.id,
    delivery: input.admission.admitted && !input.turnInFlight ? 'starts_now' : 'queued',
    phase: {
      busy: input.turnInFlight,
      lastActivityAt: input.live.lastActivity,
      workingOn: input.live.recentSteps[0]?.summary ?? null,
    },
  };
}

/** Producers normalize with this before spilling, so a cited spill file matches the brief. */
export function normalizeReportContent(content: string): string {
  return settleSync(requiredText(content, 'content'));
}

/** Either source is admitted only while the parent has an open assignment for this subagent. */
export type SubagentReportOrigin = 'report_tool' | 'turn_end';

/** Relays only turns a queued signal drove; an owner-typed turn's answer is the owner's. The `report` tool does not come through here. */
function subagentRelaysTurnEnd(input: {
  /** The `report` tool already spoke for this turn; a relay would duplicate it. */
  reportedThisTurn: boolean;
  ownerDriven: boolean;
  assistantText: string;
}): boolean {
  return !input.reportedThisTurn
    && !input.ownerDriven
    && input.assistantText.trim().length > 0;
}

/**
 * The report a hired turn's ending owes its hirer, on either backend: none once a report already settled the run; a
 * task's terminal answer, or any child's failure; else a durable child's turn-end progress, for a turn a queued signal
 * drove and that said nothing through `report`. The adapters keep the roster and the relay.
 */
async function owedSubagentTurnReport(input: {
  readonly lifetime: SubagentLifetime;
  readonly ending: TaskTurnEnding;
  readonly assistantText: string;
  readonly narration: () => Promise<readonly string[]>;
  readonly reports: { readonly spoke: boolean; readonly settled: boolean };
  readonly ownerDriven: boolean;
  readonly delegating: boolean;
}): Promise<OwedReport | null> {
  if (input.reports.settled) return null;

  const terminal = await terminalTaskReport({
    lifetime: input.lifetime, ending: input.ending, assistantText: input.assistantText, narration: input.narration, delegating: input.delegating,
  });

  if (terminal !== null) return terminal;

  // A task agent reports only its terminal answer.
  if (input.ending !== 'answered' || input.lifetime === TEMPORARY_LIFETIME) return null;

  return subagentRelaysTurnEnd({ reportedThisTurn: input.reports.spoke, ownerDriven: input.ownerDriven, assistantText: input.assistantText })
    ? { status: 'progress', content: input.assistantText }
    : null;
}

/**
 * A hire's settled turn, as its hirer is told of it on either backend: the hirer's roster first (announced when it
 * moved), then the report the turn owes ({@link owedSubagentTurnReport}), read against what the hire is owed and its log.
 */
export async function hireTurnSettled(input: {
  readonly hirer: { readonly roster: Pick<SubagentRosterStore, 'finishTurn'>; announce(): void };
  readonly hire: { readonly record: Pick<WorkspaceActor, 'name' | 'lifetime'>; readonly owed: OwedReads; readonly log: EventLog };
  readonly turn: { readonly reports: { readonly spoke: boolean; readonly settled: boolean }; readonly ownerDriven: boolean; readonly taskId: string | null };
  readonly ended: { readonly ending: TaskTurnEnding; readonly assistantText: string; readonly narration: readonly string[] };
}): Promise<OwedReport | null> {
  if (input.hirer.roster.finishTurn(input.hire.record.name, input.ended.ending, Date.now())) input.hirer.announce();

  return await owedSubagentTurnReport({
    lifetime: input.hire.record.lifetime, ending: input.ended.ending, assistantText: input.ended.assistantText,
    narration: async () => input.ended.narration, reports: input.turn.reports, ownerDriven: input.turn.ownerDriven,
    delegating: taskAnswerIsLater({ owed: input.hire.owed, log: input.hire.log, ...(input.turn.taskId !== null && { turnTaskId: input.turn.taskId }) }),
  });
}

/** Only the parent knows whether it is waiting: with no open assignment, no report may create a parent turn. */
export function parentAdmitsSubagentReport(input: {
  entry: SubagentRosterEntry;
}): boolean {
  return input.entry.currentTask !== null;
}

/** Producers spill before admission: the VFS write is async and admission runs in a synchronous storage transaction. */
export function admitSubagentReport(log: EventLog, input: {
  fromSubagent: string;
  status: SubagentReportStatus;
  content: string;
  /** Stated by the sender, never minted here: it is the idempotency key. */
  sequenceId: string;
  task?: string;
  spilled?: SpilledContent;
  /** Merged verbatim; a second normalization could disagree with the refused input. */
  handoff?: SubagentReportHandoff;
  mode: WorkMode;
  now: number;
}): PublishResult {
  return settleSync(Effect.gen(function* () {
    const fromSubagent = yield* requiredText(input.fromSubagent, 'fromSubagent');
    const content = yield* requiredText(input.content, 'content');
    const task = optionalText(input.task);

    const payload = {
      from_subagent: fromSubagent,
      status: input.status,
      content,
      sequence_id: yield* requiredText(input.sequenceId, 'sequenceId'),
      kinu_mode: input.mode,
    };

    if (task) Object.assign(payload, { task });

    if (input.spilled?.path !== undefined) Object.assign(payload, { content_path: input.spilled.path });

    if (input.spilled?.unsaved !== undefined) Object.assign(payload, { content_unsaved: input.spilled.unsaved });

    if (input.handoff) Object.assign(payload, input.handoff);

    return log.publish({
      descriptor: {
        ingress: 'subagent',
        variant: 'subagent_report',
        payload,
      },
      now: input.now,
    });
  }));
}

export interface SubagentRuntime {
  spawn(input: SubagentSeed & { creationId: string }): Promise<ActorReference>;
  cancelBirth(input: SubagentSeed & { creationId: string }): Promise<ActorReference>;
  assign(name: string, input: {
    body: string;
    mode: WorkMode;
    deliverable?: string;
    inheritedContext?: SubagentInheritedContext;
    creationId?: string;
  }): Promise<SubagentHandoff>;
  status(name: string): Promise<SubagentLiveStatus>;
  message(name: string, content: string, mode: WorkMode): Promise<SubagentHandoff>;
  /** Called with `user` for an owner rename, which makes `planWorkspaceTitle`'s refusal durable. */
  rename(name: string, displayName: string, nameOrigin: NameOrigin): Promise<void>;
  /** Without `interrupt`, retirement waits for the turn to settle. */
  dismiss(name: string, dismissal: { readonly keepHistory: boolean; readonly interrupt: boolean }, reference: ActorReference): Promise<SubagentDismissal>;
}

/** Same default as `AgentConfigStore.getRoleSelection`. */
const DEFAULT_SUBAGENT_ROLE_ID = 'task';

function displayNameForRole(role: string): string {
  return role.trim().split(/\s+/).slice(0, 4)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function rollback(before: SubagentRosterEntry, roster: SubagentRosterStore, operation: string) {
  return <E>(failed: Cause.Cause<E>): Effect.Effect<never, E> => {
    const cause = Cause.squash(failed);

    return Effect.catchCause(Effect.sync(() => roster.restore(before)), (restoreFailed) => Effect.die(new AggregateError(
      [cause, Cause.squash(restoreFailed)],
      `${operation} failed and its roster rollback also failed`,
      { cause },
    ))).pipe(Effect.andThen(Effect.failCause(failed)));
  };
}



function statusView(
  runtime: SubagentRuntime,
  roster: SubagentRosterEntry,
): Effect.Effect<SubagentStatusView> {
  if (roster.status === 'dismissed') return Effect.succeed({ roster, live: null });

  return Effect.catchCause(
    Effect.map(Effect.promise(async () => runtime.status(roster.name)), (live): SubagentStatusView => ({ roster, live })),
    (failed) => Effect.succeed<SubagentStatusView>({ roster, live: null, liveError: renderThrownChain({ cause: Cause.squash(failed) }) }),
  );
}

interface SubagentStatusView {
  roster: SubagentRosterEntry;
  live: SubagentLiveStatus | null;
  liveError?: string;
}


/**
 * Names a parent's new hires ({@link mintAgentName}): free in the workspace's directory, read once, and in the parent's
 * own roster, where a birth waits before its directory row exists.
 */
export function agentNamer(
  directory: Pick<WorkspaceActorDirectory, 'namesFrom'>, roster: Pick<SubagentRosterStore, 'get'>,
): (role: string, brief: string | null) => string {
  return (role, brief) => mintAgentName({ role, brief }, (base) => {
    const had = directory.namesFrom(base);

    return (name) => had.has(name) || roster.get(name) !== null;
  });
}

/** Roster transitions precede facet admission and are restored exactly if it fails; broadcasts follow both. */
export function createTeamToolDeps(deps: {
  /** Derived by its parent, never chosen here. */
  delegation: DelegationBudget;
  roster: SubagentRosterStore;
  runtime: SubagentRuntime;
  /** From what the hire was first asked (its brief), else its role ({@link agentNamer}). */
  createName(role: string, brief: string | null): string;
  now(): number;
  inheritedContext(): Promise<SerializedMessage[]>;
  originContext?(): Promise<readonly ModelMessage[]>;
  /** Inherited by an owner-created agent given none; read at create time, not captured. */
  ownMission(): Promise<string> | string;
  rosterMoved(): void;
  broadcastTask(event: { subagent: string; content: string; timestamp: number }): void;
  /** The workspace's agents as the person's sidebar reads them (`readWorkspaceAgents`): `agents.list` shows its subtree and peers. */
  workspaceAgents(): Promise<readonly PanelAgent[]>;
  /** This roster's owner as that read keys it: `main`, or its actor id. */
  readonly treeOwner: string;
  /** The owner's own events: the reports it has not read yet. */
  readonly events: Pick<EventLog, 'pending'>;
  /**
   * Built once per actor: the port holds the live `shell` waiters, and these deps are rebuilt per call.
   * Absent: no role-targeted ask, structurally.
   */
  temporary?: TemporaryAgentPort;
}): TeamToolDeps {
  /** A task agent answers one brief and retires; more work for it belongs to a durable hire. */
  const requireDurable = (entry: SubagentRosterEntry): Effect.Effect<SubagentRosterEntry, KinuError> => {
    return Effect.gen(function* () {
      if (entry.lifetime !== 'durable') {
        return yield* new KinuError(
          'bad_input',
          `subagent "${entry.name}" is a temporary agent for one question (lifetime 'task'), `
            + 'retired once it answers: assign and message apply to durable subagents only',
        );
      }

      return entry;
    });
  };

  const provision = (input: {
    name?: string;
    displayName?: string;
    /** Absent only for an owner who said nothing. */
    role?: RoleId;
    tier?: TierId;
    mission?: string;
    /** An owner's agent: the words it was opened with, which name it. */
    brief?: string;
    inheritedContext?: SerializedMessage[];
  }, ownerCreated: boolean, mode: WorkMode | null): Effect.Effect<{
    name: string;
    displayName: string;
    createdAt: number;
    subagent: SubagentRosterEntry;
  }, KinuError> => Effect.gen(function* () {
    let selection: RoleId;

    if (input.role !== undefined) {
      selection = input.role;
    } else if (ownerCreated) {
      // `spawn` already refused an empty mission, so this default is only ever the owner's.
      selection = DEFAULT_SUBAGENT_ROLE_ID;
    } else {
      return yield* Effect.die(new Error('role must be non-empty'));
    }

    const roleLabel = selection;

    const mission = ownerCreated
      ? yield* requiredText(optionalText(input.mission) ?? (yield* Effect.promise(async () => deps.ownMission())), 'mission')
      : yield* requiredText(input.mission ?? '', 'mission');

    const typedName = input.name?.trim();
    const named = typedName !== undefined && typedName !== '';
    const name = named ? typedName : deps.createName(roleLabel, namingBrief(input, ownerCreated, mission));
    requireSubagentActorName(name);

    if (deps.roster.get(name)) return yield* Effect.die(new Error(`subagent "${name}" already exists`));

    // A typed title is final, and so is the name a model's hire gives, the one it was told to (a hire "named
    // tidepool" showed "Planner", staging 2026-10-08); an owner's slug is only an address. A role alone yields `auto`;
    // nothing gives the slug's codename, which the title policy may claim once.
    const chosen = optionalText(input.displayName) ?? (named && !ownerCreated ? name : undefined);
    const provisional = ownerCreated && input.role === undefined;
    const displayName = chosen ?? (provisional ? codenameFor(name) : displayNameForRole(roleLabel));
    const nameOrigin: 'user' | 'auto' = chosen ? 'user' : 'auto';

    const seed: SubagentSeed = {
      name,
      displayName,
      nameOrigin,
      mission,
      role: selection,
      // Every child created here is durable; the task lifetime has one producer, `createTemporaryAgentPort`.
      lifetime: 'durable',
      origin: ownerCreated ? 'user' : 'agent',
    };

    if (input.tier !== undefined) seed.tier = input.tier;
    const createdAt = deps.now();

    if (!ownerCreated && mode === null) return yield* new KinuError('bad_input', 'A subagent task requires a work mode.');
    const assignment = ownerCreated || mode === null ? null : { body: mission, mode, ...(input.inheritedContext !== undefined && { inheritedContext: input.inheritedContext }) };
    yield* Effect.promise(() => admitSubagentBirth(deps.roster, deps.runtime, { seed, assignment, createdAt }));

    return {
      name,
      displayName,
      createdAt,
      subagent: deps.roster.requireActive(name),
    };
  });

  const team: TeamToolDeps = {
    inheritedContext: async () => deps.originContext
      ? inheritedContextFromHistory(await deps.originContext())
      : deps.inheritedContext(),
    delegation: deps.delegation,
    snapshot: () => deps.roster.list(),
    list: async () => deps.roster.list(),

    tree: async ({ retired, limit }) => agentTree({
      agents: await deps.workspaceAgents(), owner: deps.treeOwner, unread: unreadReports(deps.events), retired, limit,
    }),

    create: (input) => settle(Effect.gen(function* () {
      const { name, displayName, subagent } = yield* provision(input, true, null);
      deps.rosterMoved();

      return { name, displayName, subagent };
    })),

    // The child's own actor_config is the only naming authority.
    rename: (input) => settle(Effect.gen(function* () {
      const displayName = yield* requiredText(input.displayName, 'displayName');
      yield* Effect.promise(() => deps.runtime.rename(input.name, displayName, 'user'));
      deps.rosterMoved();

      return {
        ok: true as const, name: input.name, displayName,
        subagent: deps.roster.requireActive(input.name),
      };
    })),

    spawn: (input) => settle(Effect.gen(function* () {
      const mission = yield* requiredText(input.mission, 'mission');
      const { name, displayName, createdAt } = yield* provision(input, false, input.mode);
      deps.rosterMoved();
      deps.broadcastTask({ subagent: name, content: mission, timestamp: createdAt });

      return { name, displayName };
    })),

    assign: (input) => {
      return settle(Effect.gen(function* () {
        const task = yield* requiredText(input.task, 'task');
        const before = yield* requireDurable(deps.roster.requireActive(input.name));
        deps.roster.assign(input.name, task);

        const handoff: SubagentHandoff = yield* Effect.catchCause(Effect.gen(function* () {
          const deliverable = optionalText(input.deliverable);

          const assignment: Parameters<SubagentRuntime['assign']>[1] = {
            body: task,
            mode: input.mode,
          };

          if (deliverable) Object.assign(assignment, { deliverable });

          // No inherited context: later assignments add no new prefix.
          const assigned = yield* Effect.promise(async () => deps.runtime.assign(input.name, assignment));
          // Inside the rollback scope: this write compensates the transition, so its failure must restore `before` too.
          deps.roster.recordAssignmentEvent(input.name, assigned.eventId);

          return assigned;
        }), rollback(before, deps.roster, 'subagent assignment'));

        deps.rosterMoved();
        deps.broadcastTask({ subagent: input.name, content: task, timestamp: deps.now() });

        return { ok: true, name: input.name, ...handoff };
      }));
    },

    knows: async (name) => deps.roster.get(name) !== null,

    status: (input) => {
      if (input.name) return settle(statusView(deps.runtime, deps.roster.requireExisting(input.name)));

      return settle(Effect.forEach(deps.roster.list(), (entry) => statusView(deps.runtime, entry), { concurrency: 'unbounded' }));
    },

    message: (input) => {
      return settle(Effect.gen(function* () {
        const content = yield* requiredText(input.content, 'content');
        const before = yield* requireDurable(deps.roster.requireActive(input.name));
        deps.roster.resumeAfterMessage(input.name);

        const handoff: SubagentHandoff = yield* Effect.catchCause(
          Effect.promise(async () => deps.runtime.message(input.name, content, input.mode)),
          rollback(before, deps.roster, 'subagent message'),
        );

        deps.rosterMoved();

        return { ok: true, name: input.name, ...handoff };
      }));
    },

    dismiss: (input) => {
      return settle(Effect.gen(function* () {
        const before = deps.roster.requireExisting(input.name);

        if (before.origin === 'user' && input.requestedBy !== 'user') {
          return yield* Effect.die(new Error(`subagent "${input.name}" was created by the owner and only the owner can dismiss it`));
        }

        // Archive by default so a dismissal is never silent data loss; wiping requires keepHistory=false.
        const keepHistory = input.keepHistory ?? true;
        const reference = before.actorReference;

        if (!reference) return yield* new KinuError('missing', 'The subagent birth has not confirmed an actor reference.');

        if (keepHistory && before.deleteRequested) return yield* new KinuError('denied', 'Physical retirement is already requested.');

        if (keepHistory) deps.roster.dismiss(input.name, deps.now());
        else deps.roster.requestDeletion(input.name, reference, deps.now());
        let dismissal: SubagentDismissal;

        if (keepHistory) {
          dismissal = yield* Effect.catchCause(
            Effect.promise(async () => deps.runtime.dismiss(input.name, { keepHistory: true, interrupt: true }, reference)),
            rollback(before, deps.roster, 'retained subagent dismissal'),
          );
        } else {
          dismissal = yield* Effect.promise(async () => deps.runtime.dismiss(input.name, { keepHistory: false, interrupt: true }, reference));
          deps.roster.removeActor(input.name, reference);
        }

        deps.rosterMoved();

        return { ok: true, name: input.name, historyKept: keepHistory, stoppedJobs: dismissal.stoppedJobs };
      }));
    },
  };

  // Assigned, not spread: an absent port must be an absent key, because every gate reads its presence.
  if (deps.temporary) Object.assign(team, { temporary: deps.temporary });

  return team;
}
