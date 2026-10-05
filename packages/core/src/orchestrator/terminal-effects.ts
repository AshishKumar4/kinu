/**
 * One durable row per side effect a settled turn owes, all claimed before any runs, so an interruption
 * leaves a replayable suffix. Every effect must be idempotent or keyed. Rows carry a versioned key
 * (mismatch: blocked), the recorded input, and a disposition plus schedule; definitive failures end one unrun.
 * `TerminalTransitions.end` settles only when no row is owed.
 */
import * as v from 'valibot';

import { parseJsonValue, JsonValueSchema, type JsonValue } from '../utils/json';
import {
  OUTPUT_CONTINUATION_EVENT, OUTPUT_CONTINUATION_TEXT, RUN_END_REASONS,
} from './turn-lifecycle';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { writeActivityLog } from '../identity/activity-log';
import { OWNER_FIXABLE_REFUSALS, providerRefusalCode, providerStatusOf } from '../providers/util';
import type { AgentOrchestrator, TurnContinuity } from './agent-orchestrator';
import type { EvolutionEngine } from '../evolution/engine';
import type { HeadJournal } from '../heads/journal';
import { CompletedTurnSchema } from '../evolution/session-window';
import { WorkModeSchema } from '../types/turn';
import {
  branchHeadId, branchOutcomeFromJournal, settleBranchIntoTakes, settlePendingBranch,
  type BranchStatusEvent, type PendingBranch,
} from '../steer-branch';
import { diagnostics, toKinuError, type ErrorCode } from '../obs/index';
import { OVERFLOW_RETRY_EVENT, OVERFLOW_RETRY_TEXT } from '../turn-failure';
import { TASK_REMINDER_EVENT, taskReminderIdempotencyKey } from '../tasks/reminder';

/** The picklist is {@link RUN_END_REASONS}, so a stored row cannot carry an unknown word. */
export const RunEndReasonSchema = v.picklist(RUN_END_REASONS);

/** Recorded rather than re-read: a fresh actor defaults to `conversation`. */
const TurnContinuitySchema: v.GenericSchema<TurnContinuity> = v.union([
  v.literal('conversation'), v.literal('independent_task'),
]);

/** Bumped when what an effect records changes meaning, not its implementation. */
const TERMINAL_EFFECT_KEY_VERSION = 'v1';

/** An empty scope is not an identity: such a sequence runs unledgered and its bodies key nothing. */
function keyedScope(scope: string): string | undefined {
  return scope === '' ? undefined : scope;
}

/** No attempt limit: a bound on attempts is a bound on lost work. */
export const TERMINAL_EFFECT_RETRY_BASE_MS = 5_000;

export const TERMINAL_EFFECT_RETRY_CEILING_MS = 600_000;

/** A retry cannot repair a missing route, malformed request, or unusable model answer. */
const DEFINITIVE_FAILURES: ReadonlySet<ErrorCode> = new Set(['missing', 'bad_input']);

export function isDefinitiveTerminalFailure(code: ErrorCode): boolean {
  return DEFINITIVE_FAILURES.has(code);
}

/** The owner reads an abandoned effect in the Activity log, by what it was doing. */
const EFFECT_ACTIVITY: Partial<Record<TerminalEffectName, string>> = {
  sleep_time: 'memory compression', auto_title: 'naming the chat',
  improvement_lanes: 'self-improvement', turn_record: 'recording the turn',
  turn_lessons: 'learning from the turn\'s struggles',
};

/** Doubling from the base delay to the ceiling. */
function terminalEffectBackoffMs(attempts: number): number {
  const grown = TERMINAL_EFFECT_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);

  return Math.min(grown, TERMINAL_EFFECT_RETRY_CEILING_MS);
}

/** A row naming anything else is blocked; each actor's {@link TerminalEffectTable} picks its subset. */
const TERMINAL_EFFECT_NAMES = [
  'craft_usage', 'event_reply', 'branches',
  // Its armed state lives in RAM, so this row alone records whether the confirming turn was enqueued.
  'completion_gate',
  // Five separately claimed boundaries, each idempotent and keyed on the turn. `overflow_retry` and
  // `output_continuation` are mutually exclusive.
  'turn_end_extensions', 'overflow_retry', 'output_continuation', 'task_reminder',
  'turn_record', 'event_drain', 'improvement_lanes',
  // Detached: its reflection is a model call that waits on no reply; the row is its one owner, retried and parked.
  'turn_lessons',
  // Detached: the review is a model call the next turn must not wait on; a replay finds its note already recorded.
  'advisor_review',
  'sleep_time', 'auto_title',
  'parent_report',
  // Retired (docs/EVOLUTION-REDESIGN.md §6): no turn owes them, and a row an older build wrote completes unrun.
  'shadow_trial', 'auto_gepa',
] as const;

