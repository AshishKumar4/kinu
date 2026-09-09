/**
 * The actor's WORKING HISTORY — the raw message array its future requests are
 * built from, versioned, editable, and in its own coordinate space.
 *
 * WHY THIS IS A SECOND LEDGER AND NOT A COLUMN ON THE RENDERED ONE. A step's
 * revision in `actor_context_revisions` is the array a model request actually
 * consumed: after error projection, steering, tool-output pruning, the
 * dynamic-context weave and the destination re-key. Its length is a fact about
 * a RENDERED request. The working history is the array a human or an agent
 * edits, before any of those passes run. The two counts are different numbers,
 * and using one as the other is the defect this module exists to remove:
 * slicing the live RAW array at `consumedContext(...).messageCount`, a count
 * taken in rendered space, lets a single woven `<dynamic_context>` block or one
 * pruned tool output move the protected tail boundary, so the turn either
 * re-sends work it has already done or drops it. Two spaces, two ledgers, one
 * pointer between them (`working_revision` on the rendered row); nothing infers
 * one coordinate from the other.
 *
 * WHAT A REVISION IS. A complete raw `ModelMessage[]`, through the typed native
 * codec (`prompting/message-codec.ts`), so tool calls, tool results, reasoning
 * and binary/URL attachments survive a round trip byte-for-byte — a working
 * history that lost an image on read and wrote it back as `{"0":137,…}` would
 * corrupt the very context it claims to edit.
 *
 * WHAT `base_message_count` IS. A revision is a PREFIX plus the offset in the
 * live array where the material it does not own begins:
 *
 *     live working history  ==  revision.messages ++ live.slice(base_message_count)
 *
 * For a snapshot (`source` 'hydrate'/'turn') the offset is its own length: it
 * owns everything. For an edit it is the length of the array the editor's base
 * revision owned, which is exactly where the turn's protected tail — the
 * assistant message that issued a tool call, its result, and any steer that
 * landed since — starts. An edit therefore cannot un-happen work that already
 * happened, and it cannot double-append it either.
 *
 * WHAT IT IS NOT. Not the transcript (`identity/conversation-store.ts` keeps
 * what was said), not the run evidence (`events/recorder.ts`), not the claim
 * ledger (`actor-claims.ts`), and not a second writable copy of context: the
 * `/context` VFS projection (`vfs/context-plane.ts`) serves THESE rows and
 * writes back through THESE methods. Rows are append-only. A superseded
 * revision is retained, because §6.4 of the product spec makes ordinary context
 * editing unable to falsify past evidence, and because a rollback is spelled as
 * "write the earlier revision's messages back as a NEW revision".
 */

import type { ModelMessage } from 'ai';
import { STAGED_CONTEXT_DEFERRALS, type StagedContextDeferral } from '../prompting/staged-context';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../state/actor-handle';
import { KinuError } from '../obs/error';
import { nowMs } from '../utils/date';
import { decodeModelMessages, encodeModelMessages, modelMessagesDigest } from '../prompting/message-codec';
import { sqlCheckList } from '../identity/schema';

/** How a revision came to exist. */
const WORKING_SOURCES = ['hydrate', 'turn', 'edit'] as const;
export type WorkingSource = (typeof WORKING_SOURCES)[number];

/**
 * Where a revision stands.
 *
 * `active` is the one the runtime builds requests from — at most one per actor.
 * `staged` is an authored edit waiting for a safe boundary. `superseded` is
 * every revision that is neither, whether it was effective once (its
 * `activatedAt` says so) or never became effective (`closedReason` says why).
 */
const WORKING_STATUSES = ['staged', 'active', 'superseded'] as const;
export type WorkingStatus = (typeof WORKING_STATUSES)[number];

/** Which surface authored a revision. `runtime` is the host recording what the
 *  actor's own history now is; the other three are edits. */
const WORKING_VIAS = ['runtime', 'file', 'session', 'owner'] as const;
export type WorkingVia = (typeof WORKING_VIAS)[number];

/** Why a staged edit was closed without ever becoming effective. */
const WORKING_CLOSED_REASONS = ['history_rewritten', 'superseded_by_edit'] as const;
export type WorkingClosedReason = (typeof WORKING_CLOSED_REASONS)[number];

/** One revision's metadata — everything except the messages themselves, which
 *  a listing must not pay for. */
