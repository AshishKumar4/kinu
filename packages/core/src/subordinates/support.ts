/** Subordinates: roster, identity, admission and the one orchestration policy, platform-neutral. */

import { Effect, Cause } from 'effect';
import { settle, settleSync } from '../obs/effect';
import * as v from 'valibot';
import type { EventLog, PublishResult } from '../events/hub/log';
import type { SubordinateReportHandoff, SubordinateReportStatus } from '../events/hub/types';
import type { SpilledContent } from '../events/hub/content-spill';
import type { SerializedMessage } from '../heads/types';
import type { SqlExec } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { DelegationBudget } from './depth';
import { SubordinateRosterStore } from './roster';
import { requireSubordinateActorName } from '../identity/actor-key';
import { codenameFor, type NameOrigin } from '../identity/naming';
import type { ActorReference } from '../identity/actor-handle';
import { finishSubordinateBirth, type SubordinateBirth, type SubordinateSeed } from './birth';
import type { WorkMode } from '../types/turn';
import type { AgentConfigStore } from '../config/store';
import type { RoleId, TierId } from '../profiles/catalog';
import type {
  SubordinateDismissal,
  SubordinateHandoff,
  SubordinateRosterEntry,
  TeamToolDeps,
} from '../delegation/agents-tool';
import type { TemporaryAgentPort } from './temporary';
import { KinuError, renderThrownChain } from '../obs/index';
import { subordinateBirthContext, type SubordinateInheritedContext } from '../types/subordinates';
import type { ModelMessage } from 'ai';
import { inheritedContextFromHistory } from '../orchestrator/heads-support';

export interface SubordinateLiveStatus {
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

export function readSubordinateLiveStatus(
  sql: SqlExec, actor: ActorHandle,
): SubordinateLiveStatus {
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
export interface SubordinateDescriptor {
  displayName: string;
  nameOrigin: NameOrigin;
  role: RoleId;
  /** Null derives from the role. */
  tier: TierId | null;
}

/** Null when the child cannot be asked; callers render unavailable rather than stale. */
export interface SubordinateDescriptorSource {
  read(): SubordinateDescriptor | null;
}

export function subordinateDescriptorSource(config: AgentConfigStore): SubordinateDescriptorSource {
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

/** Only the birth assignment carries a fork; later tasks have no new prefix. */
export function subordinateForkContext(context?: SubordinateInheritedContext): SerializedMessage[] {
  return context?.kind === 'fork' ? context.messages : [];
}

export function subordinateTurnContext(log: EventLog, turnId: string): SerializedMessage[] {
  return log.query({ turn_id: turnId, variant: 'subordinate_task' }).flatMap((event) =>
    event.variant === 'subordinate_task' && (event.payload_visibility === 'full' || event.payload_visibility === 'redact')
      ? subordinateForkContext(event.payload.inherited_context)
      : []);
}

export function admitSubordinateTask(log: EventLog, input: {
  fromWorkspace: string;
  kind: 'task' | 'message';
  body: string;
  deliverable?: string;
  inheritedContext?: SubordinateInheritedContext;
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
        ingress: 'subordinate',
        variant: 'subordinate_task',
        payload,
      },
      now: input.now,
    });
  }));
}

