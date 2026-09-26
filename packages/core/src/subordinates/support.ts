/** Subordinates: roster, identity, admission and the one orchestration policy, platform-neutral. */

import * as v from 'valibot';
import type { EventLog, PublishResult } from '../events/hub/log';
import type { SubordinateReportHandoff, SubordinateReportStatus } from '../events/hub/types';
import type { SpilledContent } from '../events/hub/content-spill';
import type { SerializedMessage } from '../heads/types';
import type { SqlExec, SqlExecRow } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import {
  DELEGATION_MAX_DEPTH,
  delegationBudgetAtDepth,
  type DelegationBudget,
} from './depth';
import type { AgentIdentity } from '../vfs/agent-home';
import { SubordinateRosterStore } from './roster';
import { requireSubordinateActorName } from '../identity/actor-key';
import { codenameFor, type NameOrigin } from '../identity/naming';
import type { ActorReference } from '../identity/actor-handle';
import { finishSubordinateBirth, type SubordinateBirth, type SubordinateSeed } from './birth';
import type { WorkMode } from '../types/turn';
import type { AgentConfigStore } from '../config/store';
import type { RoleId, TierId } from '../profiles/catalog';
import type {
  SubordinateHandoff,
  SubordinateRosterEntry,
  TeamToolDeps,
} from '../delegation/agents-tool';
import { SUBORDINATE_LIFETIMES, type SubordinateLifetime, type TemporaryAgentPort } from './temporary';
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

/** Immutable lineage; everything mutable lives only in the child's `actor_config` ({@link SubordinateDescriptorSource}). */
export interface SubordinateIdentity {
  name: string;
  mission: string;
  /** Inherited unchanged down a nested tree, so never the immediate parent's name past depth 1. */
  parentWorkspace: string;
  ownerUserId: string;
  /** Durable tree depth (1 = hired by the orchestrator); the cap's backbone. */
  depth: number;
  /** Immutable so a `task` child still owes exactly one report per turn end after an eviction (`terminalTaskReport`). */
  lifetime: SubordinateLifetime;
  /** The uid allocated for `sub-<name>`; immutable because a home is owned by uid on real inodes. Absent where the workspace re-provisions at open. */
  cred?: AgentIdentity;
}

interface IdentityRow {
  name: string;
  mission: string;
  parent_workspace: string;
  owner_user_id: string;
  depth: number;
  lifetime: SubordinateLifetime;
  uid: number | null;
  gid: number | null;
}

const IdentityRowSchema = v.object({
  name: v.string(),
  mission: v.string(),
  parent_workspace: v.string(),
  owner_user_id: v.string(),
  depth: v.number(),
  lifetime: v.picklist(SUBORDINATE_LIFETIMES),
  uid: v.nullable(v.number()),
  gid: v.nullable(v.number()),
});

function parseIdentityRow(row: SqlExecRow): IdentityRow | null {
  const parsed = v.safeParse(IdentityRowSchema, row);

  return parsed.success ? parsed.output : null;
}

function mapIdentityRow(row: IdentityRow): SubordinateIdentity {
  const identity: SubordinateIdentity = {
    name: row.name,
    mission: row.mission,
    parentWorkspace: row.parent_workspace,
    ownerUserId: row.owner_user_id,
    depth: row.depth,
    lifetime: row.lifetime,
  };

  // Assigned, not spread: a row with no credential leaves the key absent, and readers decide by presence.
  if (row.uid !== null && row.gid !== null) identity.cred = { uid: row.uid, gid: row.gid };

  return identity;
}

function identitiesEqual(stored: SubordinateIdentity, attempted: SubordinateIdentity): boolean {
  if (
    stored.ownerUserId !== attempted.ownerUserId
    || stored.parentWorkspace !== attempted.parentWorkspace
  ) return false;

  if (stored.name !== attempted.name || stored.mission !== attempted.mission) return false;

  if (stored.lifetime !== attempted.lifetime) return false;

  if (stored.cred?.uid !== attempted.cred?.uid || stored.cred?.gid !== attempted.cred?.gid) return false;

  return stored.depth === attempted.depth;
}

/** The parent may retry the exact seed, but nothing can retarget an initialized facet's workspace, owner or depth. */
export class SubordinateIdentityStore {
  private readonly actorId: string;

