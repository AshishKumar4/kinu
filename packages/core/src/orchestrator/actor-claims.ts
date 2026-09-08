/**
 * Durable actor turn claims — the row that exists BEFORE a turn's first model,
 * tool or provider effect, and the context revisions its steps consume.
 *
 * WHAT A CLAIM IS. One row per (issued actor, turn), carrying the identity the
 * work runs under: the issued `actorId` (never a workspace name or a logical
 * alias — those are routing and display values), the `runId` of the activation
 * that admitted it, the live execution `epoch`, the turn's immutable work mode,
 * and the SELECTED program's identity — a scaffold version plus the SHA-256 of
 * the source that version retains, or the builtin loop plus the installed build
 * the host publishes for it. Nothing here hashes a descriptor and calls it code,
 * and nothing invents a build identity: a host that publishes none is recorded
 * as `null`, which reads back as unknown.
 *
 * WHY THE EPOCH. `active_durable_turn` on the hosted backend was a single row
 * keyed `id = 1` holding the turn id, so an evicted activation and the
 * activation that replaced it were indistinguishable, and nothing could refuse
 * the older one's writes. The epoch is that fence: an admission for a turn that
 * already has a claim takes the next epoch, and every write from an older epoch
 * is refused rather than merged. A recovered activation therefore cannot mutate
 * a newer claim, and the newer claim cannot be mistaken for the recovered one.
 *
 * WHY REVISIONS ARE ROWS AND NOT A COPY OF THE SOURCE. A step consumes an exact
 * message array — after error projection, steering, pruning, the dynamic-context
 * weave and the destination re-key — and recovery has to be able to reproduce
 * that array. So each step's array is stored once, as a revision, through the
 * typed native-message codec (`prompting/message-codec.ts`); the PROGRAM is
 * stored as version + digest and re-read from the version's own retained source
 * on recovery. Copying the program source per step would store the same bytes
 * as many times as the turn takes steps.
 *
 * WHAT THIS IS NOT. Not a scheduler, not a second outcome ledger, and not a
 * replacement for the durable run-event log: `openTurnRun`/`closeTurnRun` still
 * own the run's timeline, `terminal-effects.ts` still owns terminal effects, and
 * `tools/effect-claim.ts` still owns per-call tool effects. This is the identity
 * those ledgers are written under, and the `indeterminate` outcome below is the
 * same vocabulary the tool claim already uses for work whose completion nobody
 * can establish.
 */

import type { ModelMessage } from 'ai';
import type { WorkMode } from '../prompting/surface';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../state/actor-handle';
import { KinuError } from '../obs/error';
import { nowMs } from '../utils/date';
import { RUN_END_REASONS } from './turn-lifecycle';
import { decodeModelMessages, encodeModelMessages, modelMessagesDigest } from '../prompting/message-codec';
import { sqlCheckList } from '../identity/schema';
import type { ActorTurnProgram } from './actor-program';

/**
 * How a claimed turn ended.
 *
 * The three run-end reasons, plus the one a claim can reach that a run cannot:
 * `indeterminate` — the claim was admitted, the activation that held it died,
 * and whether its effects landed is not knowable from this row. It is the same
 * word `claimToolEffect` answers with, deliberately: both mean "work was
 * claimed, its disposition is unknown, and re-running it is refused".
 */
export const CLAIM_OUTCOMES = [...RUN_END_REASONS, 'indeterminate'] as const;
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];

const CLAIM_STATUSES = ['admitted', 'settled'] as const;
const PROGRAM_KINDS = ['builtin', 'scaffold'] as const;

/** The selected program, as the claim binds it. */
export interface ActorProgramIdentity {
  readonly kind: (typeof PROGRAM_KINDS)[number];
  /** The immutable scaffold version, or 0 for the builtin loop. */
  readonly version: number;
  /** SHA-256 of the version's retained source. Null for the builtin loop,
   *  which has no scaffold source to retain. */
  readonly digest: string | null;
  /** The installed build the host publishes for its builtin loop, or null when
   *  it publishes none. Never derived from a descriptor. */
  readonly build: string | null;
}

/** The claim a turn holds while it runs — the identity every effect of that
 *  turn is issued under. Frozen: a caller cannot re-point a running claim at
 *  another actor, run, epoch or program. */