/** Delegated work carries a trusted Plan/Build mode, so it gets its own turn rather than splicing into live work. A duplicate schedules no drain. */
export function describeSubordinateHandoff(input: {
  admission: PublishResult;
  turnInFlight: boolean;
  live: SubordinateLiveStatus;
}): SubordinateHandoff {
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

/** Either source is admitted only while the parent has an open assignment for this subordinate. */
export type SubordinateReportOrigin = 'report_tool' | 'turn_end';

/** Relays only turns a queued signal drove; an owner-typed turn's answer is the owner's. The `report` tool does not come through here. */
export function subordinateRelaysTurnEnd(input: {
  /** The `report` tool already spoke for this turn; a relay would duplicate it. */
  reportedThisTurn: boolean;
  ownerDriven: boolean;
  assistantText: string;
}): boolean {
  return !input.reportedThisTurn
    && !input.ownerDriven
    && input.assistantText.trim().length > 0;
}

/** Only the parent knows whether it is waiting: with no open assignment, no report may create a parent turn. */
export function parentAdmitsSubordinateReport(input: {
  entry: SubordinateRosterEntry;
}): boolean {
  return input.entry.currentTask !== null;
}

/** Producers spill before admission: the VFS write is async and admission runs in a synchronous storage transaction. */
export function admitSubordinateReport(log: EventLog, input: {
  fromSubordinate: string;
  status: SubordinateReportStatus;
  content: string;
  /** Stated by the sender, never minted here: it is the idempotency key. */
  sequenceId: string;
  task?: string;
  spilled?: SpilledContent;
  /** Merged verbatim; a second normalization could disagree with the refused input. */
  handoff?: SubordinateReportHandoff;
  mode: WorkMode;
  now: number;
}): PublishResult {
  return settleSync(Effect.gen(function* () {
    const fromSubordinate = yield* requiredText(input.fromSubordinate, 'fromSubordinate');
    const content = yield* requiredText(input.content, 'content');
    const task = optionalText(input.task);

    const payload = {
      from_subordinate: fromSubordinate,
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
        ingress: 'subordinate',
        variant: 'subordinate_report',
        payload,
      },
      now: input.now,
    });
  }));
}

export interface SubordinateRuntime {
  spawn(input: SubordinateSeed & { creationId: string }): Promise<ActorReference>;
  cancelBirth(input: SubordinateSeed & { creationId: string }): Promise<ActorReference>;
  assign(name: string, input: {
    body: string;
    mode: WorkMode;
    deliverable?: string;
    inheritedContext?: SubordinateInheritedContext;
    creationId?: string;
  }): Promise<SubordinateHandoff>;
  status(name: string): Promise<SubordinateLiveStatus>;
  message(name: string, content: string, mode: WorkMode): Promise<SubordinateHandoff>;
  /** Called with `user` for an owner rename, which makes `planWorkspaceTitle`'s refusal durable. */
  rename(name: string, displayName: string, nameOrigin: NameOrigin): Promise<void>;
  /** Without `interrupt`, retirement waits for the turn to settle. */
  dismiss(name: string, dismissal: { readonly keepHistory: boolean; readonly interrupt: boolean }, reference: ActorReference): Promise<SubordinateDismissal>;
}

/** Same default as `AgentConfigStore.getRoleSelection`. */
const DEFAULT_SUBORDINATE_ROLE_ID = 'task';