export interface WorkingRevision {
  readonly revision: number;
  /** The revision this content was derived from, or null for the first one. */
  readonly baseRevision: number | null;
  /** Where the material this revision does not own begins in the live array. */
  readonly baseMessageCount: number;
  readonly source: WorkingSource;
  readonly status: WorkingStatus;
  readonly via: WorkingVia;
  /** The ISSUED actor id that authored it: the actor itself, or the parent/owner
   *  that edited it through an authorized surface. */
  readonly author: string;
  readonly digest: string;
  readonly messageCount: number;
  /** The turn that was live when it was authored, or null between turns. */
  readonly turnId: string | null;
  /** The turn whose boundary made it effective, null while it never was. */
  readonly activatedTurnId: string | null;
  /** The step index it landed at, null for a turn-boundary activation. */
  readonly activatedStep: number | null;
  readonly activatedAt: number | null;
  /** Why the last boundary that saw this staged revision could not take it.
   *  Null once it activates, and null while nothing has blocked it — a pending
   *  edit that reads as blocked says so instead of looking ignored. */
  readonly deferredReason: StagedContextDeferral | null;
  readonly deferredAt: number | null;
  readonly closedReason: WorkingClosedReason | null;
  readonly recordedAt: number;
}

/** A revision with its array decoded. */
export interface WorkingRevisionContent extends WorkingRevision {
  readonly messages: ModelMessage[];
}