const RETIRED_TERMINAL_EFFECTS: ReadonlySet<TerminalEffectName> = new Set(['shadow_trial', 'auto_gepa']);

export type TerminalEffectName = (typeof TERMINAL_EFFECT_NAMES)[number];

const TerminalEffectNameSchema = v.picklist(TERMINAL_EFFECT_NAMES);

/** The newest row covers the older ones: an actor owes at most one (T2). */
const COALESCED_EFFECTS: readonly TerminalEffectName[] = ['sleep_time'];


/** `blocked` (unknown key version or effect) is still owed and reported: a deploy-shape problem a human resolves. */
export type TerminalEffectStatus = 'pending' | 'completed' | 'blocked' | 'parked';

/** `owed`: the effect ran, reported unfinished, and stays owed. */
export type TerminalEffectOutcome =
  | { readonly status: 'completed'; readonly detail?: string }
  /** `held`: a live carrier already owns the work; the backoff is not doubled. */
  | { readonly status: 'owed'; readonly detail: string; readonly held?: boolean };

/** Built through {@link terminalEffect} so each entry keeps its real input type without casts. */
export type TerminalEffect =
  | { readonly synchronous: true; readonly run: (input: JsonValue, scope: string) => TerminalEffectOutcome }
  | { readonly synchronous: false; readonly run: (input: JsonValue, scope: string) => Promise<TerminalEffectOutcome> };

/** Partial: an undeclared entry must not exist as a silently succeeding shell; its rows are blocked by name. */
export type TerminalEffectTable = Readonly<Partial<Record<TerminalEffectName, TerminalEffect>>>;

export function terminalEffect<I>(spec: {
  readonly input: v.GenericSchema<unknown, I>;
} & (
  | {
    /** No await: inline SQL and disposition commit together. Fire-and-forget work is outside this transaction and retry. */
    readonly runSync: (input: I, scope: string) => TerminalEffectOutcome;
  }
  | { readonly run: (input: I, scope: string) => Promise<TerminalEffectOutcome> | TerminalEffectOutcome }
)): TerminalEffect {
  return 'runSync' in spec
    ? { synchronous: true, run: (raw, scope) => spec.runSync(v.parse(spec.input, raw), scope) }
    : { synchronous: false, run: async (raw, scope) => await spec.run(v.parse(spec.input, raw), scope) };
}

const RETIRED_EFFECT = terminalEffect({ input: v.unknown(), runSync: () => ({ status: 'completed', detail: 'the effect is retired' }) });

/** `announcementOnDisk` is the backend's durable answer; a queued turn is only RAM until it says yes. */
export interface OwedTurnQueue {
  announcementOnDisk(identity: string): boolean;
  announcementInFlight(identity: string): boolean;
  appendOwedTurn(turn: { readonly text: string; readonly idempotencyKey: string; readonly event: string }): void;
}

/** Owed until the follow-up turn's own durable row exists; queued once per response key. */
function owedTurnTerminalEffect<I>(queue: () => OwedTurnQueue, spec: {
  readonly input: v.GenericSchema<unknown, I>;
  readonly event: string;
  readonly text: (input: I) => string;
  readonly key: (scope: string) => string;
}): TerminalEffect {
  return terminalEffect({
    input: spec.input,
    runSync: (input, scope) => {
      // An unkeyed response has no replay to dedupe against: its turn is its own.
      const identity = spec.key(keyedScope(scope) ?? crypto.randomUUID());
      const loop = queue();

      if (loop.announcementOnDisk(identity)) return { status: 'completed', detail: 'the follow-up turn is on disk' };

      if (!loop.announcementInFlight(identity)) {
        loop.appendOwedTurn({ text: spec.text(input), idempotencyKey: identity, event: spec.event });
      }

      return { status: 'owed', detail: 'the follow-up turn is queued and not yet on disk' };
    },
  });
}

function fixedOwedTurnEffect(
  queue: () => OwedTurnQueue,
  owed: { readonly event: string; readonly text: string; readonly prefix: string },
): TerminalEffect {
  return owedTurnTerminalEffect(queue, {
    input: v.object({}), event: owed.event, text: () => owed.text,
    key: (scope) => `${owed.prefix}:${scope}`,
  });
}

function overflowRetryTerminalEffect(queue: () => OwedTurnQueue): TerminalEffect {
  return fixedOwedTurnEffect(queue, { event: OVERFLOW_RETRY_EVENT, text: OVERFLOW_RETRY_TEXT, prefix: 'overflow-retry' });
}

