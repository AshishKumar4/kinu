/**
 * One durable row per side effect a settled turn owes, all claimed before any runs, so an interruption
 * leaves a replayable suffix. Every effect must be idempotent or keyed. Rows carry a versioned key
 * (mismatch: blocked), the recorded input, and a disposition plus schedule; nothing is abandoned.
 * `TerminalTransitions.end` settles only when no row is owed.
 */
import * as v from 'valibot';
import { modelMessageSchema, type ModelMessage } from 'ai';

import { parseJsonValue, JsonValueSchema, type JsonValue } from '../utils/json';
import {
  OUTPUT_CONTINUATION_EVENT, OUTPUT_CONTINUATION_TEXT, RUN_END_REASONS,
} from './turn-lifecycle';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { AgentOrchestrator, TurnContinuity } from './agent-orchestrator';
import type { EvolutionEngine } from '../evolution/engine';
import type { HeadJournal } from '../heads/journal';
import { CompletedTurnSchema } from '../evolution/session-window';
import { WorkModeSchema } from '../types/turn';
import { claimAlternateTakesForTurn, purgeUnclaimedAlternateTakes } from '../mcts/takes';
import {
  branchHeadId, branchOutcomeFromJournal, settleBranchIntoTakes, settlePendingBranch,
  type BranchStatusEvent, type PendingBranch,
} from '../steer-branch';
import { diagnostics, renderThrownChain, toKinuError } from '../obs/index';
import { OVERFLOW_RETRY_EVENT, OVERFLOW_RETRY_TEXT } from '../turn-failure';
import { TASK_REMINDER_EVENT, taskReminderIdempotencyKey } from '../tasks/reminder';

/** The picklist is {@link RUN_END_REASONS}, so a stored row cannot carry an unknown word. */
export const RunEndReasonSchema = v.picklist(RUN_END_REASONS);

/** Narrowed by the AI SDK's own `modelMessageSchema`, not a hand-written copy. */
const ModelMessagesSchema: v.GenericSchema<ModelMessage[]> = v.array(
  v.custom<ModelMessage>((value) => modelMessageSchema.safeParse(value).success),
);


/** Recorded rather than re-read: a fresh actor defaults to `conversation`. */
const TurnContinuitySchema: v.GenericSchema<TurnContinuity> = v.union([
  v.literal('conversation'), v.literal('independent_task'),
]);

/** Bumped when what an effect records changes meaning, not its implementation. */
const TERMINAL_EFFECT_KEY_VERSION = 'v1';

/** An empty scope is not an identity: such a sequence runs unledgered and its bodies key nothing. */
export function keyedScope(scope: string): string | undefined {
  return scope === '' ? undefined : scope;
}

/** No attempt limit: a bound on attempts is a bound on lost work. */
export const TERMINAL_EFFECT_RETRY_BASE_MS = 5_000;

export const TERMINAL_EFFECT_RETRY_CEILING_MS = 600_000;

/** Doubling from the base delay to the ceiling. */
function terminalEffectBackoffMs(attempts: number): number {
  const grown = TERMINAL_EFFECT_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);

  return Math.min(grown, TERMINAL_EFFECT_RETRY_CEILING_MS);
}

/** A row naming anything else is blocked; each actor's {@link TerminalEffectTable} picks its subset. */
const TERMINAL_EFFECT_NAMES = [
  'takes', 'craft_usage', 'event_reply', 'branches',
  // Its armed state lives in RAM, so this row alone records whether the confirming turn was enqueued.
  'completion_gate',
  // Five separately claimed boundaries, each idempotent and keyed on the turn. `overflow_retry` and
  // `output_continuation` are mutually exclusive.
  'turn_end_extensions', 'overflow_retry', 'output_continuation', 'task_reminder',
  'turn_record', 'event_drain', 'improvement_lanes',
  // Its own row: a full queue is a legitimate refusal, and the lanes' model calls must not wait on it.
  'shadow_trial',
  'sleep_time', 'auto_title', 'auto_gepa',
  'parent_report',
] as const;

export type TerminalEffectName = (typeof TERMINAL_EFFECT_NAMES)[number];