export function initActorWorkingContextTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS actor_working_revisions (
    actor_id           TEXT NOT NULL,
    revision           INTEGER NOT NULL,
    base_revision      INTEGER,
    base_message_count INTEGER NOT NULL,
    source             TEXT NOT NULL CHECK(source IN (${sqlCheckList(WORKING_SOURCES)})),
    status             TEXT NOT NULL CHECK(status IN (${sqlCheckList(WORKING_STATUSES)})),
    via                TEXT NOT NULL CHECK(via IN (${sqlCheckList(WORKING_VIAS)})),
    author             TEXT NOT NULL,
    digest             TEXT NOT NULL,
    message_count      INTEGER NOT NULL,
    messages           TEXT NOT NULL,
    turn_id            TEXT,
    activated_turn     TEXT,
    activated_step     INTEGER,
    activated_at       INTEGER,
    deferred_reason    TEXT CHECK(deferred_reason IS NULL OR deferred_reason IN (${sqlCheckList(STAGED_CONTEXT_DEFERRALS)})),
    deferred_at        INTEGER,
    closed_reason      TEXT CHECK(closed_reason IS NULL OR closed_reason IN (${sqlCheckList(WORKING_CLOSED_REASONS)})),
    recorded_at        INTEGER NOT NULL,
    PRIMARY KEY (actor_id, revision)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_actor_working_status
    ON actor_working_revisions(actor_id, status, revision DESC)`);
}

/** One row's metadata columns, as SQL names them. `messages` is deliberately
 *  absent: a listing of two hundred revisions must not decode — or even
 *  transfer — two hundred whole message arrays. */
interface WorkingMetaRow {
  revision: number;
  base_revision: number | null;
  base_message_count: number;
  source: WorkingSource;
  status: WorkingStatus;
  via: WorkingVia;
  author: string;
  digest: string;
  message_count: number;
  turn_id: string | null;
  activated_turn: string | null;
  activated_step: number | null;
  activated_at: number | null;
  deferred_reason: StagedContextDeferral | null;
  deferred_at: number | null;
  closed_reason: WorkingClosedReason | null;
  recorded_at: number;
}

interface WorkingRow extends WorkingMetaRow {
  messages: string;
}

function metaOf(row: WorkingMetaRow): WorkingRevision {
  return Object.freeze({
    revision: row.revision,
    baseRevision: row.base_revision,
    baseMessageCount: row.base_message_count,
    source: row.source,
    status: row.status,
    via: row.via,
    author: row.author,
    digest: row.digest,
    messageCount: row.message_count,
    turnId: row.turn_id,
    activatedTurnId: row.activated_turn,
    activatedStep: row.activated_step,
    activatedAt: row.activated_at,
    deferredReason: row.deferred_reason,
    deferredAt: row.deferred_at,
    closedReason: row.closed_reason,
    recordedAt: row.recorded_at,
  });
}

function contentOf(row: WorkingRow): WorkingRevisionContent {
  return Object.freeze({ ...metaOf(row), messages: decodeModelMessages(row.messages) });
}

/**
 * One actor's working-history ledger.
 *
 * Bound to an {@link ActorHandle} like every actor-scoped store in this bundle:
 * the handle carries the validation its binding captured, so a store cannot
 * outlive the identity it was bound to and a parent editing a child holds the
 * CHILD's handle — which is what makes "the same checks" true rather than
 * asserted, and what refuses a retired or re-parented actor before a statement
 * runs.
 */
export class ActorWorkingContextStore {
  private readonly actorId: string;

  constructor(
    private readonly sql: SqlExecutor,
    private readonly actor: ActorHandle,
    private readonly transactionSync: <T>(write: () => T) => T,
  ) {
    this.actorId = actor.actorId;
  }

  /** The newest revision — what an editor reads and compares against. Null when
   *  this actor has never recorded one, which is a fresh actor and not an
   *  error: the surfaces above answer "revision 0, no messages yet". */
  head(): WorkingRevisionContent | null {
    this.actor.assertCurrent();
    const row = this.sql<WorkingRow>`
      SELECT * FROM actor_working_revisions WHERE actor_id = ${this.actorId}
      ORDER BY revision DESC LIMIT 1`[0];
    return row === undefined ? null : contentOf(row);
  }

  /** The revision the runtime builds requests from. */
  active(): WorkingRevisionContent | null {
    this.actor.assertCurrent();
    const row = this.sql<WorkingRow>`
      SELECT * FROM actor_working_revisions
      WHERE actor_id = ${this.actorId} AND status = 'active'
      ORDER BY revision DESC LIMIT 1`[0];
    return row === undefined ? null : contentOf(row);
  }

  /** The newest authored edit still waiting for a safe boundary. */
  staged(): WorkingRevisionContent | null {
    this.actor.assertCurrent();
    const row = this.sql<WorkingRow>`
      SELECT * FROM actor_working_revisions
      WHERE actor_id = ${this.actorId} AND status = 'staged'
      ORDER BY revision DESC LIMIT 1`[0];
    return row === undefined ? null : contentOf(row);
  }

  revision(revision: number): WorkingRevisionContent | null {
    this.actor.assertCurrent();
    const row = this.sql<WorkingRow>`
      SELECT * FROM actor_working_revisions
      WHERE actor_id = ${this.actorId} AND revision = ${revision} LIMIT 1`[0];
    return row === undefined ? null : contentOf(row);
  }

  /** Every revision's metadata, newest first — the change history §6.2 asks for:
   *  who changed what, from which base, whether it activated, and where. */
  history(limit = 200): readonly WorkingRevision[] {
    this.actor.assertCurrent();
    return this.sql<WorkingMetaRow>`
      SELECT revision, base_revision, base_message_count, source, status, via, author,
             digest, message_count, turn_id, activated_turn, activated_step, activated_at,
             closed_reason, recorded_at
      FROM actor_working_revisions WHERE actor_id = ${this.actorId}
      ORDER BY revision DESC LIMIT ${limit}`.map(metaOf);
  }

  /**
   * Append the working history as it now stands.
   *
   * `lands` names a staged edit whose content this snapshot incorporates: the
   * edit is marked effective at the same boundary, in the same transaction, so
   * an activation and the array it produced can never disagree. Identical
   * content is not appended twice — a turn that changed nothing writes no row —
   * and the previously active revision is superseded rather than rewritten.
   */
  append(input: {
    readonly messages: readonly ModelMessage[];
    readonly source: Exclude<WorkingSource, 'edit'>;
    readonly turnId: string | null;
    readonly lands?: { readonly revision: number; readonly stepIndex: number | null } | null;
  }): WorkingRevision {
    this.actor.assertCurrent();
    const encoded = encodeModelMessages(input.messages);
    const digest = modelMessagesDigest(encoded);
    const at = nowMs();
    return this.transactionSync(() => {
      const active = this.sql<WorkingMetaRow>`
        SELECT revision, base_revision, base_message_count, source, status, via, author,
               digest, message_count, turn_id, activated_turn, activated_step, activated_at,
               deferred_reason, deferred_at, closed_reason, recorded_at
        FROM actor_working_revisions
        WHERE actor_id = ${this.actorId} AND status = 'active'
        ORDER BY revision DESC LIMIT 1`[0] ?? null;
      const lands = input.lands ?? null;
      if (lands === null
        && active !== null
        && active.digest === digest
        && active.base_message_count === input.messages.length) {
        return metaOf(active);
      }
      // A turn boundary FOLDS the edit into this snapshot rather than making
      // the edit row itself active: the snapshot re-anchors the offset to its
      // own length, which is what a turn needs (the admitted array is a
      // different length, so an offset into the old one would slice the new one
      // in the wrong place). The edit is marked effective and closed in the
      // same statement pair — leaving it `staged` would let the next boundary
      // land the same change again.
      if (lands !== null) {
        this.markActivated(lands.revision, input.turnId, lands.stepIndex, at, 'superseded');
      }
      const revision = this.nextRevision();
      void this.sql`
        INSERT INTO actor_working_revisions (
          actor_id, revision, base_revision, base_message_count, source, status, via, author,
          digest, message_count, messages, turn_id, activated_turn, activated_step, activated_at,
          deferred_reason, deferred_at, closed_reason, recorded_at)
        VALUES (${this.actorId}, ${revision}, ${lands?.revision ?? active?.revision ?? null},
          ${input.messages.length}, ${input.source}, 'active', 'runtime', ${this.actorId},
          ${digest}, ${input.messages.length}, ${encoded}, ${input.turnId},
          ${input.turnId}, ${lands?.stepIndex ?? null}, ${at}, NULL, NULL, NULL, ${at})`;
      this.supersede(revision);
      return this.requireMeta(revision);
    });
  }

  /**
   * Author an edit against the revision the editor read.
   *
   * The compare-and-set is the whole point: `base` must still be the newest
   * revision, so two editors racing produce one refusal instead of one silent
   * overwrite, and an editor working from a stale read cannot replace progress
   * it never saw (§6.3 rules 2 and 3). `base` 0 means "this actor had no
   * revision yet" and is accepted only while that is still true.
   *
   * The edit is STAGED. It is not the working history until a boundary takes
   * it, because an in-flight request keeps the versions it started with.
   */
  stage(input: {
    readonly base: number;
    readonly messages: readonly ModelMessage[];
    readonly author: string;
    readonly via: Exclude<WorkingVia, 'runtime'>;
    readonly turnId: string | null;
  }): WorkingRevision {
    this.actor.assertCurrent();
    const encoded = encodeModelMessages(input.messages);
    const digest = modelMessagesDigest(encoded);
    const at = nowMs();
    return this.transactionSync(() => {
      const head = this.sql<WorkingMetaRow>`
        SELECT revision, base_revision, base_message_count, source, status, via, author,
               digest, message_count, turn_id, activated_turn, activated_step, activated_at,
               deferred_reason, deferred_at, closed_reason, recorded_at
        FROM actor_working_revisions WHERE actor_id = ${this.actorId}
        ORDER BY revision DESC LIMIT 1`[0] ?? null;
      const current = head?.revision ?? 0;
      if (current !== input.base) {
        throw new KinuError('denied',
          `this context edit was written against working revision ${input.base}, and revision ${current} is current`);
      }
      // Every pending edit at or below the base is written on top of: its
      // content is already inside this new revision, so landing both would
      // apply the same change twice. Retained with the reason, never deleted.
      for (const row of this.sql<{ revision: number }>`
        SELECT revision FROM actor_working_revisions
        WHERE actor_id = ${this.actorId} AND status = 'staged' AND revision <= ${current}`) {
        this.close(row.revision, 'superseded_by_edit');
      }
      const revision = current + 1;
      void this.sql`
        INSERT INTO actor_working_revisions (
          actor_id, revision, base_revision, base_message_count, source, status, via, author,
          digest, message_count, messages, turn_id, activated_turn, activated_step, activated_at,
          deferred_reason, deferred_at, closed_reason, recorded_at)
        VALUES (${this.actorId}, ${revision}, ${head === null ? null : head.revision},
          ${head?.base_message_count ?? 0}, 'edit', 'staged', ${input.via}, ${input.author},
          ${digest}, ${input.messages.length}, ${encoded}, ${input.turnId},
          NULL, NULL, NULL, NULL, NULL, NULL, ${at})`;
      return this.requireMeta(revision);
    });
  }

  /**
   * Make a staged edit the working history, at the boundary that took it.
   *
   * Used where the offset the edit carries stays valid — a mid-turn step
   * boundary, whose live array still begins with the same prefix the edit was
   * authored against. A turn boundary re-anchors instead (see {@link append}
   * with `lands`), because the admitted array is a different length and an
   * offset into the old one would slice the new one in the wrong place.
   */
  activate(revision: number, at: { readonly turnId: string; readonly stepIndex: number | null }): WorkingRevision {
    this.actor.assertCurrent();
    return this.transactionSync(() => {
      this.markActivated(revision, at.turnId, at.stepIndex, nowMs(), 'active');
      this.supersede(revision);
      return this.requireMeta(revision);
    });
  }

  /** Close a staged edit that can never be applied, with the reason. Retained,
   *  never deleted: a proposal that failed is evidence about the actor too. */
  close(revision: number, reason: WorkingClosedReason): WorkingRevision {
    this.actor.assertCurrent();
    void this.sql`
      UPDATE actor_working_revisions SET status = 'superseded', closed_reason = ${reason}
      WHERE actor_id = ${this.actorId} AND revision = ${revision} AND status = 'staged'`;
    return this.requireMeta(revision);
  }

  /**
   * Record that a boundary saw this staged revision and could not take it.
   *
   * Written only when the reason CHANGES, so a mid-exchange edit that waits
   * five steps writes one row update rather than five: the fact being recorded
   * is "this edit is blocked, for this reason", not how many times a step
   * asked. A pending edit that reads as blocked is the difference between a
   * surface that reports and one that looks like it ignored the write.
   */
  defer(revision: number, reason: StagedContextDeferral): void {
    this.actor.assertCurrent();
    void this.sql`
      UPDATE actor_working_revisions SET deferred_reason = ${reason}, deferred_at = ${nowMs()}
      WHERE actor_id = ${this.actorId} AND revision = ${revision} AND status = 'staged'
        AND (deferred_reason IS NULL OR deferred_reason <> ${reason})`;
  }

  private requireMeta(revision: number): WorkingRevision {
    const row = this.sql<WorkingMetaRow>`
      SELECT revision, base_revision, base_message_count, source, status, via, author,
             digest, message_count, turn_id, activated_turn, activated_step, activated_at,
             deferred_reason, deferred_at, closed_reason, recorded_at
      FROM actor_working_revisions WHERE actor_id = ${this.actorId} AND revision = ${revision} LIMIT 1`[0];
    if (row === undefined) {
      throw new KinuError('io', `working revision ${revision} was written and cannot be read back`);
    }
    return metaOf(row);
  }

  /**
   * Record that a boundary made this staged revision effective, and where it
   * stands afterwards.
   *
   * `status` is the caller's, because the two boundaries differ: a step
   * boundary makes the edit row ITSELF the working history (`active`), while a
   * turn boundary folds its content into a re-anchored snapshot, so the edit is
   * effective and immediately past (`superseded`). Either way `activated_at` is
   * what says it WAS effective — a superseded row with no activation never was.
   */
  private markActivated(
    revision: number, turnId: string | null, stepIndex: number | null, at: number,
    status: Extract<WorkingStatus, 'active' | 'superseded'>,
  ): void {
    const row = this.sql<{ status: WorkingStatus }>`
      SELECT status FROM actor_working_revisions
      WHERE actor_id = ${this.actorId} AND revision = ${revision} LIMIT 1`[0];
    if (row === undefined) {
      throw new KinuError('missing', `working revision ${revision} does not exist for this actor`);
    }
    if (row.status !== 'staged') {
      throw new KinuError('denied',
        `working revision ${revision} is ${row.status} and cannot be activated again`);
    }
    void this.sql`
      UPDATE actor_working_revisions
      SET status = ${status}, activated_turn = ${turnId}, activated_step = ${stepIndex},
          activated_at = ${at}, deferred_reason = NULL, deferred_at = NULL
      WHERE actor_id = ${this.actorId} AND revision = ${revision}`;
  }

  /**
   * The former working history steps down when a new one is written.
   *
   * ONLY the active row. A staged edit is deliberately left alone: whether its
   * base still exists in the live array is a comparison against that array,
   * which this store never sees, so the context plane makes that call and
   * closes the edit explicitly with `history_rewritten` when the base is gone.
   * Closing it here — on the theory that a newer revision must have
   * invalidated it — is how a pending edit would silently disappear at a turn
   * boundary it was merely waiting for.
   */
  private supersede(revision: number): void {
    void this.sql`
      UPDATE actor_working_revisions SET status = 'superseded'
      WHERE actor_id = ${this.actorId} AND revision <> ${revision} AND status = 'active'`;
  }

  private nextRevision(): number {
    const latest = this.sql<{ revision: number | null }>`
      SELECT MAX(revision) AS revision FROM actor_working_revisions
      WHERE actor_id = ${this.actorId}`[0]?.revision;
    return (latest ?? 0) + 1;
  }
}