  /** Per actor, not per database: `PRIMARY KEY (actor_id, id)` plus the `id = 1` CHECK. */
  constructor(private readonly sql: SqlExec, private readonly actor: ActorHandle) {
    this.actorId = actor.actorId;
  }

  ensureSchema(): void {
    this.actor.assertCurrent();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS subordinate_identity (
      actor_id         TEXT NOT NULL,
      id               INTEGER NOT NULL CHECK (id = 1),
      name             TEXT NOT NULL,
      mission          TEXT NOT NULL,
      parent_workspace TEXT NOT NULL,
      owner_user_id    TEXT NOT NULL,
      depth            INTEGER NOT NULL DEFAULT 1,
      lifetime         TEXT NOT NULL DEFAULT 'durable',
      uid              INTEGER,
      gid              INTEGER,
      PRIMARY KEY (actor_id, id)
    )`);
  }

  seed(identity: SubordinateIdentity): void {
    this.actor.assertCurrent();
    const existing = this.read();

    if (existing) {
      if (identitiesEqual(existing, identity)) return;
      throw new Error('Subordinate identity is already initialized and cannot be changed.');
    }

    this.sql.exec(
      `INSERT INTO subordinate_identity
         (actor_id, id, name, mission, parent_workspace, owner_user_id, depth, lifetime, uid, gid)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.actorId,
      identity.name,
      identity.mission,
      identity.parentWorkspace,
      identity.ownerUserId,
      identity.depth,
      identity.lifetime,
      identity.cred?.uid ?? null,
      identity.cred?.gid ?? null,
    );
  }

  read(): SubordinateIdentity | null {
    this.actor.assertCurrent();

    const rows = this.sql.exec(
      `SELECT name, mission, parent_workspace, owner_user_id, depth, lifetime, uid, gid
       FROM subordinate_identity WHERE actor_id = ? AND id = 1`,
      this.actorId,
    ).toArray();

    if (rows.length === 0) return null;
    const row = parseIdentityRow(rows[0]);

    if (!row) throw new Error('Stored subordinate identity is malformed.');

    return mapIdentityRow(row);
  }

  ownerUserId(): string | null {
    return this.read()?.ownerUserId ?? null;
  }

  workspaceName(): string | null {
    return this.read()?.parentWorkspace ?? null;
  }

  /** Fails closed on an unseeded facet: no identity row means no delegation budget. */
  delegationBudget(): DelegationBudget {
    const identity = this.read();

    return delegationBudgetAtDepth(identity?.depth ?? DELEGATION_MAX_DEPTH);
  }
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


