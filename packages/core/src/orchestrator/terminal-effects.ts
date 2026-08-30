/**
 * Every side effect one settled turn owes, and what each of them has already
 * done.
 *
 * A turn's answer causes a SEQUENCE: the alternate-takes claim, the craft-usage
 * row, the reply an answered event batch owes, the steer branches, the extension
 * turn-end and the evolution recording, then the between-turn model lanes
 * (sleep-time compute, auto-title, auto-GEPA). That sequence had ONE durable
 * marker for all of it — a single claim taken at the top and settled at the
 * bottom — and one marker cannot say WHICH of those happened. An isolate that
 * died three effects in left a row indistinguishable from one that died at the
 * first, so the only two answers available on the next activation were "run
 * everything again" (announce one answer twice, pay for the model lanes twice)
 * and "run nothing" (drop the reply somebody is waiting on).
 *
 * This table is the third answer: one row per effect, carrying the input that
 * effect needs, so a later activation replays exactly what is still owed.
 *
 * THE WHOLE SEQUENCE IS CLAIMED BEFORE ANY OF IT RUNS. That is what makes the
 * remaining work a SUFFIX rather than a guess: an interruption at effect three
 * leaves effects three through eight pending with their inputs already written,
 * and the recovery runs them in the declared order. Claiming each effect just
 * before its own side effect would have left the ones after the crash with no
 * row at all — indistinguishable from effects that were never owed.
 *
 * EVERY EFFECT IS REPLAYABLE, and that is a requirement ON THE EFFECT rather
 * than a question the ledger asks. The alternative — letting an effect declare
 * itself unreplayable and having the recovery decline its owed row — closes the
 * outer transition while the work is still owed, which is the exact loss this
 * table exists to prevent. So the author of an effect makes the boundary it
 * touches idempotent or keyed (a keyed send, an upsert, an append under a stable
 * id), and an owed row is simply run again.
 *
 * Three things each row establishes, and every one of them is load-bearing:
 *
 *   • A VERSIONED key. The recorded input is only meaningful under the shape the
 *     effect expected when it was written, so the version is part of the key
 *     rather than a column. A row whose stored key does not match the key this
 *     build computes for the same name and scope is BLOCKED: its input speaks a
 *     contract this build does not have, and running it under the current parser
 *     would execute the wrong semantics.
 *   • The INPUT, and nothing else. A replay reads storage, never RAM, so an
 *     effect whose input cannot be written down cannot be replayed and must say
 *     so instead of pretending. The forward path runs from the DECODED recording
 *     rather than from the live value, which is what makes that structural: an
 *     input too poor to reconstruct the call fails on the turn that wrote it.
 *   • A DISPOSITION, and a SCHEDULE. `completed` is the only terminal one.
 *     `pending` is owed and will be attempted again once `next_attempt_at`
 *     passes. `blocked` is owed and cannot be attempted BY THIS BUILD. Nothing
 *     is ever abandoned: a failing attempt buys a longer wait, never a smaller
 *     obligation.
 *
 * The outer terminal transition (`TerminalTransitions.end`) settles only when
 * this table holds no owed row for the sequence. That ordering is the
 * whole guarantee: while one effect is still owed the transition stays
 * interrupted, so the next activation is handed the suffix rather than told the
 * turn was done. Convergence comes from the backoff and the durable wake
 * `scheduleRetry` arms — never from giving up.
 */
import * as v from 'valibot';
import { modelMessageSchema, type ModelMessage } from 'ai';

import { parseJsonValue, type JsonValue } from '../utils/json';
import { reconcileColumns } from '../identity/columns';
import { RUN_END_REASONS } from './turn-lifecycle';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { WorkMode } from '../prompting/surface';
import type { TurnContinuity } from './agent-orchestrator';
import { diagnostics, renderThrownChain, toKinuError } from '../obs/index';
import { OVERFLOW_RETRY_EVENT, OVERFLOW_RETRY_TEXT } from '../turn-failure';
import type { SignalDeliverer } from '../types/signals';

/**
 * The driver's verdict on how a turn ended, as a recorded effect input reads it
 * back.
 *
 * The picklist is core's own {@link RUN_END_REASONS}, so a row written by another
 * activation cannot carry a fourth word this build would then have to guess at.
 * Here rather than in each actor: both the workspace root and the subordinate
 * record the same verdict for the same effect.
 */
