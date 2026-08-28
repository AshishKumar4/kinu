/**
 * Subordinates — roster, identity, admission and the one orchestration policy
 * behind them.
 *
 * Platform-neutral by construction: nothing here touches a Durable Object, a
 * facet or a local process. A backend supplies the SqlExec primitive and a
 * SubordinateRuntime (how a subordinate is actually spawned and addressed on
 * that platform); everything else — status transitions, rollback semantics,
 * the inherited-context digest, event admission — is the same policy wherever
 * it runs. Core already owned the vocabulary (tools/agents-tool.ts); this is
 * the logic that belongs beside it.
 */

import * as v from 'valibot';
import type { EventLog, PublishResult } from '../events/hub/log';
import type { SubordinateReportStatus } from '../events/hub/types';
import type { SerializedMessage } from '../heads/types';
import type { SqlExec, SqlExecutor } from '../types/primitives';
import {
  DELEGATION_MAX_DEPTH,
  delegationBudgetAtDepth,
  type DelegationBudget,
} from './depth';
import { reconcileColumns } from '../identity/columns';
import { SubordinateRosterStore } from './roster';
import type { WorkMode } from '../prompting/surface';
import type { AgentConfigStore, RoleSelection } from '../config/store';
import type { TierId } from '../profiles/catalog';
import type {
  SubordinateHandoff,
  SubordinateRosterEntry,
  TeamToolDeps,
} from '../tools/agents-tool';
import { SUBORDINATE_LIFETIMES, type SubordinateLifetime, type TemporaryAgentPort } from './temporary';
import { renderThrownChain } from '../obs/index';

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

export function readSubordinateLiveStatus(sql: SqlExec): SubordinateLiveStatus {
  const recentSteps = sql.exec(
    `SELECT event, detail, elapsed_ms, created_at
     FROM activity_log
     ORDER BY created_at DESC, id DESC
     LIMIT 5`,
  ).toArray().flatMap((row) => {
    const parsed = v.safeParse(ActivityRowSchema, row);
    if (!parsed.success) return [];
    const { event, detail, elapsed_ms: elapsedMs, created_at: createdAt } = parsed.output;
    return [{
      event,
      summary: detail?.trim() || event,
      elapsedMs,
      createdAt,
    }];
  });
  return {
    lastActivity: recentSteps[0]?.createdAt ?? null,
    recentSteps,
  };
}

/**
 * The immutable lineage of one subordinate — the facts nothing may retarget
 * after the facet exists. Everything MUTABLE about how the agent presents
 * (title, role selection, tier) lives only in its own `agent_config`, read
 * through {@link SubordinateDescriptorSource}; this row never mirrors it.
 */
export interface SubordinateIdentity {
  name: string;
  mission: string;
  /** The WORKSPACE this subordinate belongs to — its exec planes, credentials
   *  and capability all present this name. Inherited unchanged down a nested
   *  tree, so it is never the immediate parent's name past depth 1. */
  parentWorkspace: string;
  ownerUserId: string;
  /** Durable tree depth (1 = hired by the orchestrator); the cap's backbone. */
  depth: number;
  /**
   * How long this child is MEANT to live — immutable lineage, like `depth`, and
   * here for the same kind of reason: it is a fact the child must KNOW about
   * itself and must never be able to change.
   *
   * The child is the only party that sees its own turn end, and a `task` child
   * owes its blocked caller exactly one report for every way that turn can end
   * (`terminalTaskReport`). Reading it off this row is what makes that true after
   * an eviction as well as on the first turn.
   */
  lifetime: SubordinateLifetime;
}

interface IdentityRow {
  name: string;
  mission: string;
  parent_workspace: string;
  owner_user_id: string;
  depth: number;
  lifetime: SubordinateLifetime;
}

const IdentityRowSchema = v.object({
  name: v.string(),
  mission: v.string(),
  parent_workspace: v.string(),
  owner_user_id: v.string(),
  depth: v.number(),
  lifetime: v.picklist(SUBORDINATE_LIFETIMES),
});

function parseIdentityRow<Input>(row: Input): IdentityRow | null {
  const parsed = v.safeParse(IdentityRowSchema, row);
  return parsed.success ? parsed.output : null;
}