function requiredText(value: string, field: string): string {
  const text = value.trim();

  if (!text) throw new Error(`${field} must be non-empty`);

  return text;
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
  mode: WorkMode;
  now: number;
}): PublishResult {
  const fromWorkspace = requiredText(input.fromWorkspace, 'fromWorkspace');
  const body = requiredText(input.body, 'body');
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

  if (input.creationId !== undefined) Object.assign(payload, { creation_id: requiredText(input.creationId, 'creationId') });

  if (input.messageId !== undefined) Object.assign(payload, { message_id: requiredText(input.messageId, 'messageId') });

  return log.publish({
    descriptor: {
      ingress: 'subordinate',
      variant: 'subordinate_task',
      payload,
    },
    now: input.now,
  });
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
  return requiredText(content, 'content');
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
  const fromSubordinate = requiredText(input.fromSubordinate, 'fromSubordinate');
  const content = normalizeReportContent(input.content);
  const task = optionalText(input.task);

  const payload = {
    from_subordinate: fromSubordinate,
    status: input.status,
    content,
    sequence_id: requiredText(input.sequenceId, 'sequenceId'),
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
  dismiss(name: string, dismissal: { readonly keepHistory: boolean; readonly interrupt: boolean }, reference: ActorReference): Promise<void>;
}

export interface SubordinatesChangedEvent {
  type: 'subordinates_changed';
  subordinates: SubordinateRosterEntry[];
}

/** Same default as `AgentConfigStore.getRoleSelection`. */
const DEFAULT_SUBORDINATE_ROLE_ID = 'task';

function displayNameForRole(role: string): string {
  return role.trim().split(/\s+/).slice(0, 4)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function rollback(input: { cause: unknown }, action: () => void, operation: string): never {
  try {
    action();
  } catch (rollbackError) {
    throw new AggregateError(
      [input.cause, rollbackError],
      `${operation} failed and its roster rollback also failed`,
      { cause: input.cause },
    );
  }

  throw input.cause;
}



async function statusView(
  runtime: SubordinateRuntime,
  roster: SubordinateRosterEntry,
): Promise<SubordinateStatusView> {
  if (roster.status === 'dismissed') return { roster, live: null };

  try {
    return { roster, live: await runtime.status(roster.name) };
  } catch (error) {
    return { roster, live: null, liveError: renderThrownChain({ cause: error }) };
  }
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
  broadcast(event: SubordinatesChangedEvent): void;
  broadcastTask(event: { subordinate: string; content: string; timestamp: number }): void;
  /**
   * Built once per actor: the port holds the live `shell` waiters, and these deps are rebuilt per call.
   * Absent: no role-targeted ask, structurally.
   */
  temporary?: TemporaryAgentPort;
}): TeamToolDeps {
  /** The only payload is the lifecycle roster; task content travels on its own event. */
  const changed = () => {
    deps.broadcast({ type: 'subordinates_changed', subordinates: deps.roster.list() });
  };

  /** A task-lifetime row belongs to the asking call's waiter; durable verbs refuse it as `bad_input`. */
  const requireDurable = (entry: SubordinateRosterEntry): SubordinateRosterEntry => {
    if (entry.lifetime !== 'durable') {
      throw new KinuError(
        'bad_input',
        `subordinate "${entry.name}" is a temporary agent for one question (lifetime 'task'), `
          + 'released by the call that asked it — assign, message and dismiss apply to durable subordinates only',
      );
    }

    return entry;
  };

  const provision = async (input: {
    name?: string;
    displayName?: string;
    /** Absent only for an owner who said nothing. */
    role?: RoleId;
    tier?: TierId;
    mission?: string;
    inheritedContext?: SerializedMessage[];
  }, ownerCreated: boolean, mode: WorkMode | null): Promise<{
    name: string;
    displayName: string;
    createdAt: number;
    subordinate: SubordinateRosterEntry;
  }> => {
    let selection: RoleId;

    if (input.role !== undefined) {
      selection = input.role;
    } else if (ownerCreated) {
      // `spawn` already refused an empty mission, so this default is only ever the owner's.
      selection = DEFAULT_SUBORDINATE_ROLE_ID;
    } else {
      throw new Error('role must be non-empty');
    }

    const roleLabel = selection;

    const mission = ownerCreated
      ? requiredText(optionalText(input.mission) ?? deps.ownMission(), 'mission')
      : requiredText(input.mission ?? '', 'mission');

    const typedName = input.name?.trim();
    const name = typedName === undefined || typedName === '' ? deps.createName(roleLabel) : typedName;
    requireSubordinateActorName(name);

    if (deps.roster.get(name)) throw new Error(`subordinate "${name}" already exists`);

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
    };

    if (input.tier !== undefined) seed.tier = input.tier;
    const createdAt = deps.now();
    let assignment: SubordinateBirth['assignment'] = null;

    if (!ownerCreated) {
      if (mode === null) throw new KinuError('bad_input', 'A subordinate task requires a work mode.');
      assignment = { body: mission, mode };

      const inheritedContext = subordinateBirthContext(input.inheritedContext);

      if (inheritedContext) assignment.inheritedContext = inheritedContext;
    }

    const creationId = crypto.randomUUID();
    deps.roster.create({
      name, actorReference: null, birth: { creationId, seed, assignment }, deleteRequested: false,
      createdBy: ownerCreated ? 'user' : 'orchestrator',
      status: ownerCreated ? 'idle' : 'working', currentTask: ownerCreated ? null : mission,
      createdAt, dismissedAt: null, lifetime: 'durable', taskEventId: null,
    });
    await finishSubordinateBirth(deps.roster, deps.runtime, name);

    return {
      name,
      displayName,
      createdAt,
      subordinate: deps.roster.requireActive(name),
    };
  };

  const team: TeamToolDeps = {
    inheritedContext: async () => deps.originContext
      ? inheritedContextFromHistory(await deps.originContext())
      : deps.inheritedContext(),
    delegation: deps.delegation,
    snapshot: () => deps.roster.list(),
    list: async () => deps.roster.list(),

    create: async (input) => {
      const { name, displayName, subordinate } = await provision(input, true, null);
      changed();

      return { name, displayName, subordinate };
    },

    // The child's own actor_config is the only naming authority.
    rename: async (input) => {
      const displayName = requiredText(input.displayName, 'displayName');
      await deps.runtime.rename(input.name, displayName, 'user');
      changed();

      return {
        ok: true, name: input.name, displayName,
        subordinate: deps.roster.requireActive(input.name),
      };
    },

    recordTitle: async (input) => {
      const displayName = requiredText(input.displayName, 'displayName');
      changed();

      return { ok: true, name: input.name, displayName };
    },

    spawn: async (input) => {
      const mission = requiredText(input.mission, 'mission');
      const { name, displayName, createdAt } = await provision(input, false, input.mode);
      changed();
      deps.broadcastTask({ subordinate: name, content: mission, timestamp: createdAt });

      return { name, displayName };
    },

    assign: async (input) => {
      const task = requiredText(input.task, 'task');
      const before = requireDurable(deps.roster.requireActive(input.name));
      deps.roster.assign(input.name, task);
      let handoff: SubordinateHandoff;

      try {
        const deliverable = optionalText(input.deliverable);

        const assignment: Parameters<SubordinateRuntime['assign']>[1] = {
          body: task,
          mode: input.mode,
        };

        if (deliverable) Object.assign(assignment, { deliverable });

        // No inherited context: later assignments add no new prefix.
        handoff = await deps.runtime.assign(input.name, assignment);
        // Inside the rollback scope: this write compensates the transition, so its failure must restore `before` too.
        deps.roster.recordAssignmentEvent(input.name, handoff.eventId);
      } catch (error) {
        rollback({ cause: error }, () => deps.roster.restore(before), 'subordinate assignment');
      }

      changed();
      deps.broadcastTask({ subordinate: input.name, content: task, timestamp: deps.now() });

      return { ok: true, name: input.name, ...handoff };
    },

    knows: async (name) => deps.roster.get(name) !== null,

    status: async (input) => {
      if (input.name) return statusView(deps.runtime, deps.roster.requireExisting(input.name));

      return Promise.all(deps.roster.list().map((entry) => statusView(deps.runtime, entry)));
    },

    message: async (input) => {
      const content = requiredText(input.content, 'content');
      const before = requireDurable(deps.roster.requireActive(input.name));
      deps.roster.resumeAfterMessage(input.name);
      let handoff: SubordinateHandoff;

      try {
        handoff = await deps.runtime.message(input.name, content, input.mode);
      } catch (error) {
        rollback({ cause: error }, () => deps.roster.restore(before), 'subordinate message');
      }

      changed();

      return { ok: true, name: input.name, ...handoff };
    },

    dismiss: async (input) => {
      const before = requireDurable(deps.roster.requireExisting(input.name));

      if (before.createdBy === 'user' && input.requestedBy !== 'user') {
        throw new Error(`subordinate "${input.name}" was created by the owner and only the owner can dismiss it`);
      }

      // Archive by default so a dismissal is never silent data loss; wiping requires keepHistory=false.
      const keepHistory = input.keepHistory ?? true;
      const reference = before.actorReference;

      if (!reference) throw new KinuError('missing', 'The subordinate birth has not confirmed an actor reference.');

      if (keepHistory && before.deleteRequested) throw new KinuError('denied', 'Physical retirement is already requested.');

      if (keepHistory) deps.roster.dismiss(input.name, deps.now());
      else deps.roster.requestDeletion(input.name, reference, deps.now());

      if (keepHistory) {
        try { await deps.runtime.dismiss(input.name, { keepHistory: true, interrupt: true }, reference); }
        catch (cause) { rollback({ cause }, () => deps.roster.restore(before), 'retained subordinate dismissal'); }
      } else {
        await deps.runtime.dismiss(input.name, { keepHistory: false, interrupt: true }, reference);
        deps.roster.removeActor(input.name, reference);
      }

      changed();

      return { ok: true, name: input.name, historyKept: keepHistory };
    },
  };

  // Assigned, not spread: an absent port must be an absent key, because every gate reads its presence.
  if (deps.temporary) Object.assign(team, { temporary: deps.temporary });

  return team;
}