/** Think's loop cannot extend past a `length` finish, so the continuation is the next turn, owed durably. */
function outputLimitContinuationTerminalEffect(queue: () => OwedTurnQueue): TerminalEffect {
  return fixedOwedTurnEffect(queue, { event: OUTPUT_CONTINUATION_EVENT, text: OUTPUT_CONTINUATION_TEXT, prefix: 'output-continuation' });
}

/** The text is a recorded input: a replay announces what the turn was owed. */
function taskReminderTerminalEffect(queue: () => OwedTurnQueue): TerminalEffect {
  return owedTurnTerminalEffect(queue, {
    input: v.object({ text: v.string() }), event: TASK_REMINDER_EVENT, text: ({ text }) => text,
    key: taskReminderIdempotencyKey,
  });
}

/** The bodies every chat backend owes alike: the loop's follow-up turns, the recording, the lessons and the drain. */
export function chatTerminalEffects(deps: {
  readonly chat: () => OwedTurnQueue;
  readonly orchestrator: Pick<AgentOrchestrator, 'recordTurn' | 'recordedTurn' | 'drainPendingEvents'>;
  readonly engine: Pick<EvolutionEngine, 'learnFromTurn'>;
}): TerminalEffectTable {
  return {
    overflow_retry: overflowRetryTerminalEffect(deps.chat),
    output_continuation: outputLimitContinuationTerminalEffect(deps.chat),
    task_reminder: taskReminderTerminalEffect(deps.chat),
    turn_record: turnRecordTerminalEffect(deps.orchestrator),
    turn_lessons: turnLessonsTerminalEffect(deps.engine),
    event_drain: eventDrainTerminalEffect(deps.orchestrator),
  };
}

/**
 * One steer branch, awaited. Without a live handle the head journal is the record, asked by `branchHeadId`
 * (not the run id), and the row's disposition is the settlement marker. The branch id keys both paths.
 */
export function branchesTerminalEffect(deps: {
  readonly sql: SqlExecutor;
  readonly actor: ActorHandle;
  readonly sessionId: string;
  readonly broadcast: (event: BranchStatusEvent) => void;
  /** A settled branch is removed. */
  readonly pending: PendingBranch[];
  readonly journal: Pick<HeadJournal, 'readHeadView'>;
}): TerminalEffect {
  return terminalEffect({
    input: v.object({
      id: v.string(), task: v.string(),
      turnId: v.nullable(v.string()), liveText: v.string(),
    }),
    run: async ({ id, task, turnId, liveText }) => {
      const live = deps.pending.findIndex((entry) => entry.id === id);

      if (live >= 0) {
        const [entry] = deps.pending.splice(live, 1);

        if (entry !== undefined) {
          const outcome = await settlePendingBranch(
            { sql: deps.sql, actor: deps.actor, sessionId: deps.sessionId, broadcast: deps.broadcast },
            { entry, turnId, liveText, settlementKey: id },
          );

          return { status: 'completed', detail: outcome.ok ? undefined : outcome.reason };
        }
      }

      const head = deps.journal.readHeadView(branchHeadId(id));

      if (head === null) {
        return { status: 'completed', detail: 'the journal holds no such branch head' };
      }

      const report = branchOutcomeFromJournal(head);

      if (report === null) {
        return { status: 'owed', held: true, detail: `branch head is ${head.status}` };
      }

      const outcome = settleBranchIntoTakes(deps.sql, deps.actor, {
        task, report, turnId, sessionId: deps.sessionId, liveText, settlementKey: id,
      });

      deps.broadcast(outcome.ok
        ? {
          type: 'branch_status', status: 'settled', branchId: id, task,
          takeSetId: outcome.set.id, turnId: turnId ?? '',
        }
        : { type: 'branch_status', status: 'error', branchId: id, task, message: outcome.reason });

      return { status: 'completed', detail: outcome.ok ? undefined : outcome.reason };
    },
  });
}