function displayNameForRole(role: string): string {
  return role.trim().split(/\s+/).slice(0, 4)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function rollback(before: SubordinateRosterEntry, roster: SubordinateRosterStore, operation: string) {
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
  runtime: SubordinateRuntime,
  roster: SubordinateRosterEntry,
): Effect.Effect<SubordinateStatusView> {
  if (roster.status === 'dismissed') return Effect.succeed({ roster, live: null });

  return Effect.catchCause(
    Effect.map(Effect.promise(async () => runtime.status(roster.name)), (live): SubordinateStatusView => ({ roster, live })),
    (failed) => Effect.succeed<SubordinateStatusView>({ roster, live: null, liveError: renderThrownChain({ cause: Cause.squash(failed) }) }),
  );
}

interface SubordinateStatusView {
  roster: SubordinateRosterEntry;
  live: SubordinateLiveStatus | null;
  liveError?: string;
}


/** Roster transitions precede facet admission and are restored exactly if it fails; broadcasts follow both. */
export function createTeamToolDeps(deps: {
  /** Derived by its parent, never chosen here. */
  delegation: DelegationBudget;
  roster: SubordinateRosterStore;
  runtime: SubordinateRuntime;
  createName(role: string): string;
  now(): number;
  inheritedContext(): Promise<SerializedMessage[]>;
  originContext?(): Promise<readonly ModelMessage[]>;
  /** Inherited by an owner-created agent given none; read at create time, not captured. */
  ownMission(): string;
  rosterMoved(): void;
  broadcastTask(event: { subordinate: string; content: string; timestamp: number }): void;
  /**
   * Built once per actor: the port holds the live `shell` waiters, and these deps are rebuilt per call.
   * Absent: no role-targeted ask, structurally.
   */
  temporary?: TemporaryAgentPort;
}): TeamToolDeps {
  /** A task agent answers one brief and retires; more work for it belongs to a durable hire. */
  const requireDurable = (entry: SubordinateRosterEntry): Effect.Effect<SubordinateRosterEntry, KinuError> => {
    return Effect.gen(function* () {
      if (entry.lifetime !== 'durable') {
        return yield* new KinuError(
          'bad_input',
          `subordinate "${entry.name}" is a temporary agent for one question (lifetime 'task'), `
            + 'retired once it answers: assign and message apply to durable subordinates only',
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
    inheritedContext?: SerializedMessage[];
  }, ownerCreated: boolean, mode: WorkMode | null): Effect.Effect<{
    name: string;
    displayName: string;
    createdAt: number;
    subordinate: SubordinateRosterEntry;
  }, KinuError> => Effect.gen(function* () {
    let selection: RoleId;

    if (input.role !== undefined) {
      selection = input.role;
    } else if (ownerCreated) {
      // `spawn` already refused an empty mission, so this default is only ever the owner's.
      selection = DEFAULT_SUBORDINATE_ROLE_ID;
    } else {
      return yield* Effect.die(new Error('role must be non-empty'));
    }

    const roleLabel = selection;

    const mission = ownerCreated
      ? yield* requiredText(optionalText(input.mission) ?? deps.ownMission(), 'mission')
      : yield* requiredText(input.mission ?? '', 'mission');

    const typedName = input.name?.trim();
    const name = typedName === undefined || typedName === '' ? deps.createName(roleLabel) : typedName;
    requireSubordinateActorName(name);

    if (deps.roster.get(name)) return yield* Effect.die(new Error(`subordinate "${name}" already exists`));

    // A typed title is the owner's and final; a role yields `auto`; nothing gives the slug's codename,
    // which the title policy may claim once.
    const chosen = optionalText(input.displayName);
    const provisional = ownerCreated && input.role === undefined;
    const displayName = chosen ?? (provisional ? codenameFor(name) : displayNameForRole(roleLabel));
    const nameOrigin: 'user' | 'auto' = chosen ? 'user' : 'auto';

    const seed: SubordinateSeed = {
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
    let assignment: SubordinateBirth['assignment'] = null;

    if (!ownerCreated) {
      if (mode === null) return yield* new KinuError('bad_input', 'A subordinate task requires a work mode.');
      assignment = { body: mission, mode };

      const inheritedContext = subordinateBirthContext(input.inheritedContext);

      if (inheritedContext) assignment.inheritedContext = inheritedContext;
    }

    const creationId = crypto.randomUUID();
    deps.roster.create({
      name, actorReference: null, birth: { creationId, seed, assignment }, deleteRequested: false,
      status: ownerCreated ? 'idle' : 'working', currentTask: ownerCreated ? null : mission,
      createdAt, dismissedAt: null, lifetime: 'durable', taskEventId: null,
    });
    yield* Effect.promise(() => finishSubordinateBirth(deps.roster, deps.runtime, name));

    return {
      name,
      displayName,
      createdAt,
      subordinate: deps.roster.requireActive(name),
    };
  });

  const team: TeamToolDeps = {
    inheritedContext: async () => deps.originContext
      ? inheritedContextFromHistory(await deps.originContext())
      : deps.inheritedContext(),
    delegation: deps.delegation,
    snapshot: () => deps.roster.list(),
    list: async () => deps.roster.list(),

    create: (input) => settle(Effect.gen(function* () {
      const { name, displayName, subordinate } = yield* provision(input, true, null);
      deps.rosterMoved();

      return { name, displayName, subordinate };
    })),

    // The child's own actor_config is the only naming authority.
    rename: (input) => settle(Effect.gen(function* () {
      const displayName = yield* requiredText(input.displayName, 'displayName');
      yield* Effect.promise(() => deps.runtime.rename(input.name, displayName, 'user'));
      deps.rosterMoved();

      return {
        ok: true as const, name: input.name, displayName,
        subordinate: deps.roster.requireActive(input.name),
      };
    })),

    recordTitle: (input) => settle(Effect.gen(function* () {
      const displayName = yield* requiredText(input.displayName, 'displayName');
      deps.rosterMoved();

      return { ok: true as const, name: input.name, displayName };
    })),

    spawn: (input) => settle(Effect.gen(function* () {
      const mission = yield* requiredText(input.mission, 'mission');
      const { name, displayName, createdAt } = yield* provision(input, false, input.mode);
      deps.rosterMoved();
      deps.broadcastTask({ subordinate: name, content: mission, timestamp: createdAt });

      return { name, displayName };
    })),

    assign: (input) => {
      return settle(Effect.gen(function* () {
        const task = yield* requiredText(input.task, 'task');
        const before = yield* requireDurable(deps.roster.requireActive(input.name));
        deps.roster.assign(input.name, task);

        const handoff: SubordinateHandoff = yield* Effect.catchCause(Effect.gen(function* () {
          const deliverable = optionalText(input.deliverable);

          const assignment: Parameters<SubordinateRuntime['assign']>[1] = {
            body: task,
            mode: input.mode,
          };

          if (deliverable) Object.assign(assignment, { deliverable });

          // No inherited context: later assignments add no new prefix.
          const assigned = yield* Effect.promise(async () => deps.runtime.assign(input.name, assignment));
          // Inside the rollback scope: this write compensates the transition, so its failure must restore `before` too.
          deps.roster.recordAssignmentEvent(input.name, assigned.eventId);

          return assigned;
        }), rollback(before, deps.roster, 'subordinate assignment'));

        deps.rosterMoved();
        deps.broadcastTask({ subordinate: input.name, content: task, timestamp: deps.now() });

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

        const handoff: SubordinateHandoff = yield* Effect.catchCause(
          Effect.promise(async () => deps.runtime.message(input.name, content, input.mode)),
          rollback(before, deps.roster, 'subordinate message'),
        );

        deps.rosterMoved();

        return { ok: true, name: input.name, ...handoff };
      }));
    },

    dismiss: (input) => {
      return settle(Effect.gen(function* () {
        const before = deps.roster.requireExisting(input.name);

        if (before.origin === 'user' && input.requestedBy !== 'user') {
          return yield* Effect.die(new Error(`subordinate "${input.name}" was created by the owner and only the owner can dismiss it`));
        }

        // Archive by default so a dismissal is never silent data loss; wiping requires keepHistory=false.
        const keepHistory = input.keepHistory ?? true;
        const reference = before.actorReference;

        if (!reference) return yield* new KinuError('missing', 'The subordinate birth has not confirmed an actor reference.');

        if (keepHistory && before.deleteRequested) return yield* new KinuError('denied', 'Physical retirement is already requested.');

        if (keepHistory) deps.roster.dismiss(input.name, deps.now());
        else deps.roster.requestDeletion(input.name, reference, deps.now());
        let dismissal: SubordinateDismissal;

        if (keepHistory) {
          dismissal = yield* Effect.catchCause(
            Effect.promise(async () => deps.runtime.dismiss(input.name, { keepHistory: true, interrupt: true }, reference)),
            rollback(before, deps.roster, 'retained subordinate dismissal'),
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