function mapIdentityRow(row: IdentityRow): SubordinateIdentity {
  return {
    name: row.name,
    mission: row.mission,
    parentWorkspace: row.parent_workspace,
    ownerUserId: row.owner_user_id,
    depth: row.depth,
    lifetime: row.lifetime,
  };
}

function identitiesEqual(stored: SubordinateIdentity, attempted: SubordinateIdentity): boolean {
  if (
    stored.ownerUserId !== attempted.ownerUserId
    || stored.parentWorkspace !== attempted.parentWorkspace
  ) return false;
  if (stored.name !== attempted.name || stored.mission !== attempted.mission) return false;
  if (stored.lifetime !== attempted.lifetime) return false;
  return stored.depth === attempted.depth;
}

/** Immutable facet identity. The parent may retry the exact seed after an RPC
 * interruption, but no caller can retarget an initialized facet to another
 * workspace, owner or DEPTH. */
export class SubordinateIdentityStore {
  /** `tagged` is the same storage as `sql` in the tagged-template form
   *  `reconcileColumns` needs — it binds the table name into
   *  `pragma_table_info` rather than adding a column and swallowing the
   *  duplicate-column error. */
  constructor(private readonly sql: SqlExec, private readonly tagged: SqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS subordinate_identity (
      id               INTEGER PRIMARY KEY CHECK (id = 1),
      name             TEXT NOT NULL,
      mission          TEXT NOT NULL,
      parent_workspace TEXT NOT NULL,
      owner_user_id    TEXT NOT NULL,
      depth            INTEGER NOT NULL DEFAULT 1,
      lifetime         TEXT NOT NULL DEFAULT 'durable'
    )`);
    // Every subordinate that existed before nesting was possible was hired by
    // the workspace orchestrator, so 1 is that row's TRUE depth rather than a
    // compatibility guess.
    // Every subordinate that existed before the temporary rung was DURABLE, so
    // that default is the row's true lifetime rather than a compatibility guess
    // — the same argument the depth default carries above.
    reconcileColumns(this.tagged, (ddl) => { this.sql.exec(ddl); }, 'subordinate_identity', {
      depth: 'INTEGER NOT NULL DEFAULT 1',
      lifetime: "TEXT NOT NULL DEFAULT 'durable'",
    });
  }

  seed(identity: SubordinateIdentity): void {
    const existing = this.read();
    if (existing) {
      if (identitiesEqual(existing, identity)) return;
      throw new Error('Subordinate identity is already initialized and cannot be changed.');
    }
    this.sql.exec(
      `INSERT INTO subordinate_identity
         (id, name, mission, parent_workspace, owner_user_id, depth, lifetime)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
      identity.name,
      identity.mission,
      identity.parentWorkspace,
      identity.ownerUserId,
      identity.depth,
      identity.lifetime,
    );
  }

  read(): SubordinateIdentity | null {
    const rows = this.sql.exec(
      `SELECT name, mission, parent_workspace, owner_user_id, depth, lifetime
       FROM subordinate_identity WHERE id = 1`,
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

  /**
   * This subordinate's delegation budget, read from storage on every call.
   *
   * Fails CLOSED on an unseeded facet: no identity row means nothing has told
   * this actor where it is, and the honest answer to "how much tree may you
   * build" is none. Defaulting to depth 0 would hand an unseeded facet the
   * orchestrator's own budget, which is precisely the resumed-child bug one
   * level over.
   */
  delegationBudget(): DelegationBudget {
    const identity = this.read();
    return delegationBudgetAtDepth(identity?.depth ?? DELEGATION_MAX_DEPTH);
  }
}

/**
 * Everything MUTABLE about how one subordinate presents, read from ITS OWN
 * `agent_config` — the single authority. Nothing here is persisted anywhere
 * else; a parent that needs to show or prompt with this data asks the child
 * (or its local config store) through {@link SubordinateDescriptorSource}.
 */
export interface SubordinateDescriptor {
  displayName: string;
  nameOrigin: 'user' | 'auto';
  /** The catalog role, or the freeform line a pre-catalog hire carries. */
  role: RoleSelection;
  /** The tier a parent pinned at hire; null derives from the role. */
  tier: TierId | null;
}

/**
 * Read-side view of one child's descriptor. Answers null when the child
 * cannot be asked — callers render unavailable rather than stale.
 */
export interface SubordinateDescriptorSource {
  read(): SubordinateDescriptor | null;
}

/** The concrete source over a subordinate's own config store. */
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
  return text ? text : undefined;
}