/** The window append is idempotent on the message's identity. Continuity, mode and the evolution gate come off the row. A plan turn records nothing. */
function turnRecordTerminalEffect(
  orch: Pick<AgentOrchestrator, 'recordTurn' | 'recordedTurn'>,
): TerminalEffect {
  return terminalEffect({
    input: v.object({
      messageId: v.string(), status: RunEndReasonSchema, turn: JsonValueSchema,
      continuity: TurnContinuitySchema, workMode: WorkModeSchema, recordedAt: v.number(),
      autoEvolve: v.boolean(),
    }),
    runSync: ({ messageId, status, turn, continuity, workMode, recordedAt, autoEvolve }) => {
      if (workMode === 'plan') {
        return { status: 'completed', detail: 'a plan turn records no evolution state' };
      }

      // Unkeyed for an empty id: every such response would share one key.
      const recordedId = keyedScope(messageId);
      orch.recordTurn(
        orch.recordedTurn(status, v.parse(CompletedTurnSchema, turn)),
        continuity,
        recordedId === undefined
          ? { recordedAt, enabled: autoEvolve }
          : { recordedAt, enabled: autoEvolve, id: `turn-${recordedId}` },
      );

      return autoEvolve
        ? { status: 'completed' }
        : { status: 'completed', detail: 'the turn was produced with auto-evolution off' };
    },
  });
}

/** Each part is tombstoned on the turn, so a retry neither rescores nor asks again; a refusal throws, for the ledger. */
function turnLessonsTerminalEffect(engine: Pick<EvolutionEngine, 'learnFromTurn'>): TerminalEffect {
  return terminalEffect({
    input: v.object({ turn: JsonValueSchema }),
    run: async ({ turn }) => {
      await engine.learnFromTurn(v.parse(CompletedTurnSchema, turn));

      return { status: 'completed' };
    },
  });
}

/** Idempotent (PENDING, unbound rows only). Rethrows: `completed` over a half-bound batch strands the assignment. */
function eventDrainTerminalEffect(
  orch: Pick<AgentOrchestrator, 'drainPendingEvents'>,
): TerminalEffect {
  return terminalEffect({
    input: v.object({}),
    run: async () => {
      await orch.drainPendingEvents({ rethrow: true });

      return { status: 'completed' };
    },
  });
}

/** `lane` concerns the turn queue only: `detached` effects start in order and join before the outer transition settles. Not stored; recovery awaits everything. */
export interface OwedEffect {
  readonly name: TerminalEffectName;
  /** One row per answered delivery or assistant response; empty when the turn owes exactly one. */
  readonly scope: string;
  readonly input: JsonValue;
  readonly lane: 'inline' | 'detached';
}

/** A deterministic interruption. Never caught by the per-effect handler: it must leave the sequence as an eviction would. */
export class TerminalEffectInterrupt extends Error {
  constructor(phase: TerminalEffectPhase, name: TerminalEffectName, scope: string) {
    super(`terminal effect ${name}${scope === '' ? '' : `:${scope}`} interrupted ${phase} its side effect`);
    this.name = 'TerminalEffectInterrupt';
  }
}

/** Before the side effect, or after it with nothing recorded. */
export type TerminalEffectPhase = 'before' | 'after';

/** Armed only by a test, to cut the sequence at a named point. */
export type TerminalEffectFault = (
  phase: TerminalEffectPhase, name: TerminalEffectName, scope: string,
) => void;