const TerminalEffectNameSchema = v.picklist(TERMINAL_EFFECT_NAMES);


/** `blocked` (unknown key version or effect) is still owed and reported: a deploy-shape problem a human resolves. */
export type TerminalEffectStatus = 'pending' | 'completed' | 'blocked';

/** `owed`: the effect ran, reported unfinished, and stays owed. */
export type TerminalEffectOutcome =
  | { readonly status: 'completed'; readonly detail?: string }
  /** `held`: a live carrier already owns the work; the backoff is not doubled. */
  | { readonly status: 'owed'; readonly detail: string; readonly held?: boolean };

/** Built through {@link terminalEffect} so each entry keeps its real input type without casts. */
export interface TerminalEffect {
  /** First attempt and replay alike, which is why the boundary must be idempotent or keyed. */
  readonly run: (input: JsonValue, scope: string) => Promise<TerminalEffectOutcome>;
}

/** Partial: an undeclared entry must not exist as a silently succeeding shell; its rows are blocked by name. */
export type TerminalEffectTable = Readonly<Partial<Record<TerminalEffectName, TerminalEffect>>>;

export function terminalEffect<I>(spec: {
  readonly input: v.GenericSchema<unknown, I>;
  readonly run: (input: I, scope: string) => Promise<TerminalEffectOutcome> | TerminalEffectOutcome;
}): TerminalEffect {
  return { run: async (raw, scope) => await spec.run(v.parse(spec.input, raw), scope) };
}

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
    run: (input, scope) => {
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

export function overflowRetryTerminalEffect(queue: () => OwedTurnQueue): TerminalEffect {
  return owedTurnTerminalEffect(queue, {
    input: v.object({}), event: OVERFLOW_RETRY_EVENT, text: () => OVERFLOW_RETRY_TEXT,
    key: (scope) => `overflow-retry:${scope}`,
  });
}

/** Think's loop cannot extend past a `length` finish, so the continuation is the next turn, owed durably. */
export function outputLimitContinuationTerminalEffect(queue: () => OwedTurnQueue): TerminalEffect {
  return owedTurnTerminalEffect(queue, {
    input: v.object({}), event: OUTPUT_CONTINUATION_EVENT, text: () => OUTPUT_CONTINUATION_TEXT,
    key: (scope) => `output-continuation:${scope}`,
  });
}

/** The text is a recorded input: a replay announces what the turn was owed. */
export function taskReminderTerminalEffect(queue: () => OwedTurnQueue): TerminalEffect {
  return owedTurnTerminalEffect(queue, {
    input: v.object({ text: v.string() }), event: TASK_REMINDER_EVENT, text: ({ text }) => text,
    key: taskReminderIdempotencyKey,
  });
}

/** Claim or purge captures so the next turn never inherits them. */
export function takesTerminalEffect(deps: {
  readonly sql: SqlExecutor;
  readonly actor: ActorHandle;
  readonly sessionId: string;
}): TerminalEffect {
  return terminalEffect({
    input: v.object({
      credited: v.nullable(v.string()), startedAt: v.number(),
      takeIds: v.array(v.string()),
    }),
    run: ({ credited, startedAt, takeIds }) => {
      if (credited === null) {
        purgeUnclaimedAlternateTakes(deps.sql, deps.actor, takeIds);
      } else {
        claimAlternateTakesForTurn(deps.sql, deps.actor, {
          turnId: credited, sessionId: deps.sessionId, startedAt, takeIds,
        });
      }

      return { status: 'completed' };
    },
  });
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
export function turnRecordTerminalEffect(
  orch: Pick<AgentOrchestrator, 'recordTurn' | 'recordedTurn'>,
): TerminalEffect {
  return terminalEffect({
    input: v.object({
      messageId: v.string(), status: RunEndReasonSchema, turn: JsonValueSchema,
      continuity: TurnContinuitySchema, workMode: WorkModeSchema, recordedAt: v.number(),
      autoEvolve: v.boolean(),
    }),
    run: ({ messageId, status, turn, continuity, workMode, recordedAt, autoEvolve }) => {
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

/** Idempotent (PENDING, unbound rows only). Rethrows: `completed` over a half-bound batch strands the assignment. */
export function eventDrainTerminalEffect(
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

/** Its own row: a full queue stays owed; `not_sampled` discharges the obligation. */
export function shadowTrialTerminalEffect(
  engine: Pick<EvolutionEngine, 'queueShadowTrial'>,
): TerminalEffect {
  return terminalEffect({
    input: v.object({
      turn: JsonValueSchema, trialContext: JsonValueSchema, pendingVersion: v.number(),
    }),
    run: ({ turn, trialContext, pendingVersion }, scope) => {
      const trialScope = keyedScope(scope);

      const queued = engine.queueShadowTrial(
        v.parse(CompletedTurnSchema, turn), v.parse(ModelMessagesSchema, trialContext),
        trialScope === undefined
          ? { pendingVersion }
          : { pendingVersion, id: `trial-${trialScope}` },
      );

      if (queued === 'queue_full' || queued === 'failed') {
        return { status: 'owed', detail: `the shadow trial for this turn is ${queued}` };
      }

      return queued === 'queued'
        ? { status: 'completed' }
        : { status: 'completed', detail: `no trial to queue: ${queued}` };
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
    outcome         TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    claimed_at      INTEGER NOT NULL,
    settled_at      INTEGER,
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

  constructor(private readonly deps: {
    readonly sql: SqlExecutor;
    /** Sequence ids collide across actors and the sweeps would cross them; `assertCurrent()` runs before every statement. */
    readonly actor: ActorHandle;
    readonly effects: TerminalEffectTable;
    readonly now: () => number;
    /** Read per call: a test arms the fault after the ledger exists. */
    readonly fault?: () => TerminalEffectFault | null;
    /** Claim and roster as one unit. Identity is honest where a synchronous run cannot be interrupted; otherwise supply a real transaction. */
    readonly transaction?: <T>(body: () => T) => T;
    /** Called after every pass that leaves anything owed; a past instant means due now. */
    readonly scheduleRetry: (atMs: number) => Promise<void>;
  }) {
    this.actorId = deps.actor.actorId;
  }

  /**
   * Claims land first, synchronously, read before insert. Each effect runs from the decoded recording,
   * never the live value; an existing row routes as {@link replayOwed} routes it. `reported` rejects only
   * on an injected interruption; real failures stay owed on their rows.
   */
  async run(sequenceId: string, owed: readonly OwedEffect[]): Promise<TerminalSequenceRun> {
    this.claim(sequenceId, owed);

    return await this.drive(sequenceId);
  }

  /** Separate from {@link drive} so the caller can commit the outer claim in the same unit; no transaction of its own. */
  claim(sequenceId: string, owed: readonly OwedEffect[]): void {
    this.deps.actor.assertCurrent();
    const now = this.deps.now();

    for (const [index, effect] of owed.entries()) {
      const key = terminalEffectKey(effect.name, effect.scope);

      // Looked up by name and scope, not by the computed key, so an older-version row is not duplicated and
      // routed two ways.
      const existing = this.deps.sql<{ effect_key: string }>`
        SELECT effect_key FROM terminal_effects
        WHERE actor_id = ${this.actorId} AND sequence_id = ${sequenceId}
          AND effect_name = ${effect.name} AND scope = ${effect.scope}
        LIMIT 1`[0];

      if (existing !== undefined) continue;

      const encoded = JSON.stringify(effect.input);
      void this.deps.sql`INSERT INTO terminal_effects
        (actor_id, sequence_id, effect_key, effect_name, scope, seq, input_json, lane, status, outcome,
         attempts, next_attempt_at, claimed_at, settled_at)
        VALUES (${this.actorId}, ${sequenceId}, ${key}, ${effect.name}, ${effect.scope}, ${index},
                ${encoded}, ${effect.lane}, 'pending', ${null}, 0, ${now}, ${now}, ${null})`;
    }
  }

  async drive(sequenceId: string): Promise<TerminalSequenceRun> {
    const claimed = this.pending(sequenceId);
    // Armed before the first attempt: an eviction in the inline pass must still leave a wake.
    await this.armWake();

    for (const row of claimed) {
      if (row.lane === 'inline') await this.attempt(sequenceId, row);
    }

    // Started only now, so an inline effect cannot be overtaken by a detached one it precedes.
    const detached = claimed
      .filter((row) => row.lane === 'detached')
      .map(async (row) => await this.attempt(sequenceId, row));

    return {
      // Re-armed from what is left once the sequence has run.
      reported: Promise.all(detached).then(() => this.armWake()),
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
  async replayOwed(sequenceId: string): Promise<void> {
    const run = await this.drive(sequenceId);
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

  /** Null when nothing is owed; a past instant means due now. */
  nextRetryAt(
    /** Deferred, not dropped: the live activation running them can still die. */
    inFlight: ReadonlySet<string> = new Set(),
  ): number | null {
    this.deps.actor.assertCurrent();

    const rows = this.deps.sql<{ sequence_id: string; at: number | null }>`
      SELECT sequence_id, MIN(next_attempt_at) AS at FROM terminal_effects
      WHERE actor_id = ${this.actorId} AND status != 'completed' GROUP BY sequence_id`;

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
        status: row.status === 'blocked' ? 'blocked' : 'pending',
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

    const effect = this.deps.effects[parsed.output];

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

    if (row.nextAttemptAt > this.deps.now()) return;
    const attempts = row.attempts + 1;
    // Armed before the side effect: an eviction mid-effect never writes a later schedule.
    void this.deps.sql`UPDATE terminal_effects
      SET attempts = ${attempts}, next_attempt_at = ${this.deps.now() + terminalEffectBackoffMs(attempts)}
      WHERE actor_id = ${this.actorId} AND sequence_id = ${sequenceId}
        AND effect_key = ${row.key} AND status != 'completed'`;

    if (row.target.kind === 'blocked') {
      this.record(sequenceId, row.key, 'blocked', row.target.reason);
      diagnostics.failure('turn.terminal_effect_blocked', toKinuError({
        doing: `attempting the ${row.rawName} effect a settled turn owed`,
        cause: new Error(row.target.reason),
        otherwise: 'unsupported',
      }), { sequence: sequenceId, effect: row.key, attempts });

      return;
    }

    const { name, effect } = row.target;
    const fault = this.deps.fault?.() ?? null;
    fault?.('before', name, row.scope);
    let outcome: TerminalEffectOutcome;

    try {
      outcome = await effect.run(parseJsonValue(row.input), row.scope);
    } catch (err) {
      if (err instanceof TerminalEffectInterrupt) throw err;
      diagnostics.failure('turn.terminal_effect_failed', toKinuError({
        doing: `running the ${name} effect a settled turn owed`,
        cause: err,
        otherwise: 'unavailable',
      }), { sequence: sequenceId, effect: row.key, attempts });
      // Owed, never abandoned.
      this.record(sequenceId, row.key, 'pending', `failed: ${renderThrownChain({ cause: err })}`);

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

      this.record(sequenceId, row.key, 'pending', `owed: ${outcome.detail}`);

      return;
    }

    void this.deps.sql`UPDATE terminal_effects
      SET status = 'completed', outcome = ${outcome.detail ?? null}, settled_at = ${this.deps.now()}
      WHERE actor_id = ${this.actorId} AND sequence_id = ${sequenceId}
        AND effect_key = ${row.key} AND status != 'completed'`;
  }

  /** `completed` is irreversible; `pending` and `blocked` may replace each other. */
  private record(
    sequenceId: string, key: string, status: 'pending' | 'blocked', outcome: string,
  ): void {
    this.deps.actor.assertCurrent();
    void this.deps.sql`UPDATE terminal_effects
      SET status = ${status}, outcome = ${outcome}
      WHERE actor_id = ${this.actorId} AND sequence_id = ${sequenceId}
        AND effect_key = ${key} AND status != 'completed'`;
  }

  private async armWake(): Promise<void> {
    const at = this.nextRetryAt();

    if (at !== null) await this.deps.scheduleRetry(at);
  }
}