// 4x the original keyhole (2400/500), the same uniform multiple the evidence
// window applied everywhere else: a subordinate's whole view of why it was
// hired should not be one screen of head-only fragments.
const SUBORDINATE_CONTEXT_MAX_CHARS = 9_600;
const SUBORDINATE_CONTEXT_MAX_MESSAGES = 8;
const SUBORDINATE_CONTEXT_MESSAGE_MAX_CHARS = 2_000;

/** A bounded conversational handoff, not a fork of the parent's history. The
 *  bound DISCLOSES itself: per-message cuts keep head+tail and name the cut,
 *  and a digest that dropped earlier messages says how many. */
export function renderSubordinateInheritedContext(
  messages: readonly SerializedMessage[],
): string | undefined {
  const conversational = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role,
      content: message.content.replace(/\s+/g, ' ').trim(),
    }))
    .filter((message) => message.content.length > 0);
  const relevant = conversational.slice(-SUBORDINATE_CONTEXT_MAX_MESSAGES);
  if (relevant.length === 0) return undefined;

  const omittedNote = conversational.length > relevant.length
    ? `(${conversational.length - relevant.length} earlier messages omitted)\n`
    : '';
  const header = '<inherited_context>\nRecent relevant parent conversation (digest only; subordinate history remains separate):\n' + omittedNote;
  const footer = '\n</inherited_context>';
  let remaining = SUBORDINATE_CONTEXT_MAX_CHARS - header.length - footer.length;
  const lines: string[] = [];
  for (let index = relevant.length - 1; index >= 0 && remaining > 0; index--) {
    const message = relevant[index];
    if (!message) continue;
    const prefix = `[${message.role}] `;
    const available = Math.min(
      SUBORDINATE_CONTEXT_MESSAGE_MAX_CHARS,
      remaining - prefix.length - (lines.length > 0 ? 1 : 0),
    );
    if (available <= 40) break;
    const line = `${prefix}${windowMessage(message.content, available)}`;
    lines.unshift(line);
    remaining -= line.length + (lines.length > 1 ? 1 : 0);
  }
  return lines.length > 0 ? `${header}${lines.join('\n')}${footer}` : undefined;
}

/** Head+tail with the omission named — a message's point is as often at its
 *  end (the ask, the error) as its start. */
function windowMessage(content: string, budget: number): string {
  if (content.length <= budget) return content;
  const marker = (n: number) => ` [+${n} cut] `;
  const omitted = content.length - budget;
  const overhead = marker(omitted + 40).length;
  const keep = Math.max(20, budget - overhead);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  const cut = content.length - keep;
  return `${content.slice(0, head)}${marker(cut)}${tail > 0 ? content.slice(-tail) : ''}`;
}

export function admitSubordinateTask(log: EventLog, input: {
  fromWorkspace: string;
  kind: 'task' | 'message';
  body: string;
  deliverable?: string;
  deadlineHint?: string;
  inheritedContext?: string;
  mode: WorkMode;
  now: number;
}): PublishResult {
  const fromWorkspace = requiredText(input.fromWorkspace, 'fromWorkspace');
  const body = requiredText(input.body, 'body');
  const deliverable = optionalText(input.deliverable);
  const deadlineHint = optionalText(input.deadlineHint);
  const inheritedContext = optionalText(input.inheritedContext);
  const payload = {
    from_workspace: fromWorkspace,
    kind: input.kind,
    body,
    kinu_mode: input.mode,
  };
  if (deliverable) Object.assign(payload, { deliverable });
  if (deadlineHint) Object.assign(payload, { deadline_hint: deadlineHint });
  if (inheritedContext) Object.assign(payload, { inherited_context: inheritedContext });
  return log.publish({
    descriptor: {
      ingress: 'subordinate',
      variant: 'subordinate_task',
      payload,
    },
    now: input.now,
  });
}