/** No CHECK on `status`: this module is its only writer, over a closed union. */
export function initTerminalEffectTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS terminal_effects (
    actor_id        TEXT NOT NULL,
    sequence_id     TEXT NOT NULL,
    effect_key      TEXT NOT NULL,
    effect_name     TEXT NOT NULL,
    scope           TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    input_json      TEXT NOT NULL,
    lane            TEXT NOT NULL DEFAULT 'inline',
    status          TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (actor_id, sequence_id, effect_key)
  )`);
  // One index covers the suffix read, the owing-sequence set and the earliest due instant.
  execRaw(`CREATE INDEX IF NOT EXISTS idx_terminal_effects_owed
    ON terminal_effects (actor_id, sequence_id, status, seq, next_attempt_at)`);
}

export function terminalEffectKey(name: TerminalEffectName, scope: string): string {
  return scope === ''
    ? `${TERMINAL_EFFECT_KEY_VERSION}:${name}`
    : `${TERMINAL_EFFECT_KEY_VERSION}:${name}:${scope}`;
}

interface OwedEffectRow {
  effect_key: string;
  effect_name: string;
  scope: string;
  seq: number;
  input_json: string;
  lane: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
}

/** Both arms carry `name`: a known name can still be blocked (unimplemented effect, stale key version). */
type ResolvedTarget =
  | { readonly kind: 'runnable'; readonly name: TerminalEffectName; readonly effect: TerminalEffect }
  | { readonly kind: 'blocked'; readonly name: TerminalEffectName | null; readonly reason: string };

interface PendingRow {
  readonly key: string;
  readonly rawName: string;
  readonly scope: string;
  readonly seq: number;
  readonly input: string;
  readonly status: TerminalEffectStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  /** Persisted and read off the row: recovery has no caller to ask. */
  readonly lane: 'inline' | 'detached';
  readonly target: ResolvedTarget;
}

/** `name` is null for an unknown name; `blocked` holds the reason, including a key-version mismatch. */
export interface OwedTerminalEffect {
  readonly key: string;
  readonly name: TerminalEffectName | null;
  readonly rawName: string;
  readonly scope: string;
  readonly seq: number;
  readonly input: string;
  readonly status: TerminalEffectStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly blocked: string | null;
}

export interface TerminalSequenceRun {
  /** The outer transition may not settle before this. */
  readonly reported: Promise<void>;
}

/** Owns the policy: claim, dispatch decision, retry schedule, disposition write. */
export class TerminalEffectLedger {
  private readonly actorId: string;

  /** A refusal answered after a release does not park (T1). */
  private releases = 0;

  constructor(private readonly deps: {
    readonly sql: SqlExecutor;
    /** Sequence ids collide across actors and the sweeps would cross them; `assertCurrent()` runs before every statement. */
    readonly actor: ActorHandle;
    readonly effects: TerminalEffectTable;
    readonly now: () => number;
    /** Synchronous inline bodies and their disposition share one commit on both backends. */
    readonly transaction: <T>(body: () => T) => T;
    /** Read per call: a test arms the fault after the ledger exists. */
    readonly fault?: () => TerminalEffectFault | null;
    /** Called after every pass that leaves anything owed; a past instant means due now. */
    readonly scheduleRetry: (atMs: number) => Promise<void>;
  }) {
    this.actorId = deps.actor.actorId;
  }

  /**
   * Claims land first, synchronously, read before insert. Each effect runs from the decoded recording,
   * never the live value; an existing row routes as {@link replayOwed} routes it. `reported` rejects only
   * on an injected interruption; unfinished work stays owed and definitive failures end.
   */
  async run(sequenceId: string, owed: readonly OwedEffect[]): Promise<TerminalSequenceRun> {
    this.claim(sequenceId, owed);

    return await this.drive(sequenceId);
  }

  /** Separate from {@link drive} so the caller can commit the outer claim in the same unit; no transaction of its own. */
  claim(sequenceId: string, owed: readonly OwedEffect[]): void {
    this.deps.actor.assertCurrent();

    if (owed.length === 0) return;

    // The first of a repeated name and scope wins, as the per-effect lookup it replaces did: the statement
    // cannot see its own inserts.
    const firsts = new Map<string, { key: string; name: string; scope: string; seq: number; input: string; lane: string }>();

    for (const [index, effect] of owed.entries()) {
      const identity = JSON.stringify([effect.name, effect.scope]);

      if (!firsts.has(identity)) {
        firsts.set(identity, {
          key: terminalEffectKey(effect.name, effect.scope), name: effect.name, scope: effect.scope, seq: index,
          input: JSON.stringify(effect.input), lane: effect.lane,
        });
      }
    }

    const rows = JSON.stringify([...firsts.values()]);
    this.releases += 1;
    const superseding = JSON.stringify([...new Set(owed.map((effect) => effect.name))].filter((name) => COALESCED_EFFECTS.includes(name)));
    const now = this.deps.now();

    // One statement for the sequence. Matched by name and scope, not by the computed key, so an
    // older-version row is not duplicated and routed two ways. It also releases parked rows and completes superseded ones (T1, T2).
    void this.deps.sql`INSERT INTO terminal_effects
      (actor_id, sequence_id, effect_key, effect_name, scope, seq, input_json, lane, status, attempts, next_attempt_at)
      SELECT ${this.actorId}, ${sequenceId}, e.value ->> '$.key', e.value ->> '$.name', e.value ->> '$.scope', e.value ->> '$.seq',
        e.value ->> '$.input', e.value ->> '$.lane', 'pending', 0, ${now}
      FROM json_each(${rows}) AS e
      WHERE NOT EXISTS (SELECT 1 FROM terminal_effects t WHERE t.actor_id = ${this.actorId} AND t.sequence_id = ${sequenceId}
        AND t.effect_name = e.value ->> '$.name' AND t.scope = e.value ->> '$.scope')
      UNION ALL
      SELECT actor_id, sequence_id, effect_key, effect_name, scope, seq, input_json, lane, status, attempts, next_attempt_at
      FROM terminal_effects
      WHERE actor_id = ${this.actorId} AND sequence_id != ${sequenceId} AND status IN ('pending', 'blocked', 'parked')
        AND (status = 'parked' OR effect_name IN (SELECT value FROM json_each(${superseding})))
      ON CONFLICT (actor_id, sequence_id, effect_key) DO UPDATE SET
        status = CASE WHEN terminal_effects.effect_name IN (SELECT value FROM json_each(${superseding})) THEN 'completed' ELSE 'pending' END,
        next_attempt_at = ${now}`;
  }

  /** Parked rows fall due now; the caller arms the wake. */
  release(): number {
    this.deps.actor.assertCurrent();
    this.releases += 1;

    return this.deps.sql<{ effect_key: string }>`UPDATE terminal_effects
      SET status = 'pending', next_attempt_at = ${this.deps.now()}
      WHERE actor_id = ${this.actorId} AND status = 'parked'
      RETURNING effect_key`.length;
  }

  waitingOnOwner(sequenceId: string): boolean {
    this.deps.actor.assertCurrent();

    const [row] = this.deps.sql<{ parked: number; other: number }>`
      SELECT COALESCE(SUM(status = 'parked'), 0) AS parked, COALESCE(SUM(status != 'parked'), 0) AS other
      FROM terminal_effects
      WHERE actor_id = ${this.actorId} AND sequence_id = ${sequenceId} AND status != 'completed'`;

    return row !== undefined && row.parked > 0 && row.other === 0;
  }

  /** `inFlight`: every sequence this process is running now, live; this one is counted in it either way. */
  async drive(sequenceId: string, inFlight: ReadonlySet<string> = new Set()): Promise<TerminalSequenceRun> {
    const claimed = this.pending(sequenceId);
    // Armed before the first attempt: an eviction in the inline pass must still leave a wake. Deferred for every
    // sequence this process runs, so the live process is not woken into its own effects.
    await this.armWake(new Set([...inFlight, sequenceId]));

    for (const row of claimed) {
      if (row.lane === 'inline') await this.attempt(sequenceId, row);
    }

    // Started only now, so an inline effect cannot be overtaken by a detached one it precedes.
    const detached = claimed
      .filter((row) => row.lane === 'detached')
      .map(async (row) => await this.attempt(sequenceId, row));

    return {
      // Re-armed from what is left once the sequence has run: its own rows at their times, the others still deferred.
      reported: Promise.all(detached).then(() => this.armWake(new Set([...inFlight].filter((id) => id !== sequenceId)))),
    };
  }

  /** Rows not yet due are still owed and still gate the outer transition. */
  owed(sequenceId: string): OwedTerminalEffect[] {
    return this.pending(sequenceId).map((row) => ({
      key: row.key,
      name: row.target.name,
      rawName: row.rawName,
      scope: row.scope,
      seq: row.seq,
      input: row.input,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      blocked: row.target.kind === 'blocked' ? row.target.reason : null,
    }));
  }

  /** Every input comes off its row; not-yet-due rows are left for the armed wake. */
  async replayOwed(sequenceId: string, inFlight?: ReadonlySet<string>): Promise<void> {
    const run = await this.drive(sequenceId, inFlight);
    await run.reported;
  }

  /** Most overdue first. */
  pendingSequences(): readonly string[] {
    this.deps.actor.assertCurrent();

    return this.deps.sql<{ sequence_id: string }>`
      SELECT sequence_id FROM terminal_effects
      WHERE actor_id = ${this.actorId} AND status != 'completed'
      GROUP BY sequence_id ORDER BY MIN(next_attempt_at), sequence_id`
      .map((row) => row.sequence_id);
  }

  /** Null when nothing is owed on a clock; a past instant means due now. */
  nextRetryAt(
    /** Deferred, not dropped: the live activation running them can still die. */
    inFlight: ReadonlySet<string> = new Set(),
  ): number | null {
    this.deps.actor.assertCurrent();

    const rows = this.deps.sql<{ sequence_id: string; at: number | null }>`
      SELECT sequence_id, MIN(next_attempt_at) AS at FROM terminal_effects
      WHERE actor_id = ${this.actorId} AND status IN ('pending', 'blocked') GROUP BY sequence_id`;

    const deferred = this.deps.now() + TERMINAL_EFFECT_RETRY_CEILING_MS;
    let earliest: number | null = null;

    for (const row of rows) {
      if (row.at === null) continue;
      const at = inFlight.has(row.sequence_id) ? Math.max(row.at, deferred) : row.at;

      if (earliest === null || at < earliest) earliest = at;
    }

    return earliest;
  }

  /** Blocked and pending rows are kept: they are still owed. */
  prune(sequenceId: string): void {
    this.deps.actor.assertCurrent();
    void this.deps.sql`DELETE FROM terminal_effects
      WHERE actor_id = ${this.actorId} AND sequence_id = ${sequenceId} AND status = 'completed'`;
  }

  private pending(sequenceId: string): PendingRow[] {
    this.deps.actor.assertCurrent();

    return this.deps.sql<OwedEffectRow>`
      SELECT effect_key, effect_name, scope, seq, input_json, lane, status, attempts, next_attempt_at
      FROM terminal_effects
      WHERE actor_id = ${this.actorId} AND sequence_id = ${sequenceId} AND status != 'completed'
      ORDER BY seq, effect_key`
      .map((row) => ({
        key: row.effect_key,
        rawName: row.effect_name,
        scope: row.scope,
        seq: row.seq,
        input: row.input_json,
        status: row.status === 'blocked' || row.status === 'parked' ? row.status : 'pending',
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        lane: row.lane === 'detached' ? 'detached' : 'inline',
        target: this.resolve(row.effect_name, row.scope, row.effect_key),
      } satisfies PendingRow));
  }

  /** The one place the dispatch decision is made. A known name says nothing about the input contract: the key version is checked too. */
  private resolve(rawName: string, scope: string, key: string): ResolvedTarget {
    const parsed = v.safeParse(TerminalEffectNameSchema, rawName);

    if (!parsed.success) {
      return { kind: 'blocked', name: null, reason: `unknown effect "${rawName}"` };
    }

    const effect = RETIRED_TERMINAL_EFFECTS.has(parsed.output) ? RETIRED_EFFECT : this.deps.effects[parsed.output];

    if (effect === undefined) {
      return {
        kind: 'blocked', name: parsed.output,
        reason: `effect "${rawName}" is not implemented by this actor`,
      };
    }

    if (terminalEffectKey(parsed.output, scope) !== key) {
      // Stored keys always carry a version prefix, so an absent one is itself the mismatch.
      const cut = key.indexOf(':');

      return {
        kind: 'blocked', name: parsed.output,
        reason: `effect "${rawName}" was recorded under key version `
          + `${cut === -1 ? '(none)' : key.slice(0, cut)}, `
          + `and this build speaks ${TERMINAL_EFFECT_KEY_VERSION}`,
      };
    }

    return { kind: 'runnable', name: parsed.output, effect };
  }

  /** The try/catch spans exactly this effect, so a failure leaves only this row owed. */
  private async attempt(sequenceId: string, row: PendingRow): Promise<void> {
    // The stored schedule governs every attempt, including a fresh row (due immediately).
    this.deps.actor.assertCurrent();

    if (row.status === 'parked' || row.nextAttemptAt > this.deps.now()) return;
    const attempts = row.attempts + 1;
    const nextAttemptAt = this.deps.now() + terminalEffectBackoffMs(attempts);
    const inline = row.lane === 'inline' && row.target.kind === 'runnable' && row.target.effect.synchronous;

    // Any awaited body keeps its durable attempt before starting.
    if (!inline) this.recordAttempt(sequenceId, row, nextAttemptAt);

    if (row.target.kind === 'blocked') {
      this.record(sequenceId, row.key, 'blocked');
      diagnostics.failure('turn.terminal_effect_blocked', toKinuError({
        doing: `attempting the ${row.rawName} effect a settled turn owed`,
        cause: new Error(row.target.reason),
        otherwise: 'unsupported',
      }), { sequence: sequenceId, effect: row.key, attempts });

      return;
    }

    const { name, effect } = row.target;
    const fault = this.deps.fault?.() ?? null;
    const releases = this.releases;
    let outcome: TerminalEffectOutcome;

    try {
      if (effect.synchronous && row.lane === 'inline') {
        this.deps.transaction(() => {
          fault?.('before', name, row.scope);
          const result = effect.run(parseJsonValue(row.input), row.scope);
          fault?.('after', name, row.scope);
          this.recordInline(sequenceId, row, result, nextAttemptAt);
        });

        return;
      }

      fault?.('before', name, row.scope);
      outcome = await effect.run(parseJsonValue(row.input), row.scope);
    } catch (err) {
      if (err instanceof TerminalEffectInterrupt) throw err;

      // A real synchronous failure rolled back its body, not its right to back off.
      if (inline) this.recordAttempt(sequenceId, row, nextAttemptAt);

      const failure = toKinuError({
        doing: `running the ${name} effect a settled turn owed`,
        cause: err,
        otherwise: 'unavailable',
      });

      diagnostics.failure('turn.terminal_effect_failed', failure, { sequence: sequenceId, effect: row.key, attempts });
      const refused = providerRefusalCode({ cause: err });
      const code = refused ?? failure.code;

      if (isDefinitiveTerminalFailure(code)) {
        const status = providerStatusOf({ cause: err });
        const detail = status === undefined ? failure.message : `the model provider answered HTTP ${String(status)}`;
        diagnostics.event('turn.terminal_effect_abandoned', { sequence: sequenceId, effect: row.key, attempts, code });
        writeActivityLog(() => ({ sql: this.deps.sql, actor: this.deps.actor }), {
          event: 'terminal_effect_abandoned',
          detail: `${EFFECT_ACTIVITY[name] ?? name} failed: ${detail}, so it is not retried`,
          elapsedMs: 0, createdAt: this.deps.now(),
        });
        void this.deps.sql`DELETE FROM terminal_effects
          WHERE actor_id = ${this.actorId} AND sequence_id = ${sequenceId} AND effect_key = ${row.key}`;

        return;
      }

      if (refused !== null && OWNER_FIXABLE_REFUSALS.has(refused)) {
        if (this.releases !== releases) {
          this.due(sequenceId, row.key);
          diagnostics.event('turn.terminal_effect_refusal_outdated', { sequence: sequenceId, effect: row.key, attempts, code: refused });

          return;
        }

        this.record(sequenceId, row.key, 'parked');
        diagnostics.event('turn.terminal_effect_parked', { sequence: sequenceId, effect: row.key, attempts, code: refused });

        return;
      }

      this.record(sequenceId, row.key, 'pending');

      return;
    }

    fault?.('after', name, row.scope);

    if (outcome.status === 'owed') {
      if (outcome.held === true) {
        void this.deps.sql`UPDATE terminal_effects
          SET attempts = ${row.attempts}, next_attempt_at = ${this.deps.now() + TERMINAL_EFFECT_RETRY_BASE_MS}
          WHERE actor_id = ${this.actorId} AND sequence_id = ${sequenceId}
            AND effect_key = ${row.key} AND status != 'completed'`;
      }

      this.record(sequenceId, row.key, 'pending');

      return;
    }

    void this.deps.sql`UPDATE terminal_effects
      SET status = 'completed'
      WHERE actor_id = ${this.actorId} AND sequence_id = ${sequenceId}
        AND effect_key = ${row.key} AND status != 'completed'`;
  }

  /** A real backend transaction also makes bun:sqlite safe against process death between the body and disposition. */
  private recordInline(sequenceId: string, row: PendingRow, outcome: TerminalEffectOutcome, nextAttemptAt: number): void {
    const held = outcome.status === 'owed' && outcome.held === true;
    const status = outcome.status === 'completed' ? 'completed' : 'pending';
    const attempts = held ? row.attempts : row.attempts + 1;
    const next = held ? this.deps.now() + TERMINAL_EFFECT_RETRY_BASE_MS : nextAttemptAt;
    this.deps.actor.assertCurrent();
    void this.deps.sql`UPDATE terminal_effects
      SET status = ${status}, attempts = ${attempts}, next_attempt_at = ${next}
      WHERE actor_id = ${this.actorId} AND sequence_id = ${sequenceId}
        AND effect_key = ${row.key} AND status != 'completed'`;
  }

  private recordAttempt(sequenceId: string, row: PendingRow, nextAttemptAt: number): void {
    this.deps.actor.assertCurrent();
    void this.deps.sql`UPDATE terminal_effects
      SET attempts = ${row.attempts + 1}, next_attempt_at = ${nextAttemptAt}
      WHERE actor_id = ${this.actorId} AND sequence_id = ${sequenceId}
        AND effect_key = ${row.key} AND status != 'completed'`;
  }

  private due(sequenceId: string, key: string): void {
    this.deps.actor.assertCurrent();
    void this.deps.sql`UPDATE terminal_effects
      SET status = 'pending', next_attempt_at = ${this.deps.now()}
      WHERE actor_id = ${this.actorId} AND sequence_id = ${sequenceId}
        AND effect_key = ${key} AND status != 'completed'`;
  }

  /** `completed` is irreversible; the others may replace each other. */
  private record(
    sequenceId: string, key: string, status: Exclude<TerminalEffectStatus, 'completed'>,
  ): void {
    this.deps.actor.assertCurrent();
    void this.deps.sql`UPDATE terminal_effects
      SET status = ${status}
      WHERE actor_id = ${this.actorId} AND sequence_id = ${sequenceId}
        AND effect_key = ${key} AND status != 'completed'`;
  }

  private async armWake(inFlight?: ReadonlySet<string>): Promise<void> {
    const at = this.nextRetryAt(inFlight);

    if (at !== null) await this.deps.scheduleRetry(at);
  }
}