export const RunEndReasonSchema = v.picklist(RUN_END_REASONS);

/**
 * A turn's response messages as a replayed extension emit reads them back.
 *
 * The AI SDK's own `modelMessageSchema` is the predicate, exactly as core's event
 * recorder narrows a stored message with: a hand-written copy of its part unions
 * would be a second answer to what a model message is.
 */
export const ModelMessagesSchema: v.GenericSchema<ModelMessage[]> = v.array(
  v.custom<ModelMessage>((value) => modelMessageSchema.safeParse(value).success),
);

/** The work mode a recorded effect carries. It TRAVELS with the row rather than
 *  being re-derived: a cold replay must not turn a Plan report into a Build one
 *  because the live turn metadata moved on. */
export const WorkModeSchema: v.GenericSchema<WorkMode> = v.union([
  v.literal('plan'), v.literal('build'),
]);

/** The conversational continuity a recorded turn ran under. Recorded rather than
 *  re-read: a fresh actor defaults to `conversation`, so a replay of an
 *  independent task would park it awaiting a follow-up that cannot come. */
export const TurnContinuitySchema: v.GenericSchema<TurnContinuity> = v.union([
  v.literal('conversation'), v.literal('independent_task'),
]);

/**
 * The key version. Bumped when what an effect RECORDS changes meaning — not
 * when its implementation changes.
 *
 * In the key rather than in a column so that the version travels with the row's
 * identity: a build reading a row whose key it could not have written knows,
 * from the key alone, that the input belongs to a different contract. That row
 * is blocked by {@link TerminalEffectLedger}, not parsed hopefully.
 */
export const TERMINAL_EFFECT_KEY_VERSION = 'v1';

/**
 * The scope an effect body may KEY its own inner work on, or undefined.
 *
 * An empty scope is what an assistant response whose row was never written
 * carries. It is not an identity: every such response would share it, so the
 * second would read the first's tombstones as its own work already done. Such a
 * sequence runs unledgered, and its bodies must key nothing.
 */
export function keyedScope(scope: string): string | undefined {
  return scope === '' ? undefined : scope;
}

/**
 * The first wait after a failed attempt, and the ceiling every later wait grows
 * toward.
 *
 * Five seconds because the common failure is a peer that is restarting, and a
 * shorter wait would spend activations on a boundary that cannot yet answer.
 * Ten minutes because the uncommon failure is an outage measured in hours, and a
 * wake every ten minutes keeps the obligation visible at a cost that does not
 * scale with the outage. There is no attempt limit: a bound on attempts is a
 * bound on how much work may be lost, and this table exists to make that bound
 * zero.
 */
export const TERMINAL_EFFECT_RETRY_BASE_MS = 5_000;
export const TERMINAL_EFFECT_RETRY_CEILING_MS = 600_000;

/** How long after its `attempts`-th failure an owed effect waits: 5s, 10s, 20s
 *  … doubling to the ten-minute ceiling and staying there. */
export function terminalEffectBackoffMs(attempts: number): number {
  const grown = TERMINAL_EFFECT_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(grown, TERMINAL_EFFECT_RETRY_CEILING_MS);
}

/** Every effect a settled turn can owe, across every actor. The union is the
 *  schema: a row naming anything else was written by a build this one is not,
 *  and is blocked. Which of them an actor actually owes is that actor's
 *  {@link TerminalEffectTable}. */
export const TERMINAL_EFFECT_NAMES = [
  'takes', 'craft_usage', 'event_reply', 'branches',
  // The mechanical completion gate. Its armed/fired state lives in RAM, so the
  // ledger row is the only thing that survives a restart saying whether the one
  // confirming turn it enqueues has already been enqueued.
  'completion_gate',
  // The settle spine, as five separately claimed boundaries rather than one
  // compound effect. It used to be a single row, so a crash after the extension
  // turn-end but before the window append lost the remaining suffix and nothing
  // could tell which half had happened. Each of these is keyed on the turn's own
  // durable identity and is idempotent at its own boundary.
  'turn_end_extensions', 'overflow_retry', 'turn_record', 'event_drain', 'improvement_lanes',
  // Separate from the improvement lanes it used to sit inside: a queue that is
  // full is a legitimate refusal, and the lanes' own model calls must not be
  // held behind it — nor repeated when it is retried.
  'shadow_trial',
  'sleep_time', 'auto_title', 'auto_gepa',
  'parent_report',
] as const;
export type TerminalEffectName = (typeof TERMINAL_EFFECT_NAMES)[number];