/**
 * The sender-visible half of an admission.
 *
 * `turnInFlight` is the subordinate's live-turn flag read at admission time.
 * Delegated work carries a trusted Plan/Build mode and therefore gets its own
 * turn instead of being spliced into unrelated live work. A duplicate
 * admission schedules no drain of its own and lands with the existing backlog.
 */
export function describeSubordinateHandoff(input: {
  admission: PublishResult;
  turnInFlight: boolean;
  live: SubordinateLiveStatus;
}): SubordinateHandoff {
  return {
    eventId: input.admission.id,
    delivery: !input.admission.admitted
      ? 'queued'
      : input.turnInFlight ? 'queued' : 'starts_now',
    phase: {
      busy: input.turnInFlight,
      lastActivityAt: input.live.lastActivity,
      workingOn: input.live.recentSteps[0]?.summary ?? null,
    },
  };
}

/** The exact report text admission stores. Producers normalize with this
 *  before spilling, so a cited spill file can never disagree with the brief
 *  it completes. */
export function normalizeReportContent(content: string): string {
  return requiredText(content, 'content');
}

/**
 * Where a subordinate's outbound message came from, and therefore who it is
 * for.
 *
 * `report_tool` is a deliberate report and `turn_end` is the automatic relay
 * of a finished assigned turn. The parent still admits either only while it
 * has an open assignment for that subordinate.
 */
export type SubordinateReportOrigin = 'report_tool' | 'turn_end';

/**
 * Subordinate side: does this finished turn's answer go up to the parent?
 *
 * Yes when a queued signal drove the turn — the parent's assignment, or a
 * background job that assignment detached. That relay is the "or its
 * completion" half of reporting, and it is why an assigned subordinate need
 * not remember to call `report`.
 *
 * No when the owner drove the turn by typing into the subordinate's own chat.
 * That answer is the owner's. Relaying it would spend the parent's turns on a
 * conversation it is not part of and paste someone else's dialogue into its
 * context. The parent can still read the subordinate's state whenever it wants
 * (`agents` status, the roster in its dynamic context) — visibility on request,
 * not push. And the subordinate may always choose to speak up: the `report`
 * tool does not come through here.
 */
export function subordinateRelaysTurnEnd(input: {
  /** The `report` tool already spoke for this turn; a relay would duplicate it. */
  reportedThisTurn: boolean;
  /** True when the owner typed this turn's driving message, false when a queued
   *  signal did (an event drain carrying a parent assignment, a background-job
   *  wake, a timer). */
  ownerDriven: boolean;
  assistantText: string;
}): boolean {
  return !input.reportedThisTurn
    && !input.ownerDriven
    && input.assistantText.trim().length > 0;
}

/**
 * Parent side: does an arriving report enter the parent's event rail — the rail
 * that wakes it, bills a turn and writes into its history?
 *
 * The subordinate cannot answer this, because only the parent knows whether it
 * is waiting for anything. With no open assignment, neither an explicit tool
 * call nor an automatic relay may create a parent turn. This also blocks a
 * background job detached from the owner's private chat from smuggling that
 * conversation upward on its later programmatic wake.
 */
export function parentAdmitsSubordinateReport(input: {
  entry: SubordinateRosterEntry;
}): boolean {
  return input.entry.currentTask !== null;
}

/** `contentPath` addresses the spill the caller already wrote for this exact
 *  content (`spillEventContent`), letting the parent's brief cite a report
 *  longer than the brief budget instead of dropping its tail. Producers spill
 *  BEFORE admission: the VFS write is async and admission runs inside the DO's
 *  synchronous storage transaction. */