export interface ActorTurnClaim {
  readonly actorId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly epoch: number;
  readonly workMode: WorkMode;
  readonly program: ActorProgramIdentity;
  /** The revision the turn was admitted against — what its first step starts
   *  from, and what a mid-turn edit stages a successor to. */
  readonly baseRevision: number;
}

/** A claim as it was stored, for recovery and for status reads. */
export interface StoredActorClaim {
  readonly actorId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly epoch: number;
  readonly workMode: WorkMode;
  readonly program: ActorProgramIdentity;
  readonly status: (typeof CLAIM_STATUSES)[number];
  readonly outcome: ClaimOutcome | null;
  readonly consumedRevision: number | null;
  readonly claimedAt: number;
}

/** One stored context revision. */
export interface ContextRevision {
  readonly revision: number;
  readonly epoch: number;
  readonly baseRevision: number | null;
  readonly digest: string;
  readonly messageCount: number;
  /** The step that consumed it, or null while it is only staged. */
  readonly stepIndex: number | null;
  readonly messages: ModelMessage[];
}

/** What a consumed step recorded. */
export interface ConsumedContext {
  readonly revision: number;
  readonly digest: string;
}

export function initActorClaimTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS actor_turn_claims (
    actor_id        TEXT NOT NULL,
    turn_id         TEXT NOT NULL,
    run_id          TEXT NOT NULL,
    epoch           INTEGER NOT NULL,
    work_mode       TEXT NOT NULL CHECK(work_mode IN ('plan','build')),
    program_kind    TEXT NOT NULL CHECK(program_kind IN (${sqlCheckList(PROGRAM_KINDS)})),
    program_version INTEGER NOT NULL,
    program_digest  TEXT,
    program_build   TEXT,
    status          TEXT NOT NULL CHECK(status IN (${sqlCheckList(CLAIM_STATUSES)})),
    outcome         TEXT CHECK(outcome IS NULL OR outcome IN (${sqlCheckList(CLAIM_OUTCOMES)})),
    consumed_revision INTEGER,
    claimed_at      INTEGER NOT NULL,
    settled_at      INTEGER,
    PRIMARY KEY (actor_id, turn_id)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_actor_claims_status ON actor_turn_claims(actor_id, status, claimed_at DESC)`);
  execRaw(`CREATE TABLE IF NOT EXISTS actor_context_revisions (
    actor_id      TEXT NOT NULL,
    turn_id       TEXT NOT NULL,
    revision      INTEGER NOT NULL,
    epoch         INTEGER NOT NULL,
    base_revision INTEGER,
    digest        TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    messages      TEXT NOT NULL,
    step_index    INTEGER,
    recorded_at   INTEGER NOT NULL,
    PRIMARY KEY (actor_id, turn_id, revision)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_actor_context_step
    ON actor_context_revisions(actor_id, turn_id, step_index)`);
}

/** The program identity a claim binds, from the prepared program and the build
 *  the host publishes for its builtin loop. The builtin arm carries no digest:
 *  there is no retained source to hash, and hashing the descriptor that names
 *  it would be an identity of the words `kind: 'builtin'`. */
export function programIdentityOf(program: ActorTurnProgram, installedBuild: string | null): ActorProgramIdentity {
  return Object.freeze(program.kind === 'scaffold'
    ? { kind: 'scaffold' as const, version: program.version, digest: program.digest, build: null }
    : { kind: 'builtin' as const, version: 0, digest: null, build: installedBuild });
}

interface ClaimRow {
  run_id: string;
  epoch: number;
  work_mode: WorkMode;
  program_kind: (typeof PROGRAM_KINDS)[number];
  program_version: number;
  program_digest: string | null;
  program_build: string | null;
  status: (typeof CLAIM_STATUSES)[number];
  outcome: ClaimOutcome | null;
  consumed_revision: number | null;
  claimed_at: number;
}

interface RevisionRow {
  revision: number;
  epoch: number;
  base_revision: number | null;
  digest: string;
  message_count: number;
  messages: string;
  step_index: number | null;
}

/**
 * One actor's durable claim ledger.
 *
 * Bound to an {@link ActorHandle} rather than an id string, for the reason every
 * actor-scoped store in this bundle is: the handle carries the validation the
 * binding captured, so a store cannot outlive the identity it was bound to, and
 * no caller has to remember to pass an actor id that matches.
 */
export class ActorClaimStore {
  private readonly actorId: string;

  constructor(
    private readonly sql: SqlExecutor,
    private readonly actor: ActorHandle,
    private readonly transactionSync: <T>(write: () => T) => T,
  ) {
    this.actorId = actor.actorId;
  }

  /**
   * Admit one turn: write its claim and the context revision it was admitted
   * against, in ONE synchronous transaction, and return the claim its effects
   * are issued under. A turn that already has a claim takes the NEXT epoch —
   * which is what fences the activation that held the previous one.
   *
   * Called before the turn's first model, tool or provider effect. A caller
   * that admits after issuing work has not admitted it.
   */
  admit(input: {
    readonly runId: string;
    readonly turnId: string;
    readonly workMode: WorkMode;
    readonly program: ActorProgramIdentity;
    readonly context: readonly ModelMessage[];
  }): ActorTurnClaim {
    this.actor.assertCurrent();
    const encoded = encodeModelMessages(input.context);
    const digest = modelMessagesDigest(encoded);
    const at = nowMs();
    const epoch = this.transactionSync(() => {
      const prior = this.sql<{ epoch: number }>`
        SELECT epoch FROM actor_turn_claims WHERE actor_id = ${this.actorId} AND turn_id = ${input.turnId}`[0];
      const next = (prior?.epoch ?? 0) + 1;
      void this.sql`
        INSERT INTO actor_turn_claims (
          actor_id, turn_id, run_id, epoch, work_mode, program_kind, program_version,
          program_digest, program_build, status, outcome, consumed_revision, claimed_at, settled_at)
        VALUES (
          ${this.actorId}, ${input.turnId}, ${input.runId}, ${next}, ${input.workMode},
          ${input.program.kind}, ${input.program.version}, ${input.program.digest},
          ${input.program.build}, 'admitted', NULL, NULL, ${at}, NULL)
        ON CONFLICT(actor_id, turn_id) DO UPDATE SET
          run_id = excluded.run_id, epoch = excluded.epoch, work_mode = excluded.work_mode,
          program_kind = excluded.program_kind, program_version = excluded.program_version,
          program_digest = excluded.program_digest, program_build = excluded.program_build,
          status = 'admitted', outcome = NULL, consumed_revision = NULL,
          claimed_at = excluded.claimed_at, settled_at = NULL`;
      // Revision 0 of THIS epoch: the context the turn was admitted against.
      // Written under the same transaction as the claim, so a reader never sees
      // a claim whose admitted context is absent.
      void this.sql`
        INSERT INTO actor_context_revisions (
          actor_id, turn_id, revision, epoch, base_revision, digest, message_count, messages, step_index, recorded_at)
        VALUES (${this.actorId}, ${input.turnId}, 0, ${next}, NULL, ${digest},
          ${input.context.length}, ${encoded}, NULL, ${at})
        ON CONFLICT(actor_id, turn_id, revision) DO UPDATE SET
          epoch = excluded.epoch, digest = excluded.digest, message_count = excluded.message_count,
          messages = excluded.messages, step_index = NULL, recorded_at = excluded.recorded_at`;
      return next;
    });
    return Object.freeze({
      actorId: this.actorId,
      runId: input.runId,
      turnId: input.turnId,
      epoch,
      workMode: input.workMode,
      program: input.program,
      baseRevision: 0,
    });
  }

  /**
   * Record the exact array one step consumes, as the next revision, and refuse
   * the write when this claim no longer owns the turn.
   *
   * The refusal is the point: a stale continuation — an old activation resuming
   * inside a turn a newer epoch has since admitted — cannot append a revision to
   * the newer claim, and a settled claim takes no further steps.
   */
  consume(claim: ActorTurnClaim, step: { readonly index: number; readonly messages: readonly ModelMessage[] }): ConsumedContext {
    const encoded = encodeModelMessages(step.messages);
    const digest = modelMessagesDigest(encoded);
    return this.transactionSync(() => {
      this.assertLive(claim);
      const revision = this.nextRevision(claim.turnId);
      void this.sql`
        INSERT INTO actor_context_revisions (
          actor_id, turn_id, revision, epoch, base_revision, digest, message_count, messages, step_index, recorded_at)
        VALUES (${this.actorId}, ${claim.turnId}, ${revision}, ${claim.epoch}, NULL, ${digest},
          ${step.messages.length}, ${encoded}, ${step.index}, ${nowMs()})`;
      void this.sql`
        UPDATE actor_turn_claims SET consumed_revision = ${revision}, run_id = ${claim.runId}
        WHERE actor_id = ${this.actorId} AND turn_id = ${claim.turnId} AND epoch = ${claim.epoch}`;
      return { revision, digest };
    });
  }

  /**
   * Stage a mid-turn context edit as a LATER revision, against the revision the
   * editor read. The compare-and-set is what makes two concurrent edits fail
   * loudly instead of one silently overwriting the other's base, and staging —
   * rather than writing into the live array — is what keeps the work already
   * issued on its original context.
   *
   * A staged revision becomes visible at the next real step boundary
   * ({@link stagedContext} + `applyStagedContext`), never mid-step.
   */
  stage(claim: ActorTurnClaim, edit: { readonly base: number; readonly messages: readonly ModelMessage[] }): number {
    const encoded = encodeModelMessages(edit.messages);
    const digest = modelMessagesDigest(encoded);
    return this.transactionSync(() => {
      this.assertLive(claim);
      const latest = this.sql<{ revision: number }>`
        SELECT MAX(revision) AS revision FROM actor_context_revisions
        WHERE actor_id = ${this.actorId} AND turn_id = ${claim.turnId}`[0]?.revision ?? 0;
      if (latest !== edit.base) {
        // `denied`, not `io`: the store established that applying this edit
        // would overwrite a revision the editor never read, and declined.
        throw new KinuError('denied',
          `this context edit was written against revision ${edit.base}, and revision ${latest} is current`);
      }
      const revision = latest + 1;
      void this.sql`
        INSERT INTO actor_context_revisions (
          actor_id, turn_id, revision, epoch, base_revision, digest, message_count, messages, step_index, recorded_at)
        VALUES (${this.actorId}, ${claim.turnId}, ${revision}, ${claim.epoch}, ${edit.base}, ${digest},
          ${edit.messages.length}, ${encoded}, NULL, ${nowMs()})`;
      return revision;
    });
  }

  /** The staged edit waiting for a step boundary, or null. Staged means a
   *  revision that no step has consumed and that was written as an edit of an
   *  earlier one — the admitted revision 0 is not an edit. */
  stagedContext(claim: ActorTurnClaim): ContextRevision | null {
    const row = this.sql<RevisionRow>`
      SELECT revision, epoch, base_revision, digest, message_count, messages, step_index
      FROM actor_context_revisions
      WHERE actor_id = ${this.actorId} AND turn_id = ${claim.turnId}
        AND step_index IS NULL AND base_revision IS NOT NULL
      ORDER BY revision ASC LIMIT 1`[0];
    return row === undefined ? null : revisionOf(row);
  }

  /** Mark a staged revision as the one a step consumed, with the array that
   *  step actually received — which is the staged edit PLUS whatever the live
   *  tail held, so the row is the request and not the proposal. */
  consumeStaged(claim: ActorTurnClaim, revision: number, step: {
    readonly index: number; readonly messages: readonly ModelMessage[];
  }): ConsumedContext {
    const encoded = encodeModelMessages(step.messages);
    const digest = modelMessagesDigest(encoded);
    return this.transactionSync(() => {
      this.assertLive(claim);
      void this.sql`
        UPDATE actor_context_revisions
        SET step_index = ${step.index}, digest = ${digest}, messages = ${encoded},
            message_count = ${step.messages.length}, epoch = ${claim.epoch}, recorded_at = ${nowMs()}
        WHERE actor_id = ${this.actorId} AND turn_id = ${claim.turnId} AND revision = ${revision}
          AND step_index IS NULL`;
      void this.sql`
        UPDATE actor_turn_claims SET consumed_revision = ${revision}, run_id = ${claim.runId}
        WHERE actor_id = ${this.actorId} AND turn_id = ${claim.turnId} AND epoch = ${claim.epoch}`;
      return { revision, digest };
    });
  }

  /** Seal the claim. Refused from a stale epoch for the same reason a step is:
   *  an old activation must not name the outcome of a turn a newer one owns. */
  settle(claim: ActorTurnClaim, outcome: ClaimOutcome): void {
    this.transactionSync(() => {
      this.assertLive(claim);
      void this.sql`
        UPDATE actor_turn_claims SET status = 'settled', outcome = ${outcome}, settled_at = ${nowMs()}
        WHERE actor_id = ${this.actorId} AND turn_id = ${claim.turnId} AND epoch = ${claim.epoch}`;
    });
  }

  /** Settle a claim this activation did NOT admit — recovery's disposition for
   *  a turn whose activation died holding it. Keyed by turn and epoch so it
   *  cannot close a claim a live activation has since re-admitted. */
  settleRecovered(turnId: string, epoch: number, outcome: ClaimOutcome): void {
    this.actor.assertCurrent();
    void this.sql`
      UPDATE actor_turn_claims SET status = 'settled', outcome = ${outcome}, settled_at = ${nowMs()}
      WHERE actor_id = ${this.actorId} AND turn_id = ${turnId} AND epoch = ${epoch} AND status = 'admitted'`;
  }

  /** One stored claim, or null. */
  read(turnId: string): StoredActorClaim | null {
    this.actor.assertCurrent();
    const row = this.sql<ClaimRow>`
      SELECT run_id, epoch, work_mode, program_kind, program_version, program_digest,
             program_build, status, outcome, consumed_revision, claimed_at
      FROM actor_turn_claims WHERE actor_id = ${this.actorId} AND turn_id = ${turnId} LIMIT 1`[0];
    return row === undefined ? null : this.claimOf(turnId, row);
  }

  /**
   * Claims this actor admitted and never settled — a start-of-life read, for
   * the reason `unterminatedRuns` gives: an activation that has just started is
   * running none of them, so every one it finds was left by an earlier one.
   */
  unsettled(limit = 50): StoredActorClaim[] {
    this.actor.assertCurrent();
    const rows = this.sql<ClaimRow & { turn_id: string }>`
      SELECT turn_id, run_id, epoch, work_mode, program_kind, program_version, program_digest,
             program_build, status, outcome, consumed_revision, claimed_at
      FROM actor_turn_claims WHERE actor_id = ${this.actorId} AND status = 'admitted'
      ORDER BY claimed_at DESC LIMIT ${limit}`;
    return rows.map((row) => this.claimOf(row.turn_id, row));
  }

  /** The revision a step consumed, by revision number, or the latest consumed
   *  one when no number is given. What a recovery reads back to learn the exact
   *  array the dead activation's last step was issued with. */
  consumedContext(turnId: string, revision?: number): ContextRevision | null {
    this.actor.assertCurrent();
    const rows = revision === undefined
      ? this.sql<RevisionRow>`
        SELECT revision, epoch, base_revision, digest, message_count, messages, step_index
        FROM actor_context_revisions
        WHERE actor_id = ${this.actorId} AND turn_id = ${turnId} AND step_index IS NOT NULL
        ORDER BY revision DESC LIMIT 1`
      : this.sql<RevisionRow>`
        SELECT revision, epoch, base_revision, digest, message_count, messages, step_index
        FROM actor_context_revisions
        WHERE actor_id = ${this.actorId} AND turn_id = ${turnId} AND revision = ${revision} LIMIT 1`;
    const row = rows[0];
    return row === undefined ? null : revisionOf(row);
  }

  /** The context the turn was ADMITTED against — revision 0, which exists for
   *  every claim because it is written in the admitting transaction. */
  admittedContext(turnId: string): ContextRevision | null {
    return this.consumedContext(turnId, 0);
  }

  /** Drop one turn's claim and revisions. Called only once the turn's answer is
   *  durably persisted and its effects are settled: until then these rows are
   *  what a recovery reads instead of guessing. */
  release(turnId: string): void {
    this.actor.assertCurrent();
    this.transactionSync(() => {
      void this.sql`DELETE FROM actor_context_revisions WHERE actor_id = ${this.actorId} AND turn_id = ${turnId}`;
      void this.sql`DELETE FROM actor_turn_claims WHERE actor_id = ${this.actorId} AND turn_id = ${turnId}`;
    });
  }

  private claimOf(turnId: string, row: ClaimRow): StoredActorClaim {
    return Object.freeze({
      actorId: this.actorId,
      turnId,
      runId: row.run_id,
      epoch: row.epoch,
      workMode: row.work_mode,
      program: Object.freeze({
        kind: row.program_kind,
        version: row.program_version,
        digest: row.program_digest,
        build: row.program_build,
      }),
      status: row.status,
      outcome: row.outcome,
      consumedRevision: row.consumed_revision,
      claimedAt: row.claimed_at,
    });
  }

  private nextRevision(turnId: string): number {
    const latest = this.sql<{ revision: number | null }>`
      SELECT MAX(revision) AS revision FROM actor_context_revisions
      WHERE actor_id = ${this.actorId} AND turn_id = ${turnId}`[0]?.revision;
    return (latest ?? 0) + 1;
  }

  /**
   * The fence, applied to every write.
   *
   * Three refusals, all `denied` because each is a decision and no effect: a
   * claim for another actor (a handle cannot write across the actor it was
   * bound to), a claim whose row is gone or holds a NEWER epoch (a stale
   * activation), and a claim already settled.
   */
  private assertLive(claim: ActorTurnClaim): void {
    this.actor.assertCurrent();
    if (claim.actorId !== this.actorId) {
      throw new KinuError('denied',
        `this claim belongs to actor ${claim.actorId} and cannot be written through actor ${this.actorId}`);
    }
    const row = this.sql<{ epoch: number; status: string }>`
      SELECT epoch, status FROM actor_turn_claims
      WHERE actor_id = ${this.actorId} AND turn_id = ${claim.turnId} LIMIT 1`[0];
    if (row === undefined) {
      throw new KinuError('denied', `actor turn ${claim.turnId} holds no durable claim`);
    }
    if (row.epoch !== claim.epoch) {
      throw new KinuError('denied',
        `actor turn ${claim.turnId} is owned by execution epoch ${row.epoch}, not ${claim.epoch}`);
    }
    if (row.status === 'settled') {
      throw new KinuError('denied', `actor turn ${claim.turnId} is settled and takes no further work`);
    }
  }
}

function revisionOf(row: RevisionRow): ContextRevision {
  return {
    revision: row.revision,
    epoch: row.epoch,
    baseRevision: row.base_revision,
    digest: row.digest,
    messageCount: row.message_count,
    stepIndex: row.step_index,
    messages: decodeModelMessages(row.messages),
  };
}

/** What a recovery established about a claimed turn. */
export type ClaimRecovery =
  /** The claimed program still retains the source the claim named, and the
   *  context the turn ran on reads back. */
  | { readonly kind: 'verified'; readonly claim: StoredActorClaim; readonly context: ModelMessage[] }
  /** The version's retained source no longer digests to what was claimed, or is
   *  gone. The turn is NOT resumed on different bytes than it was admitted on. */
  | { readonly kind: 'source_changed'; readonly claim: StoredActorClaim; readonly found: string | null }
  /** The host publishes no build identity for the builtin loop it claimed, so
   *  what ran cannot be established. Stated, never filled in. */
  | { readonly kind: 'build_unknown'; readonly claim: StoredActorClaim; readonly context: ModelMessage[] };

/**
 * Verify one stored claim against the source its version still retains.
 *
 * `readVersionedSource` is the immutable version reader (`scaffold/shadow.ts`'s
 * `readVersionedScaffoldSource`), never the live alias: the live file is a
 * rebuildable view that a promotion moves, and resuming a claimed turn on
 * whatever the view says now is the failure this verification exists to catch.
 */
export async function verifyClaimedProgram(
  claim: StoredActorClaim,
  readVersionedSource: (version: number) => Promise<string | null>,
  digestOf: (source: string) => string,
  loadContext: () => ContextRevision | null,
): Promise<ClaimRecovery> {
  const context = loadContext()?.messages ?? [];
  if (claim.program.kind === 'builtin') {
    return claim.program.build === null
      ? { kind: 'build_unknown', claim, context }
      : { kind: 'verified', claim, context };
  }
  const source = await readVersionedSource(claim.program.version);
  const found = source === null ? null : digestOf(source);
  if (found === null || found !== claim.program.digest) {
    return { kind: 'source_changed', claim, found };
  }
  return { kind: 'verified', claim, context };
}