const TerminalEffectNameSchema = v.picklist(TERMINAL_EFFECT_NAMES);

/**
 * The effects that run OFF the turn queue, as every declaration assigns them.
 *
 * Stated once here because a row written before the `lane` column existed has to
 * be corrected from its name, and the correction must not be a second opinion
 * about which effects are detached. A reply makes an SMTP round trip, a branch
 * waits on a live head, and the between-turn lanes each spend a model call.
 */
const DETACHED_EFFECT_NAMES: readonly TerminalEffectName[] = [
  'event_reply', 'branches', 'parent_report', 'sleep_time', 'auto_title', 'auto_gepa',
];

/**
 * The disposition of one row. `completed` is the only terminal one.
 *
 * `blocked` means this build cannot attempt the row — an unsupported key
 * version, or an effect name it does not implement. It is STILL OWED: it gates
 * the outer transition and it is reported. It closes nothing. A blocked row is a
 * DEPLOY-SHAPE problem — a rollback, a half-finished rollout, a row written by a
 * build that is no longer running — and a human resolves it by deploying a build
 * that has the effect. That is precisely why it must stay visible instead of
 * converging to success: the ledger cannot fix the deploy, and pretending the
 * work happened would delete the only evidence that it did not.
 */
export type TerminalEffectStatus = 'pending' | 'completed' | 'blocked';

/** What running one effect established. `owed` is the honest middle: the effect
 *  ran, reported that it is not finished (a reply channel still open), and left
 *  its row owed so a later activation carries it. */
export type TerminalEffectOutcome =
  | { readonly status: 'completed'; readonly detail?: string }
  | { readonly status: 'owed'; readonly detail: string };

/**
 * One effect, with its own input type erased behind a parse.
 *
 * Built through {@link terminalEffect} so the table can be a homogeneous record
 * while each entry keeps its real input type inside: the schema is closed over
 * by the function that needs it, so nothing casts and nothing widens.
 */
export interface TerminalEffect {
  /** Run it against a recorded input. Called for a first attempt and for a
   *  replay alike — the effect's own boundary is what distinguishes them, which
   *  is why that boundary must be idempotent or keyed. */
  readonly run: (input: JsonValue, scope: string) => Promise<TerminalEffectOutcome>;
}

/**
 * The effects one actor's terminal sequence can owe.
 *
 * Partial because the sequence belongs to the ACTOR: a workspace root owes
 * alternate takes and event replies, a subordinate owes neither, and an entry
 * nobody declared must not exist as an empty shell that silently succeeds. A row
 * whose effect this actor does not implement is blocked by name, exactly like a
 * row from a build this one is not.
 */
export type TerminalEffectTable = Readonly<Partial<Record<TerminalEffectName, TerminalEffect>>>;

/** Declare one effect from its input schema and its body. */
export function terminalEffect<I>(spec: {
  readonly input: v.GenericSchema<unknown, I>;
  readonly run: (input: I, scope: string) => Promise<TerminalEffectOutcome> | TerminalEffectOutcome;
}): TerminalEffect {
  return { run: async (raw, scope) => await spec.run(v.parse(spec.input, raw), scope) };
}

/** The one durable body both backends use for a context-overflow retry. */
export function overflowRetryTerminalEffect(signals: SignalDeliverer): TerminalEffect {
  return terminalEffect({
    input: v.object({}),
    run: async (_input, scope) => {
      const effectScope = keyedScope(scope);
      const signal = effectScope === undefined
        ? { kind: OVERFLOW_RETRY_EVENT, text: OVERFLOW_RETRY_TEXT }
        : {
          kind: OVERFLOW_RETRY_EVENT,
          text: OVERFLOW_RETRY_TEXT,
          idempotencyKey: `overflow-retry:${effectScope}`,
        };
      const outcome = await signals.deliver(signal);
      return outcome === 'undelivered'
        ? { status: 'owed', detail: 'the overflow retry signal was undelivered' }
        : { status: 'completed' };
    },
  });
}