export function admitSubordinateReport(log: EventLog, input: {
  fromSubordinate: string;
  status: SubordinateReportStatus;
  content: string;
  /** The sender's terminal sequence. Stated by the sender, never minted here:
   *  it is the key this admission is idempotent on, and a key the receiving
   *  side invented would be new on every replay. */
  sequenceId: string;
  task?: string;
  contentPath?: string;
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
  if (input.contentPath) Object.assign(payload, { content_path: input.contentPath });
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
  spawn(input: {
    name: string;
    /** The title to seed, empty when nothing the caller said can name this
     *  agent yet — a provisional blank the title policy is free to claim. */
    displayName: string;
    /** Whose title `displayName` is. `auto` includes the blank: it is a title
     *  nobody chose, so the first-interaction policy may replace it once.
     *  `user` is final. */
    nameOrigin: 'user' | 'auto';
    /** The child's initial role selection — catalog id or legacy freeform
     *  line, written to the CHILD's config store. */
    role: RoleSelection;
    tier?: TierId;
    mission: string;
    /**
     * How long this child is MEANT to live, seeded onto its own identity.
     *
     * The CHILD needs it, not just the roster, and that is the whole reason it
     * rides the seed: only the child sees its own turn end, and a `task` child
     * owes its caller exactly one report for EVERY way that turn can end
     * (`terminalTaskReport`). A child that did not know its lifetime applied the
     * durable relay policy, which withholds an empty or failed turn — and the
     * caller of a temporary ask is blocked on that report, so withholding it was
     * an ask that never returned.
     */
    lifetime: SubordinateLifetime;
  }): Promise<void>;
  assign(name: string, input: {
    body: string;
    mode: WorkMode;
    deliverable?: string;
    deadlineHint?: string;
    inheritedContext?: string;
  }): Promise<SubordinateHandoff>;
  status(name: string): Promise<SubordinateLiveStatus>;
  message(name: string, content: string, mode: WorkMode): Promise<SubordinateHandoff>;
  /** Write the child's own naming state. Called with `user` for an owner's
   *  rename, which is what makes the refusal in `planWorkspaceTitle` durable
   *  on the side that runs the title policy. */
  rename(name: string, displayName: string, nameOrigin: 'user' | 'auto'): Promise<void>;
  dismiss(name: string, keepHistory: boolean): Promise<void>;
}

export interface SubordinatesChangedEvent {
  type: 'subordinates_changed';
  subordinates: SubordinateRosterEntry[];
}

/** The catalog role an additional agent gets when the owner named none. It is
 *  the same default `AgentConfigStore.getRoleSelection` answers with, so an
 *  agent created with nothing said about it runs as the workspace's own kind
 *  of agent rather than a specialist nobody asked for. */
const DEFAULT_SUBORDINATE_ROLE_ID = 'general';

function displayNameForRole(role: string): string {
  return role.trim().split(/\s+/).slice(0, 4)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function rollback<T>(error: T, action: () => void, operation: string): never {
  try {
    action();
  } catch (rollbackError) {
    throw new AggregateError(
      [error, rollbackError],
      `${operation} failed and its roster rollback also failed`,
      { cause: error },
    );
  }
  throw error;
}

async function rollbackSpawn<T>(
  error: T,
  runtime: SubordinateRuntime,
  roster: SubordinateRosterStore,
  name: string,
  rosterCreated: boolean,
): Promise<never> {
  try {
    await runtime.dismiss(name, false);
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      'subordinate spawn failed and its facet cleanup also failed',
      { cause: error },
    );
  }

  if (rosterCreated) {
    try {
      roster.remove(name);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'subordinate spawn failed and its roster cleanup also failed',
        { cause: error },
      );
    }
  }
  throw error;
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


/** The one orchestration policy behind both the LLM agents tool and the future
 * user RPCs. Roster transitions happen before facet admission and are restored
 * exactly if admission fails. Broadcasts happen only after both sides settle. */
export function createTeamToolDeps(deps: {
  /** The hiring actor's own place in the tree — derived by ITS parent, never
   *  chosen here. */
  delegation: DelegationBudget;
  roster: SubordinateRosterStore;
  runtime: SubordinateRuntime;
  createName(role: string): string;
  now(): number;
  inheritedContext(): SerializedMessage[];
  /** THIS actor's own mission — the workspace's purpose as it knows it. What
   *  an owner-created additional agent inherits when the owner gave it none,
   *  because an agent added to a workspace is there for what the workspace is
   *  for. Read at create time rather than captured, so an agent added after
   *  the mission was edited inherits the current one. */
  ownMission(): string;
  broadcast(event: SubordinatesChangedEvent): void;
  broadcastTask(event: { subordinate: string; content: string; timestamp: number }): void;
  /**
   * The temporary-agent port, built ONCE per actor by its composition root.
   *
   * Not a store this function turns into a port, and the reason is the waiter:
   * the port holds the live `run` promises, and these deps are rebuilt per call
   * (owner state resolves late), so building the port here would hand the report
   * ingress a second one whose waiter map is empty — a run that could never be
   * answered. Lifetime belongs to whoever outlives a turn, which is the actor.
   *
   * Absent leaves an actor with the two durable rungs and no role-targeted ask —
   * structurally, in the schema, the sandbox namespace and the prompt alike.
   */
  temporary?: TemporaryAgentPort;
}): TeamToolDeps {
  /** One roster refresh per settled operation — the ONLY payload is the
   *  lifecycle roster; task content travels on its own task event. */
  const changed = () => {
    deps.broadcast({ type: 'subordinates_changed', subordinates: deps.roster.list() });
  };

  const provision = async (input: {
    name?: string;
    displayName?: string;
    /** The caller's resolved role selection; absent only for an owner who
     *  said nothing, which reads as the general catalog role. */
    role?: RoleSelection;
    tier?: TierId;
    mission?: string;
  }, ownerCreated: boolean, mode: WorkMode | null): Promise<{
    name: string;
    displayName: string;
    createdAt: number;
    subordinate: SubordinateRosterEntry;
  }> => {
    let selection: RoleSelection;
    if (input.role !== undefined) {
      if (input.role.kind === 'legacy' && optionalText(input.role.text) === undefined) {
        throw new Error('role must be non-empty');
      }
      selection = input.role;
    } else if (ownerCreated) {
      // The owner may say nothing at all. `spawn` has already refused an empty
      // mission by the time it reaches here, so this default is only ever the
      // owner's.
      selection = { kind: 'catalog', roleId: DEFAULT_SUBORDINATE_ROLE_ID };
    } else {
      throw new Error('role must be non-empty');
    }
    const roleLabel = selection.kind === 'catalog' ? selection.roleId : selection.text;
    const mission = ownerCreated
      ? requiredText(optionalText(input.mission) ?? deps.ownMission(), 'mission')
      : requiredText(input.mission ?? '', 'mission');
    const name = input.name?.trim() || deps.createName(roleLabel);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) {
      throw new Error('subordinate name must be a lowercase URL-safe slug (letters, digits, hyphens)');
    }
    if (deps.roster.get(name)) throw new Error(`subordinate "${name}" already exists`);

    // Whose title this is, decided by what the caller actually supplied. A
    // typed title is the owner's and final. A role — theirs or the model's —
    // yields the deterministic role name, which nobody chose but which says
    // something true, so it is `auto` and stands. Nothing said leaves the
    // title BLANK: there is no honest name yet, and a blank is what the
    // shared title policy reads as a placeholder it may claim once, from the
    // first thing the owner actually says to this agent.
    const chosen = optionalText(input.displayName);
    const provisional = ownerCreated && input.role === undefined;
    const displayName = chosen ?? (provisional ? '' : displayNameForRole(roleLabel));
    const nameOrigin: 'user' | 'auto' = chosen ? 'user' : 'auto';
    const seed: Parameters<SubordinateRuntime['spawn']>[0] = {
      name,
      displayName,
      nameOrigin,
      mission,
      role: selection,
      // Every child this path creates is DURABLE. The task lifetime has ONE
      // producer, `createTemporaryAgentPort`, so no caller of `hire` or `create`
      // can seed a child that retires itself.
      lifetime: 'durable',
    };
    if (input.tier !== undefined) seed.tier = input.tier;
    await deps.runtime.spawn(seed);
    let rosterCreated = false;
    const createdAt = deps.now();
    try {
      const subordinate: SubordinateRosterEntry = {
        name,
        createdBy: ownerCreated ? 'user' : 'orchestrator',
        status: ownerCreated ? 'idle' : 'working',
        currentTask: ownerCreated ? null : mission,
        createdAt,
        dismissedAt: null,
        // Every helper this path creates is DURABLE. The task lifetime has one
        // producer — `createTemporaryAgentPort` — so no caller of `hire` or
        // `create` can mint a row that retires itself.
        lifetime: 'durable',
        taskEventId: null,
      };
      deps.roster.create(subordinate);
      rosterCreated = true;
      if (!ownerCreated) {
        if (mode === null) throw new Error('subordinate task mode is required');
        const inheritedContext = renderSubordinateInheritedContext(deps.inheritedContext());
        const assignment: Parameters<SubordinateRuntime['assign']>[1] = {
          body: mission,
          mode,
        };
        if (inheritedContext) Object.assign(assignment, { inheritedContext });
        // The mission IS this row's first assignment, so the row names its event
        // like any other. Without this a hire's opening turn was the one
        // assignment whose report had nothing on the roster to cite.
        const handoff = await deps.runtime.assign(name, assignment);
        deps.roster.recordAssignmentEvent(name, handoff.eventId);
      }
    } catch (error) {
      await rollbackSpawn(error, deps.runtime, deps.roster, name, rosterCreated);
    }
    return {
      name,
      displayName,
      createdAt,
      subordinate: deps.roster.requireActive(name),
    };
  };

  const team: TeamToolDeps = {
    delegation: deps.delegation,
    snapshot: () => deps.roster.list(),
    list: async () => deps.roster.list(),

    create: async (input) => {
      const { name, displayName, subordinate } = await provision(input, true, null);
      changed();
      return { name, displayName, subordinate };
    },

    // The child's own agent_config is the only naming authority: a rename
    // delegates to it and refreshes the roster listeners once it settles.
    rename: async (input) => {
      const displayName = requiredText(input.displayName, 'displayName');
      await deps.runtime.rename(input.name, displayName, 'user');
      changed();
      return {
        ok: true, name: input.name, displayName,
        subordinate: deps.roster.requireActive(input.name),
      };
    },

    /** The child already settled this title on its own naming state; the
     *  parent holds no mirror, so this only refreshes roster listeners. */
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
      const before = deps.roster.requireActive(input.name);
      deps.roster.assign(input.name, task);
      let handoff: SubordinateHandoff;
      try {
        const deliverable = optionalText(input.deliverable);
        const deadlineHint = optionalText(input.deadlineHint);
        const inheritedContext = renderSubordinateInheritedContext(deps.inheritedContext());
        const assignment: Parameters<SubordinateRuntime['assign']>[1] = {
          body: task,
          mode: input.mode,
        };
        if (deliverable) Object.assign(assignment, { deliverable });
        if (deadlineHint) Object.assign(assignment, { deadlineHint });
        if (inheritedContext) Object.assign(assignment, { inheritedContext });
        handoff = await deps.runtime.assign(input.name, assignment);
      } catch (error) {
        rollback(error, () => deps.roster.restore(before), 'subordinate assignment');
      }
      // The row names the assignment its report will cite, for every lifetime:
      // one correlation, written where the roster transition already is.
      deps.roster.recordAssignmentEvent(input.name, handoff.eventId);
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
      const before = deps.roster.requireActive(input.name);
      deps.roster.resumeAfterMessage(input.name);
      let handoff: SubordinateHandoff;
      try {
        handoff = await deps.runtime.message(input.name, content, input.mode);
      } catch (error) {
        rollback(error, () => deps.roster.restore(before), 'subordinate message');
      }
      changed();
      return { ok: true, name: input.name, ...handoff };
    },

    dismiss: async (input) => {
      const before = deps.roster.requireExisting(input.name);
      if (before.createdBy === 'user' && input.requestedBy !== 'user') {
        throw new Error(`subordinate "${input.name}" was created by the owner and only the owner can dismiss it`);
      }
      // Archive by default: the facet and its context are kept (merely no
      // longer addressed), so a dismissal is never silent data loss. Wiping
      // the subordinate's storage requires an explicit keepHistory=false.
      const keepHistory = input.keepHistory ?? true;
      deps.roster.dismiss(input.name, deps.now());
      try {
        await deps.runtime.dismiss(input.name, keepHistory);
      } catch (error) {
        rollback(error, () => deps.roster.restore(before), 'subordinate dismissal');
      }
      changed();
      return { ok: true, name: input.name, historyKept: keepHistory };
    },
  };
  // Attached only when the backend built one. Assigned rather than spread from a
  // conditional empty object: an absent port has to be an ABSENT key, because
  // every gate on this rung — the schema, the sandbox declaration, the prompt —
  // reads its presence.
  if (deps.temporary) Object.assign(team, { temporary: deps.temporary });
  return team;
}
