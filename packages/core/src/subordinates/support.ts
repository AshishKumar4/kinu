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

import type { EventLog, PublishResult } from '../events/hub/log.js';
import type { SubordinateReportStatus } from '../events/hub/types.js';
import type { SerializedMessage } from '../heads/types.js';
import type { SqlExec } from '../types/primitives.js';
import type {
  SubordinateHandoff,
  SubordinateRosterEntry,
  SubordinateStatus,
  TeamToolDeps,
} from '../tools/agents-tool.js';

export interface SubordinateLiveStatus {
  lastActivity: number | null;
  recentSteps: Array<{
    event: string;
    summary: string;
    elapsedMs: number;
    createdAt: number;
  }>;
}

export function readSubordinateLiveStatus(sql: SqlExec): SubordinateLiveStatus {
  const recentSteps = sql.exec(
    `SELECT event, detail, elapsed_ms, created_at
     FROM activity_log
     ORDER BY created_at DESC, id DESC
     LIMIT 5`,
  ).toArray().flatMap((row) => {
    const event = readString(row, 'event');
    const detail = row.detail;
    const elapsedMs = row.elapsed_ms;
    const createdAt = row.created_at;
    if (event === null || (detail !== null && typeof detail !== 'string')
      || typeof elapsedMs !== 'number' || typeof createdAt !== 'number') return [];
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

export interface SubordinateIdentity {
  name: string;
  displayName: string;
  role: string;
  mission: string;
  parentWorkspace: string;
  ownerUserId: string;
}

interface IdentityRow {
  name: string;
  display_name: string;
  role: string;
  mission: string;
  parent_workspace: string;
  owner_user_id: string;
}

function readString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function parseIdentityRow(row: Record<string, unknown>): IdentityRow | null {
  const name = readString(row, 'name');
  const displayName = readString(row, 'display_name');
  const role = readString(row, 'role');
  const mission = readString(row, 'mission');
  const parentWorkspace = readString(row, 'parent_workspace');
  const ownerUserId = readString(row, 'owner_user_id');
  return name !== null && displayName !== null && role !== null && mission !== null
    && parentWorkspace !== null && ownerUserId !== null
    ? {
        name,
        display_name: displayName,
        role,
        mission,
        parent_workspace: parentWorkspace,
        owner_user_id: ownerUserId,
      }
    : null;
}

function mapIdentityRow(row: IdentityRow): SubordinateIdentity {
  return {
    name: row.name,
    displayName: row.display_name,
    role: row.role,
    mission: row.mission,
    parentWorkspace: row.parent_workspace,
    ownerUserId: row.owner_user_id,
  };
}

function identitiesEqual(a: SubordinateIdentity, b: SubordinateIdentity): boolean {
  return a.name === b.name
    && a.displayName === b.displayName
    && a.role === b.role
    && a.mission === b.mission
    && a.parentWorkspace === b.parentWorkspace
    && a.ownerUserId === b.ownerUserId;
}

/** Immutable facet identity. The parent may retry the exact seed after an RPC
 * interruption, but no caller can retarget an initialized facet to another
 * workspace or owner. */
export class SubordinateIdentityStore {
  constructor(private readonly sql: SqlExec) {}

  ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS subordinate_identity (
      id               INTEGER PRIMARY KEY CHECK (id = 1),
      name             TEXT NOT NULL,
      display_name     TEXT NOT NULL,
      role             TEXT NOT NULL,
      mission          TEXT NOT NULL,
      parent_workspace TEXT NOT NULL,
      owner_user_id    TEXT NOT NULL
    )`);
  }

  seed(identity: SubordinateIdentity): void {
    const existing = this.read();
    if (existing) {
      if (identitiesEqual(existing, identity)) return;
      throw new Error('Subordinate identity is already initialized and cannot be changed.');
    }
    this.sql.exec(
      `INSERT INTO subordinate_identity
         (id, name, display_name, role, mission, parent_workspace, owner_user_id)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
      identity.name,
      identity.displayName,
      identity.role,
      identity.mission,
      identity.parentWorkspace,
      identity.ownerUserId,
    );
  }

  read(): SubordinateIdentity | null {
    const rows = this.sql.exec(
      `SELECT name, display_name, role, mission, parent_workspace, owner_user_id
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
}

interface RosterRow {
  name: string;
  display_name: string;
  role: string;
  created_by: 'orchestrator' | 'user';
  status: SubordinateStatus;
  current_task: string | null;
  created_at: number;
  dismissed_at: number | null;
}

const ROSTER_COLUMNS =
  'name, display_name, role, created_by, status, current_task, created_at, dismissed_at';

function isSubordinateStatus(value: unknown): value is SubordinateStatus {
  return value === 'idle' || value === 'working'
    || value === 'awaiting_input' || value === 'dismissed';
}

function parseRosterRow(row: Record<string, unknown>): RosterRow | null {
  const name = readString(row, 'name');
  const displayName = readString(row, 'display_name');
  const role = readString(row, 'role');
  const createdBy = row.created_by;
  const status = row.status;
  const currentTask = row.current_task;
  const createdAt = row.created_at;
  const dismissedAt = row.dismissed_at;
  if (name === null || displayName === null || role === null) return null;
  if (createdBy !== 'orchestrator' && createdBy !== 'user') return null;
  if (!isSubordinateStatus(status)) return null;
  if (currentTask !== null && typeof currentTask !== 'string') return null;
  if (typeof createdAt !== 'number') return null;
  if (dismissedAt !== null && typeof dismissedAt !== 'number') return null;
  return {
    name,
    display_name: displayName,
    role,
    created_by: createdBy,
    status,
    current_task: currentTask,
    created_at: createdAt,
    dismissed_at: dismissedAt,
  };
}

function mapRosterRow(row: RosterRow): SubordinateRosterEntry {
  return {
    name: row.name,
    displayName: row.display_name,
    role: row.role,
    createdBy: row.created_by,
    status: row.status,
    currentTask: row.current_task,
    createdAt: row.created_at,
    dismissedAt: row.dismissed_at,
  };
}

function parseStoredRosterRow(row: Record<string, unknown>): SubordinateRosterEntry {
  const parsed = parseRosterRow(row);
  if (!parsed) throw new Error('Stored subordinate roster row is malformed.');
  return mapRosterRow(parsed);
}

/** Parent-DO product roster. All status policy lives here so tools, report
 * ingress, snapshots, and the future UI cannot drift. */
export class SubordinateRosterStore {
  constructor(private readonly sql: SqlExec) {}

  ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS workspace_subordinates (
      name          TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      role          TEXT NOT NULL,
      created_by    TEXT NOT NULL CHECK (created_by IN ('orchestrator','user')),
      status        TEXT NOT NULL CHECK (status IN ('idle','working','awaiting_input','dismissed')),
      current_task  TEXT,
      created_at    INTEGER NOT NULL,
      dismissed_at INTEGER
    )`);
  }

  create(entry: SubordinateRosterEntry): void {
    this.sql.exec(
      `INSERT INTO workspace_subordinates (${ROSTER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.name,
      entry.displayName,
      entry.role,
      entry.createdBy,
      entry.status,
      entry.currentTask,
      entry.createdAt,
      entry.dismissedAt,
    );
  }

  /** Exact upsert used only for compensating a failed facet operation. */
  restore(entry: SubordinateRosterEntry): void {
    this.sql.exec(
      `INSERT INTO workspace_subordinates (${ROSTER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         display_name = excluded.display_name,
         role = excluded.role,
         created_by = excluded.created_by,
         status = excluded.status,
         current_task = excluded.current_task,
         created_at = excluded.created_at,
         dismissed_at = excluded.dismissed_at`,
      entry.name,
      entry.displayName,
      entry.role,
      entry.createdBy,
      entry.status,
      entry.currentTask,
      entry.createdAt,
      entry.dismissedAt,
    );
  }

  remove(name: string): void {
    this.sql.exec(`DELETE FROM workspace_subordinates WHERE name = ?`, name);
  }

  get(name: string): SubordinateRosterEntry | null {
    const rows = this.sql.exec(
      `SELECT ${ROSTER_COLUMNS} FROM workspace_subordinates WHERE name = ?`,
      name,
    ).toArray();
    return rows.length === 0 ? null : parseStoredRosterRow(rows[0]);
  }

  requireExisting(name: string): SubordinateRosterEntry {
    const entry = this.get(name);
    if (!entry) throw new Error(`unknown subordinate "${name}"`);
    return entry;
  }

  requireActive(name: string): SubordinateRosterEntry {
    const entry = this.requireExisting(name);
    if (entry.status === 'dismissed') throw new Error(`subordinate "${name}" is dismissed`);
    return entry;
  }

  list(): SubordinateRosterEntry[] {
    return this.sql.exec(
      `SELECT ${ROSTER_COLUMNS} FROM workspace_subordinates
       WHERE status != 'dismissed' ORDER BY created_at, name`,
    ).toArray().map(parseStoredRosterRow);
  }

  listAll(): SubordinateRosterEntry[] {
    return this.sql.exec(
      `SELECT ${ROSTER_COLUMNS} FROM workspace_subordinates ORDER BY created_at, name`,
    ).toArray().map(parseStoredRosterRow);
  }

  assign(name: string, task: string): void {
    this.requireActive(name);
    this.sql.exec(
      `UPDATE workspace_subordinates
       SET status = 'working', current_task = ?, dismissed_at = NULL
       WHERE name = ?`,
      task,
      name,
    );
  }

  resumeAfterMessage(name: string): void {
    const entry = this.requireActive(name);
    if (entry.status !== 'awaiting_input') return;
    this.sql.exec(
      `UPDATE workspace_subordinates SET status = 'working' WHERE name = ?`,
      name,
    );
  }

  applyReport(name: string, status: SubordinateReportStatus): void {
    const entry = this.requireActive(name);
    const rosterStatus: SubordinateStatus = status === 'completed'
      ? 'idle'
      : status === 'blocked'
        ? 'awaiting_input'
        : entry.currentTask
          ? 'working'
          : 'idle';
    this.sql.exec(
      `UPDATE workspace_subordinates
       SET status = ?, current_task = CASE WHEN ? = 'completed' THEN NULL ELSE current_task END
       WHERE name = ?`,
      rosterStatus,
      status,
      name,
    );
  }

  dismiss(name: string, now: number): void {
    this.requireExisting(name);
    this.sql.exec(
      `UPDATE workspace_subordinates
       SET status = 'dismissed', current_task = NULL, dismissed_at = COALESCE(dismissed_at, ?)
       WHERE name = ?`,
      now,
      name,
    );
  }
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
// staffed should not be one screen of head-only fragments.
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
  now: number;
}): PublishResult {
  const fromWorkspace = requiredText(input.fromWorkspace, 'fromWorkspace');
  const body = requiredText(input.body, 'body');
  const deliverable = optionalText(input.deliverable);
  const deadlineHint = optionalText(input.deadlineHint);
  const inheritedContext = optionalText(input.inheritedContext);
  return log.publish({
    descriptor: {
      ingress: 'subordinate',
      variant: 'subordinate_task',
      payload: {
        from_workspace: fromWorkspace,
        kind: input.kind,
        body,
        ...(deliverable ? { deliverable } : {}),
        ...(deadlineHint ? { deadline_hint: deadlineHint } : {}),
        ...(inheritedContext ? { inherited_context: inheritedContext } : {}),
      },
    },
    now: input.now,
  });
}

/**
 * The sender-visible half of an admission.
 *
 * `turnInFlight` is the subordinate's live-turn flag read at admission time: a
 * drain batch bound while a turn is live splices into that turn's next step
 * (BackendHost.turnInFlight) instead of queueing behind it, so a busy
 * subordinate is steered rather than blocked. A duplicate admission scheduled
 * no drain of its own — it lands with the backlog that is already waiting.
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
      : input.turnInFlight ? 'steering_live_turn' : 'starts_now',
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
 * A subordinate answers to two audiences and only one of them is its parent.
 * `report_tool` is the subordinate deliberately choosing to speak upward.
 * `turn_end` is the automatic relay of a finished turn's answer, which belongs
 * to whoever asked the question — and that is not always the parent.
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
 * is waiting on this subordinate for anything. A deliberate `report` always
 * enters: the subordinate chose to speak, and that choice is the whole contract.
 * An automatic turn-end relay enters only while the roster still shows work the
 * parent actually handed over. With no open assignment the turn was driven by
 * something downstream of the owner's own conversation — most often a
 * background job that conversation detached, which wakes the subordinate
 * programmatically and would otherwise smuggle the owner's dialogue upward one
 * hop removed.
 */
export function parentAdmitsSubordinateReport(input: {
  origin: SubordinateReportOrigin;
  entry: SubordinateRosterEntry;
}): boolean {
  return input.origin === 'report_tool' || input.entry.currentTask !== null;
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
  task?: string;
  contentPath?: string;
  now: number;
}): PublishResult {
  const fromSubordinate = requiredText(input.fromSubordinate, 'fromSubordinate');
  const content = normalizeReportContent(input.content);
  const task = optionalText(input.task);
  return log.publish({
    descriptor: {
      ingress: 'subordinate',
      variant: 'subordinate_report',
      payload: {
        from_subordinate: fromSubordinate,
        status: input.status,
        content,
        ...(task ? { task } : {}),
        ...(input.contentPath ? { content_path: input.contentPath } : {}),
      },
    },
    now: input.now,
  });
}

export interface SubordinateRuntime {
  spawn(input: {
    name: string;
    displayName: string;
    role: string;
    mission: string;
    model?: string;
  }): Promise<void>;
  assign(name: string, input: {
    body: string;
    deliverable?: string;
    deadlineHint?: string;
    inheritedContext?: string;
  }): Promise<SubordinateHandoff>;
  status(name: string): Promise<unknown>;
  message(name: string, content: string): Promise<SubordinateHandoff>;
  dismiss(name: string, keepHistory: boolean): Promise<void>;
}

export interface SubordinatesChangedEvent {
  type: 'subordinates_changed';
  subordinates: SubordinateRosterEntry[];
  assignedTask?: {
    name: string;
    task: string;
  };
}

function displayNameForRole(role: string): string {
  return role.trim().split(/\s+/).slice(0, 4)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function rollback(error: unknown, action: () => void, operation: string): never {
  try {
    action();
  } catch (rollbackError) {
    throw new AggregateError(
      [error, rollbackError],
      `${operation} failed and its roster rollback also failed`,
    );
  }
  throw error;
}

async function rollbackSpawn(
  error: unknown,
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
    );
  }

  if (rosterCreated) {
    try {
      roster.remove(name);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'subordinate spawn failed and its roster cleanup also failed',
      );
    }
  }
  throw error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function statusView(
  runtime: SubordinateRuntime,
  roster: SubordinateRosterEntry,
): Promise<{ roster: SubordinateRosterEntry; live: unknown; liveError?: string }> {
  if (roster.status === 'dismissed') return { roster, live: null };
  try {
    return { roster, live: await runtime.status(roster.name) };
  } catch (error) {
    return { roster, live: null, liveError: errorMessage(error) };
  }
}

/** The one orchestration policy behind both the LLM agents tool and the future
 * user RPCs. Roster transitions happen before facet admission and are restored
 * exactly if admission fails. Broadcasts happen only after both sides settle. */
export function createTeamToolDeps(deps: {
  roster: SubordinateRosterStore;
  runtime: SubordinateRuntime;
  createName(role: string): string;
  now(): number;
  inheritedContext(): SerializedMessage[];
  broadcast(event: SubordinatesChangedEvent): void;
  broadcastTask(event: { subordinate: string; content: string; timestamp: number }): void;
}): TeamToolDeps {
  const changed = (assignedTask?: SubordinatesChangedEvent['assignedTask']) => deps.broadcast({
    type: 'subordinates_changed',
    subordinates: deps.roster.list(),
    ...(assignedTask ? { assignedTask } : {}),
  });

  return {
    list: async () => deps.roster.list(),

    spawn: async (input) => {
      const role = requiredText(input.role, 'role');
      const mission = requiredText(input.mission, 'mission');
      const name = input.name?.trim() || deps.createName(role);
      if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) {
        throw new Error('subordinate name must be a lowercase URL-safe slug (letters, digits, hyphens)');
      }
      if (deps.roster.get(name)) throw new Error(`subordinate "${name}" already exists`);

      const displayName = displayNameForRole(role);
      await deps.runtime.spawn({
        name,
        displayName,
        role,
        mission,
        ...(input.model ? { model: input.model } : {}),
      });
      let rosterCreated = false;
      const createdAt = deps.now();
      try {
        deps.roster.create({
          name,
          displayName,
          role,
          createdBy: input.createdBy ?? 'orchestrator',
          status: 'working',
          currentTask: mission,
          createdAt,
          dismissedAt: null,
        });
        rosterCreated = true;
        const inheritedContext = renderSubordinateInheritedContext(deps.inheritedContext());
        await deps.runtime.assign(name, {
          body: mission,
          ...(inheritedContext ? { inheritedContext } : {}),
        });
      } catch (error) {
        await rollbackSpawn(error, deps.runtime, deps.roster, name, rosterCreated);
      }
      changed({ name, task: mission });
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
        handoff = await deps.runtime.assign(input.name, {
          body: task,
          ...(deliverable ? { deliverable } : {}),
          ...(deadlineHint ? { deadlineHint } : {}),
          ...(inheritedContext ? { inheritedContext } : {}),
        });
      } catch (error) {
        rollback(error, () => deps.roster.restore(before), 'subordinate assignment');
      }
      changed({ name: input.name, task });
      deps.broadcastTask({ subordinate: input.name, content: task, timestamp: deps.now() });
      return { ok: true, name: input.name, ...handoff };
    },

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
        handoff = await deps.runtime.message(input.name, content);
      } catch (error) {
        rollback(error, () => deps.roster.restore(before), 'subordinate message');
      }
      changed();
      return { ok: true, name: input.name, ...handoff };
    },

    dismiss: async (input) => {
      const before = deps.roster.requireExisting(input.name);
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
}