/**
 * One effect of one sequence, as the caller declares it.
 *
 * `lane` is about the TURN QUEUE and nothing else. `onChatResponse` runs inside
 * it, so an effect that makes an SMTP round trip, waits on a branch head, or
 * spends a model call would hold the next message behind this turn's
 * housekeeping. Those are `detached`: started in declared order, joined before
 * the outer transition may settle. The lane is a caller-side property and is not
 * stored — a recovery runs off an alarm with no queue to block, and awaits
 * everything.
 */
export interface OwedEffect {
  readonly name: TerminalEffectName;
  /** The subject, when a sequence owes several of one kind: one row per answered
   *  delivery, one per assistant response. Empty when the turn owes exactly one. */
  readonly scope: string;
  readonly input: JsonValue;
  readonly lane: 'inline' | 'detached';
}

/**
 * A deterministic interruption, standing in for the isolate dying at an exact
 * point in the sequence.
 *
 * NEVER caught by the per-effect handler, and that is the point: an eviction
 * does not resume the sequence it interrupted, so a fault the ledger absorbed
 * would prove nothing about what an eviction leaves behind. It travels out of
 * the whole terminal sequence exactly as a platform interruption does.
 */
export class TerminalEffectInterrupt extends Error {
  constructor(phase: TerminalEffectPhase, name: TerminalEffectName, scope: string) {
    super(`terminal effect ${name}${scope === '' ? '' : `:${scope}`} interrupted ${phase} its side effect`);
    this.name = 'TerminalEffectInterrupt';
  }
}

/** The two points an interruption can land on, and the only two that matter:
 *  before the side effect (nothing happened) and after it (it happened, and
 *  nothing recorded that it did). */
export type TerminalEffectPhase = 'before' | 'after';

/** Armed only by a test, to cut the sequence at a named point. */
export type TerminalEffectFault = (
  phase: TerminalEffectPhase, name: TerminalEffectName, scope: string,
) => void;

/**
 * `sql` is the same storage as `execRaw`, as the tagged-template primitive:
 * `reconcileColumns` asks `pragma_table_info` which columns are present rather
 * than adding them and swallowing the duplicate-column error.
 *
 * `status` carries no CHECK. Its vocabulary changed in place while this table
 * was pre-release, SQLite bakes a CHECK into the stored table definition and
 * offers no ALTER for it, and core's in-place rebuild is private to the head
 * journal. The column has exactly one writer — this module — and its values come
 * from the closed {@link TerminalEffectStatus} union, so the constraint would
 * guard against a writer that does not exist while breaking every storage
 * created under the older word list.
 */
export function initTerminalEffectTable(sql: SqlExecutor, execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS terminal_effects (
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
    PRIMARY KEY (sequence_id, effect_key)
  )`);
  // `DEFAULT 0` is also the right value for a row written before the column
  // existed: due immediately, which is what an owed row with no schedule means.
  reconcileColumns(sql, execRaw, 'terminal_effects', {
    next_attempt_at: 'INTEGER NOT NULL DEFAULT 0',
    lane: "TEXT NOT NULL DEFAULT 'inline'",
  });
  // A row written before the column existed carries the DEFAULT, and defaulting
  // every one of them to inline is not conservative — it is the ordering defect
  // the column was added to remove. A stalled reply would once again be awaited
  // ahead of the recording behind it. The lane is a property of the EFFECT, not
  // of the row, so the pre-column rows are corrected from their own names.
  for (const name of DETACHED_EFFECT_NAMES) {
    void sql`UPDATE terminal_effects SET lane = 'detached'
      WHERE effect_name = ${name} AND lane = 'inline' AND status != 'completed'`;
  }
  // Covers every owed read there is: one sequence's suffix, the set of sequences
  // still owing anything, and the earliest instant any of them is next due. One
  // index because those three questions differ only in how much of the same
  // ordering they consume.
  execRaw(`CREATE INDEX IF NOT EXISTS idx_terminal_effects_owed
    ON terminal_effects (sequence_id, status, seq, next_attempt_at)`);
}

/** The versioned identity of one effect within one sequence. */
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

/** What a stored row dispatches to, once this build has looked at it. Both arms
 *  carry `name`, because whether a build KNOWS the name and whether it can RUN
 *  the row are separate questions: an unimplemented effect and a stale key
 *  version are both blocked under a name that parsed perfectly well, and a
 *  reporter that lost the name would describe them as anonymous. */
type ResolvedTarget =
  | { readonly kind: 'runnable'; readonly name: TerminalEffectName; readonly effect: TerminalEffect }
  | { readonly kind: 'blocked'; readonly name: TerminalEffectName | null; readonly reason: string };

/** One owed row with its dispatch decision already made, for the two paths that
 *  attempt it. The effect itself is carried so nothing re-looks-it-up and
 *  nothing asserts it is there. Exported because the transition claims a roster
 *  and drives it in two steps, with its own commit around the first. */
export interface PendingRow {
  readonly key: string;
  readonly rawName: string;
  readonly scope: string;
  readonly seq: number;
  readonly input: string;
  readonly status: TerminalEffectStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  /** Whether this row existed before the current activation touched it. A
   *  pre-existing row is a RESUMED attempt and its schedule governs it; a claim
   *  this activation just wrote is due by construction. */
  readonly preExisting: boolean;
  /** PERSISTED, because a replay must schedule the way the forward path did.
   *  Read off the row and not re-derived: recovery has no caller to ask, and
   *  walking a roster serially lets a detached reply that hangs block the
   *  recording behind it — work the live path had already committed. */
  readonly lane: 'inline' | 'detached';
  readonly target: ResolvedTarget;
}

/** One owed row, as a reporter reads it back. `name` is null when the stored
 *  name is not one this build knows; `blocked` carries the reason whenever this
 *  build cannot attempt the row at all, including a key-version mismatch under a
 *  name it does know. */
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
  /** Resolves when every detached effect has recorded a disposition. The outer
   *  transition may not settle before this. */
  readonly reported: Promise<void>;
}

/**
 * The ledger: claim the sequence, run it, record each effect's disposition, and
 * replay what an interruption left owed.
 *
 * One object rather than a bag of functions because the POLICY is what it owns —
 * the read-then-insert claim, the dispatch decision, the retry schedule, the
 * disposition write. Callers name their effects and hand over inputs; they
 * decide none of that.
 */
export class TerminalEffectLedger {
  constructor(private readonly deps: {
    readonly sql: SqlExecutor;
    readonly effects: TerminalEffectTable;
    /** The clock every disposition is stamped with. A dep so a test can freeze
     *  it and read back the row it wrote by value. */
    readonly now: () => number;
    /** Read per call: a test arms the fault after the ledger exists. */
    readonly fault?: () => TerminalEffectFault | null;
    /** Commit the claim and its whole roster as ONE unit. Identity is honest
     *  inside a Durable Object, where a synchronous run cannot be interrupted
     *  between statements; a process that CAN die there must supply a real
     *  transaction or recovery reads a prefix as the whole roster. */
    readonly transaction?: <T>(body: () => T) => T;
    /**
     * Arm a durable wake at this instant, because rows are still owed.
     *
     * Called after every pass that leaves anything owed. Without it the retry
     * schedule is a hope that some unrelated event reactivates the object, and
     * an idle workspace would hold an undelivered reply forever. An instant in
     * the past means a row is due now and the wake should fire as soon as the
     * platform allows.
     */
    readonly scheduleRetry: (atMs: number) => Promise<void>;
  }) {}

  /**
   * Claim a whole sequence, then run it in order.
   *
   * The claims land FIRST, in one synchronous pass with no await in it — which
   * is what makes them atomic inside a Durable Object, and what makes every
   * effect after an interruption a row somebody can replay. Within each claim
   * the read comes before the insert for the reason core's tool-effect claim
   * documents: an insert alone cannot tell "I just claimed this" from "somebody
   * claimed it and died", and the prior read is the only observation that
   * separates them.
   *
   * Each effect then runs from the DECODED RECORDING, never from the live value
   * the caller passed. An owed row's own recording wins over a fresh input: that
   * is what the first attempt committed to, and a replay that substituted the
   * current activation's view would finish a different piece of work than the
   * one that was claimed.
   *
   * A row that already existed is routed exactly as {@link replayOwed} routes
   * it, through the same resolve and the same schedule. A duplicate callback is
   * not a licence to re-run a boundary the ledger has deliberately deferred.
   *
   * Resolves once the INLINE effects have run. `reported` resolves when the
   * detached ones have all recorded a disposition, and it rejects on exactly one
   * thing: an injected interruption. Every real failure is recorded on its own
   * row and left owed, so in production the join never rejects and the outer
   * transition closes on a complete suffix or not at all.
   */
  async run(sequenceId: string, owed: readonly OwedEffect[]): Promise<TerminalSequenceRun> {
    return await this.drive(sequenceId, this.claim(sequenceId, owed));
  }

  /**
   * Write this roster's rows, SYNCHRONOUSLY, and report what is now owed.
   *
   * Separated from {@link drive} so a caller can put the outer transition's own
   * claim in the same commit: the rows and the claim that gates them are one
   * durable fact, and a process that dies between them leaves an open claim with
   * no roster — which a recovery reads as a finished turn and closes over.
   *
   * No transaction of its own for the same reason. The caller supplies the
   * boundary because the caller knows what else belongs inside it.
   */
  claim(sequenceId: string, owed: readonly OwedEffect[]): PendingRow[] {
    const claimed: PendingRow[] = [];
    const now = this.deps.now();
    owed.forEach((effect, index) => {
      const key = terminalEffectKey(effect.name, effect.scope);
      // Looked up by NAME AND SCOPE, not by the key this build would compute.
      // A row written under an older key version names the same obligation, and
      // a forward path that missed it would insert a second row and dispatch the
      // effect while recovery, reading the stored row, would block it on the
      // version mismatch — one piece of work routed two different ways.
      const existing = this.deps.sql<{
        effect_key: string; input_json: string; lane: string;
        status: string; attempts: number; next_attempt_at: number;
      }>`
        SELECT effect_key, input_json, lane, status, attempts, next_attempt_at FROM terminal_effects
        WHERE sequence_id = ${sequenceId} AND effect_name = ${effect.name} AND scope = ${effect.scope}
        LIMIT 1`[0];
      if (existing !== undefined) {
        if (existing.status === 'completed') return;
        claimed.push({
          key: existing.effect_key, rawName: effect.name, scope: effect.scope, seq: index,
          input: existing.input_json,
          status: existing.status === 'blocked' ? 'blocked' : 'pending',
          attempts: existing.attempts, nextAttemptAt: existing.next_attempt_at,
          preExisting: true,
          // The RECORDED lane, not this caller's: the row's own scheduling is
          // what a recovery will reproduce, and the two must not disagree.
          lane: existing.lane === 'detached' ? 'detached' : 'inline',
          target: this.resolve(effect.name, effect.scope, existing.effect_key),
        });
        return;
      }
      const encoded = JSON.stringify(effect.input);
      void this.deps.sql`INSERT INTO terminal_effects
        (sequence_id, effect_key, effect_name, scope, seq, input_json, lane, status, outcome,
         attempts, next_attempt_at, claimed_at, settled_at)
        VALUES (${sequenceId}, ${key}, ${effect.name}, ${effect.scope}, ${index}, ${encoded},
                ${effect.lane}, 'pending', ${null}, 0, ${now}, ${now}, ${null})`;
      claimed.push({
        key, rawName: effect.name, scope: effect.scope, seq: index, input: encoded,
        status: 'pending', attempts: 0, nextAttemptAt: now, preExisting: false,
        target: this.resolve(effect.name, effect.scope, key), lane: effect.lane,
      });
    });
    return claimed;
  }

  /** Run a claimed roster: arm, inline pass, then the detached tail. */
  async drive(sequenceId: string, claimed: readonly PendingRow[]): Promise<TerminalSequenceRun> {
    // ARMED HERE, before the first attempt. The rows now exist, so a recovery
    // for them must exist too: an eviction inside the inline pass used to leave
    // a claimed suffix with no wake and no fiber behind it, and a subordinate —
    // whose activation runs no reconcile of its own — could owe its parent
    // report indefinitely. One early wake that finds nothing to do is the
    // harmless failure; a suffix nothing retries is not.
    await this.armWake();
    for (const row of claimed) {
      if (row.lane === 'inline') await this.attempt(sequenceId, row);
    }
    // Started only now, so an inline effect the queue waits on cannot be
    // overtaken by a detached one it precedes.
    const detached = claimed
      .filter((row) => row.lane === 'detached')
      .map(async (row) => await this.attempt(sequenceId, row));
    return {
      // Re-armed after the join, from what is LEFT: the arm before the inline
      // pass covered the claimed suffix, and this one collapses the wake onto
      // the earliest row still owed once the sequence has run.
      reported: Promise.all(detached).then(() => this.armWake()),
    };
  }

  /** What this sequence still owes, in declared order — every non-terminal row,
   *  whether or not it is due yet. A row not yet due is still owed, and still
   *  gates the outer transition. */
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

  /**
   * Finish what one interrupted sequence still owes, from storage.
   *
   * Every input comes off its row, so this runs on an activation that has
   * hydrated nothing. Rows whose `next_attempt_at` has not passed are left
   * alone — still owed, still gating — and the wake armed at the end brings the
   * activation back for them.
   */
  async replayOwed(sequenceId: string): Promise<void> {
    const rows = this.pending(sequenceId);
    // ARMED FIRST, exactly as the forward path arms before its inline pass. A
    // retry wake is one-shot: an interruption while a replayed reply, parent RPC
    // or model lane is in flight consumes the alarm that brought us here and
    // would leave the still-owed suffix with no carrier at all.
    await this.armWake();
    // The RECORDED lanes, reproducing the forward scheduler. Walking the roster
    // serially let a detached reply that hangs block the recording behind it —
    // work the live path had already committed before it ever started the reply.
    for (const row of rows) {
      if (row.lane === 'inline') await this.attempt(sequenceId, row);
    }
    await Promise.all(
      rows.filter((row) => row.lane === 'detached')
        .map(async (row) => await this.attempt(sequenceId, row)),
    );
    await this.armWake();
  }

  /** Every sequence with an owed row, the most overdue first. The recovery
   *  sweep's one question on a cold activation, asked without knowing which
   *  sequences exist. */
  pendingSequences(): readonly string[] {
    return this.deps.sql<{ sequence_id: string }>`
      SELECT sequence_id FROM terminal_effects WHERE status != 'completed'
      GROUP BY sequence_id ORDER BY MIN(next_attempt_at), sequence_id`
      .map((row) => row.sequence_id);
  }

  /** The earliest instant any owed row is next attemptable, or null when nothing
   *  is owed. An instant already past means a row is due now. */
  nextRetryAt(
    /** Sequences a live activation is already running.
     *
     *  Their rows are pending because the effect has not finished YET, so waking
     *  on the overdue instant re-armed one second ahead on every tick for the
     *  whole of a multi-minute model lane. They are DEFERRED rather than dropped:
     *  the activation running them can die at any moment, and a sequence with no
     *  wake behind it is one nothing comes back for. */
    inFlight: ReadonlySet<string> = new Set(),
  ): number | null {
    const rows = this.deps.sql<{ sequence_id: string; at: number | null }>`
      SELECT sequence_id, MIN(next_attempt_at) AS at FROM terminal_effects
      WHERE status != 'completed' GROUP BY sequence_id`;
    const deferred = this.deps.now() + TERMINAL_EFFECT_RETRY_CEILING_MS;
    let earliest: number | null = null;
    for (const row of rows) {
      if (row.at === null) continue;
      const at = inFlight.has(row.sequence_id) ? Math.max(row.at, deferred) : row.at;
      if (earliest === null || at < earliest) earliest = at;
    }
    return earliest;
  }

  /**
   * Drop this sequence's COMPLETED rows once its outer transition has settled.
   *
   * Blocked rows are kept, and so are pending ones. A blocked row is work a
   * deploy still owes; a ledger that deleted it would leave a diagnostic line as
   * the only trace of something a turn was supposed to do.
   */
  prune(sequenceId: string): void {
    void this.deps.sql`DELETE FROM terminal_effects
      WHERE sequence_id = ${sequenceId} AND status = 'completed'`;
  }

  /** Every non-terminal row of one sequence, with its dispatch decision made. */
  private pending(sequenceId: string): PendingRow[] {
    return this.deps.sql<OwedEffectRow>`
      SELECT effect_key, effect_name, scope, seq, input_json, lane, status, attempts, next_attempt_at
      FROM terminal_effects
      WHERE sequence_id = ${sequenceId} AND status != 'completed'
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
        preExisting: true,
        lane: row.lane === 'detached' ? 'detached' : 'inline',
        target: this.resolve(row.effect_name, row.scope, row.effect_key),
      } satisfies PendingRow));
  }

  /**
   * Decide, from a stored row alone, what this build may do with it.
   *
   * The one place that decision is made, so a duplicate forward call and a cold
   * recovery cannot disagree about a row. Three ways to be blocked, and the key
   * check is the one that is easy to miss: a known NAME says nothing about the
   * INPUT CONTRACT. After a rollback or a version bump the stored key was
   * written under a different version of the same name, and handing its input to
   * the current parser runs the wrong semantics under the right label.
   */
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
      // A stored key has always carried a version prefix, so an absent one is
      // itself the mismatch and names itself in the reason.
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

  /**
   * One attempt at one effect — the whole of the exactly-once boundary.
   *
   * The try/catch spans exactly this effect and nothing else. A sequence-wide
   * catch is what made the old failures unattributable: one throw ended every
   * effect after it, and the marker said only that the turn had not finished.
   * Here a failure leaves THIS row owed with its classified reason, and the
   * effects beside it are untouched.
   */
  private async attempt(sequenceId: string, row: PendingRow): Promise<void> {
    // A resumed row is governed by the schedule its last failure armed, however
    // this activation reached it: a duplicate callback arriving inside that
    // window must leave it owed rather than re-run a boundary the ledger
    // deliberately deferred. Only a claim written by this pass is due by
    // construction, which is what `preExisting` says and what keeps that
    // invariant here instead of in the insert's choice of instant.
    if (row.preExisting && row.nextAttemptAt > this.deps.now()) return;
    const attempts = row.attempts + 1;
    // Armed BEFORE the side effect, not after it. An eviction mid-effect never
    // comes back to write anything, so a schedule pushed afterwards would leave
    // an eviction loop retrying with no backoff at all.
    void this.deps.sql`UPDATE terminal_effects
      SET attempts = ${attempts}, next_attempt_at = ${this.deps.now() + terminalEffectBackoffMs(attempts)}
      WHERE sequence_id = ${sequenceId} AND effect_key = ${row.key} AND status != 'completed'`;
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
      // Owed, never abandoned: the row keeps its input and the wake armed above
      // brings an activation back for it.
      this.record(sequenceId, row.key, 'pending', `failed: ${renderThrownChain({ cause: err })}`);
      return;
    }
    fault?.('after', name, row.scope);
    if (outcome.status === 'owed') {
      this.record(sequenceId, row.key, 'pending', `owed: ${outcome.detail}`);
      return;
    }
    void this.deps.sql`UPDATE terminal_effects
      SET status = 'completed', outcome = ${outcome.detail ?? null}, settled_at = ${this.deps.now()}
      WHERE sequence_id = ${sequenceId} AND effect_key = ${row.key} AND status != 'completed'`;
  }

  /** Write a non-terminal disposition. Guarded on the row not being completed:
   *  `completed` is the one irreversible answer, and a later pass must never
   *  reopen it — while `pending` and `blocked` may legitimately replace each
   *  other as a deploy changes what this build can attempt. */
  private record(
    sequenceId: string, key: string, status: 'pending' | 'blocked', outcome: string,
  ): void {
    void this.deps.sql`UPDATE terminal_effects
      SET status = ${status}, outcome = ${outcome}
      WHERE sequence_id = ${sequenceId} AND effect_key = ${key} AND status != 'completed'`;
  }

  /** Arm the durable wake for the earliest owed row, if anything is still owed. */
  private async armWake(): Promise<void> {
    const at = this.nextRetryAt();
    if (at !== null) await this.deps.scheduleRetry(at);
  }
}
