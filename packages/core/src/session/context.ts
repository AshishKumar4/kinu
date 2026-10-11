import type { ActorHandle } from '../identity/actor-handle';
import { Effect } from 'effect';
import { settleSync } from '../obs/effect';
import type { SqlExecutor } from '../types/primitives';
import { KinuError } from '../obs/error';
import type { MessageReference, SessionMessageReader } from './messages';

export interface ContextSelection { readonly contextId: string; readonly revision: number }

export interface ContextEntry extends MessageReference { readonly entryId: string; readonly position: number }

interface MemberRow { entry_id: string; position: number; message_id: string }

/** A context's head revision with the rows it opened and the highest live position: whether a kept head still serves. */
interface HeadRow { revision: number | null; entry_id: string | null; position: number | null; message_id: string | null; last: number | null }

interface HeadProbe { readonly selection: ContextSelection; readonly opened: string; readonly count: number }

function probeOf(contextId: string, rows: readonly HeadRow[]): HeadProbe | null {
  const first = rows[0];

  if (first === undefined || first.revision === null) return null;
  const opened: ContextEntry[] = [];

  for (const row of rows) {
    if (row.entry_id !== null && row.position !== null && row.message_id !== null) opened.push({ entryId: row.entry_id, position: row.position, messageId: row.message_id });
  }

  return { selection: { contextId, revision: first.revision }, opened: openedKey(opened), count: first.last === null ? 0 : first.last + 1 };
}

/** A revision this instance just wrote with nothing in it yet. */
const emptyProbe = (selection: ContextSelection): HeadProbe => ({ selection, opened: '', count: 0 });

/** The rows a revision opened, in one comparable form. */
function openedKey(opened: readonly ContextEntry[]): string {
  return opened.map(entry => `${entry.entryId}@${String(entry.position)}=${entry.messageId}`).sort().join('\n');
}

function entryOf(row: MemberRow): ContextEntry {
  return { entryId: row.entry_id, position: row.position, messageId: row.message_id };
}

/** How many leading entries a mutation kept as the head's own objects: those are unchanged, and need no lookup. */
function keptPrefix(current: readonly ContextEntry[], next: readonly ContextEntry[]): number {
  let kept = 0;

  while (kept < current.length && kept < next.length && next[kept] === current[kept]) kept++;

  return kept;
}

/**
 * A head this instance read or wrote. It serves while its revision is still the head, opened the same rows and holds
 * as many entries: positions are dense, so those fix the membership. A revision written again after a rolled-back
 * transaction opens rows with other messages, or a different count, whatever its stamp.
 */
interface KeptHead {
  readonly revision: number; readonly opened: string; readonly entries: readonly ContextEntry[];
  /** The entries' ids; an append extends the superseded head's set instead of collecting a new one. */
  readonly ids: Set<string>;
}

/** `recordUnchanged`: an authored edit is a statement even when it moves nothing. `named`: the entries a caller named a
 *  message for, each proven an actor-owned semantic message by the row that joins it. */
interface RevisionOrigin {
  readonly author: string; readonly cause: string; readonly turnId: string | null; readonly proposalId: string | null;
  readonly recordUnchanged: boolean; readonly named: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

export interface ContextCommitRequest {
  /** What the revision is recorded as: `input`, `output`, `edit`, `context_transform`. */
  readonly cause: string;
  readonly turnId: string | null;
  /** Returns the membership the revision publishes; runs inside the transaction. */
  readonly mutate: (current: readonly ContextEntry[]) => readonly ContextEntry[];
  readonly assertEpoch: () => Effect.Effect<void, KinuError>;
  /** The staged proposal this change applies: it authors the revision and is recorded on it. */
  readonly proposal?: { readonly id: string; readonly author: string };
}

/** Interval membership is both the current selection and its historical record. */
export class SessionContext {
  /** Each context's head as last read or written here: a committed revision's membership never changes. */
  private readonly heads = new Map<string, KeptHead>();

  constructor(private readonly sql: SqlExecutor, private readonly actor: ActorHandle, private readonly atomic: <T>(operation: () => T) => T,
    private readonly messages: Pick<SessionMessageReader, 'originOf'>) {}

  selected(): ContextSelection | null {
    this.actor.assertCurrent();

    // One index seek; MAX over a GROUP BY join read every revision.
    const row = this.sql<{ context_id: string; revision: number | null }>`SELECT s.context_id,(SELECT MAX(r.revision) FROM context_revisions r
      WHERE r.actor_id=s.actor_id AND r.context_id=s.context_id) AS revision FROM actor_context_selection s WHERE s.actor_id=${this.actor.actorId}`[0];

    return row === undefined || row.revision === null ? null : { contextId: row.context_id, revision: row.revision };
  }

  revisions(contextId: string): readonly { revision: number; author: string; cause: string; turn_id: string | null; proposal_id: string | null; recorded_at: number }[] {
    this.actor.assertCurrent();

    return this.sql`SELECT revision,author,cause,turn_id,proposal_id,recorded_at FROM context_revisions WHERE actor_id=${this.actor.actorId} AND context_id=${contextId} ORDER BY revision DESC`;
  }

  initialize(contextId = crypto.randomUUID()): ContextSelection {
    this.actor.assertCurrent();

    return this.atomic(() => {
      const selected = this.selected();

      if (selected !== null) return selected;
      const actorId = this.actor.actorId;
      void this.sql`INSERT INTO actor_contexts(actor_id,context_id) VALUES(${actorId},${contextId})`;
      void this.sql`INSERT INTO context_revisions(actor_id,context_id,revision,author,cause,recorded_at)
        VALUES(${actorId},${contextId},0,${actorId},'input',${Date.now()})`;
      void this.sql`INSERT INTO actor_context_selection(actor_id,context_id) VALUES(${actorId},${contextId})`;

      return { contextId, revision: 0 };
    });
  }

  entries(selection: ContextSelection): readonly ContextEntry[] {
    this.actor.assertCurrent();
    const actorId = this.actor.actorId;
    const { contextId, revision } = selection;
    const head = this.headOf(contextId);

    if (head?.selection.revision === revision) return this.keptHead(head).entries;

    if (this.sql`SELECT 1 AS found FROM context_revisions WHERE actor_id=${actorId} AND context_id=${contextId} AND revision=${revision}`.length === 0) {
      throw new KinuError('missing', 'context revision does not exist');
    }

    return Object.freeze(this.sql<MemberRow>`SELECT entry_id,position,message_id FROM context_memberships WHERE actor_id=${actorId} AND context_id=${contextId}
      AND from_revision<=${revision} AND (to_revision IS NULL OR to_revision>${revision}) ORDER BY position`.map(entryOf));
  }

  /** Selection and membership from one synchronous read boundary; the selection already names the head. */
  snapshot() {
    this.actor.assertCurrent();
    const head = this.headOf(null) ?? emptyProbe(this.initialize());

    return { selection: head.selection, entries: this.keptHead(head).entries };
  }

  /**
   * The selected context's head, or `contextId`'s, in one read: its revision, the rows that revision opened, and its live
   * count. Positions are dense, so those tell whether the head this instance kept still serves.
   */
  private headOf(contextId: string | null): HeadProbe | null {
    const actorId = this.actor.actorId;

    if (contextId !== null) {
      return probeOf(contextId, this.sql<HeadRow>`SELECT h.revision,m.entry_id,m.position,m.message_id,
          (SELECT MAX(position) FROM context_memberships WHERE actor_id=${actorId} AND context_id=${contextId} AND to_revision IS NULL) AS last
        FROM (SELECT MAX(revision) AS revision FROM context_revisions WHERE actor_id=${actorId} AND context_id=${contextId}) h
        LEFT JOIN context_memberships m ON m.actor_id=${actorId} AND m.context_id=${contextId} AND m.from_revision=h.revision`);
    }

    const rows = this.sql<HeadRow & { context_id: string }>`SELECT h.context_id,h.revision,m.entry_id,m.position,m.message_id,
        (SELECT MAX(position) FROM context_memberships WHERE actor_id=${actorId} AND context_id=h.context_id AND to_revision IS NULL) AS last
      FROM (SELECT s.context_id,(SELECT MAX(r.revision) FROM context_revisions r WHERE r.actor_id=s.actor_id AND r.context_id=s.context_id) AS revision
        FROM actor_context_selection s WHERE s.actor_id=${actorId}) h
      LEFT JOIN context_memberships m ON m.actor_id=${actorId} AND m.context_id=h.context_id AND m.from_revision=h.revision`;

    const selected = rows[0]?.context_id;

    return selected === undefined ? null : probeOf(selected, rows);
  }

  private keptHead(probe: HeadProbe): KeptHead {
    const { contextId, revision } = probe.selection;
    const actorId = this.actor.actorId;
    const kept = this.heads.get(contextId);

    if (kept?.revision === revision && kept.entries.length === probe.count && kept.opened === probe.opened) return kept;

    const rows = this.sql<MemberRow & { from_revision: number }>`SELECT entry_id,position,message_id,from_revision FROM context_memberships
      WHERE actor_id=${actorId} AND context_id=${contextId} AND to_revision IS NULL ORDER BY position`;

    const entries = Object.freeze(rows.map(entryOf));
    const opened = openedKey(rows.filter(row => row.from_revision === revision).map(entryOf));
    const head = { revision, opened, entries, ids: new Set(entries.map(entry => entry.entryId)) };
    this.heads.set(contextId, head);

    return head;
  }

  conversationOf(members: readonly ContextEntry[]): ContextEntry[] {
    return members.filter(member => this.messages.originOf(member) !== 'render');
  }

  /** The mutation callback publishes message rows under the same transaction as their membership.
   *  Null `expected` prepares nothing asynchronously: it mutates the current selection. */
  commit(expected: ContextSelection | null, request: ContextCommitRequest): ContextSelection {
    const { cause, turnId, mutate, assertEpoch, proposal } = request;

    return this.atomic(() => settleSync(Effect.gen({ self: this }, function* () {
      this.actor.assertCurrent();
      yield* assertEpoch();
      const probe = this.headOf(null) ?? (expected === null ? emptyProbe(this.initialize()) : null);

      if (probe === null || (expected !== null && (probe.selection.contextId !== expected.contextId || probe.selection.revision !== expected.revision))) {
        throw new KinuError('denied', 'context changed during preparation');
      }

      const head = this.keptHead(probe);
      const current = head.entries;
      const next = mutate(current);
      // A sealed step appends one entry to a head of hundreds: only what the mutation changed is checked.
      const kept = keptPrefix(current, next);
      const keptIds = kept === current.length ? head.ids : new Set(current.slice(0, kept).map(entry => entry.entryId));
      const ids = new Set<string>();
      const prior = new Map(current.slice(kept).map(entry => [entry.entryId, entry]));
      const named = new Set<string>();

      for (let position = kept; position < next.length; position++) {
        const entry = next[position];

        if (entry.position !== position || keptIds.has(entry.entryId) || ids.has(entry.entryId)) {
          throw new KinuError('bad_input', 'context entries must have unique identities and dense positions');
        }

        if (prior.get(entry.entryId)?.messageId !== entry.messageId) named.add(entry.entryId);
        ids.add(entry.entryId);
      }

      // An empty authored edit is still recorded: an explicitly empty history is a statement.
      return this.revise(probe.selection, head, next, { author: proposal?.author ?? this.actor.actorId, cause, turnId, proposalId: proposal?.id ?? null,
        recordUnchanged: proposal !== undefined || cause === 'edit', named });
    })));
  }

  /** Before entry `before`, else at the end; one revision, less the renders it `replaces`. */
  addRender(
    reference: MessageReference, at: { readonly before: string | null; readonly replaces: boolean },
    request: { readonly turnId: string | null; readonly assertEpoch: () => Effect.Effect<void, KinuError> },
  ): ContextSelection {
    return this.atomic(() => settleSync(Effect.gen({ self: this }, function* () {
      this.actor.assertCurrent();
      yield* request.assertEpoch();
      const probe = this.headOf(null) ?? emptyProbe(this.initialize());
      const head = this.keptHead(probe);
      const current = head.entries;
      const kept = at.replaces ? this.conversationOf(current) : current;
      const anchor = kept.findIndex(entry => entry.entryId === at.before);
      const index = anchor < 0 ? kept.length : anchor;
      const added = { entryId: crypto.randomUUID(), messageId: reference.messageId, position: index };
      const next = [...kept.slice(0, index), added, ...kept.slice(index)].map((entry, position) => ({ ...entry, position }));

      return this.revise(probe.selection, head, next, { author: this.actor.actorId, cause: 'render', turnId: request.turnId, proposalId: null, recordUnchanged: false, named: NONE });
    })));
  }

  /** The next revision of an unselected context, opened on first use: an entry is its position, so a kept message writes nothing. */
  record(contextId: string, messages: readonly MessageReference[]): ContextSelection {
    return this.atomic(() => {
      this.actor.assertCurrent();
      const probe = this.headOf(contextId) ?? emptyProbe(this.fork(null, contextId));
      const kept = this.keptHead(probe);
      const current = kept.entries;

      const next = messages.map((message, position) => {
        const same = current[position];

        return same?.messageId === message.messageId && same.entryId === String(position) ? same : { messageId: message.messageId, entryId: String(position), position };
      });

      return this.revise(probe.selection, kept, next, { author: this.actor.actorId, cause: 'render', turnId: null, proposalId: null, recordUnchanged: false, named: NONE });
    });
  }

  private revise(expected: ContextSelection, head: KeptHead, next: readonly ContextEntry[], origin: RevisionOrigin): ContextSelection {
    const current = head.entries;
    const kept = keptPrefix(current, next);
    const prior = new Map(current.slice(kept).map(entry => [entry.entryId, entry]));
    const retained = new Set<string>();

    for (const entry of next.slice(kept)) {
      const old = prior.get(entry.entryId);

      if (old !== undefined && old.position === entry.position && old.messageId === entry.messageId) retained.add(entry.entryId);
    }

    if (!origin.recordUnchanged && kept + retained.size === current.length && current.length === next.length) return expected;
    const revision = expected.revision + 1;
    const actorId = this.actor.actorId;
    void this.sql`INSERT INTO context_revisions(actor_id,context_id,revision,author,cause,turn_id,proposal_id,recorded_at)
      VALUES(${actorId},${expected.contextId},${revision},${origin.author},${origin.cause},${origin.turnId},${origin.proposalId},${Date.now()})`;

    // Release all changed live positions before inserting replacements: swaps cannot collide.
    for (const entry of current.slice(kept)) if (!retained.has(entry.entryId)) {
      void this.sql`UPDATE context_memberships SET to_revision=${revision}
        WHERE actor_id=${actorId} AND context_id=${expected.contextId} AND entry_id=${entry.entryId} AND to_revision IS NULL`;
    }

    for (const entry of next.slice(kept)) if (!retained.has(entry.entryId)) {
      if (!origin.named.has(entry.entryId)) {
        void this.sql`INSERT INTO context_memberships(actor_id,context_id,entry_id,from_revision,position,message_id)
          VALUES(${actorId},${expected.contextId},${entry.entryId},${revision},${entry.position},${entry.messageId})`;
        continue;
      }

      const joined = this.sql<{ entry_id: string }>`INSERT INTO context_memberships(actor_id,context_id,entry_id,from_revision,position,message_id)
        SELECT ${actorId},${expected.contextId},${entry.entryId},${revision},${entry.position},message_id FROM session_messages
        WHERE actor_id=${actorId} AND message_id=${entry.messageId} AND origin!='render' RETURNING entry_id`;

      if (joined.length === 0) throw new KinuError('denied', 'working context requires an actor-owned semantic message');
    }

    const ids = kept === current.length ? head.ids : new Set(current.slice(0, kept).map(entry => entry.entryId));

    for (let position = kept; position < next.length; position++) ids.add(next[position].entryId);
    this.heads.set(expected.contextId, { revision, opened: openedKey(next.slice(kept).filter(entry => !retained.has(entry.entryId))), entries: Object.freeze(next), ids });

    return { contextId: expected.contextId, revision };
  }

  private head(contextId: string): number | null {
    return this.sql<{ revision: number | null }>`SELECT MAX(revision) AS revision FROM context_revisions WHERE actor_id=${this.actor.actorId} AND context_id=${contextId}`[0]?.revision ?? null;
  }

  /** A new context at revision 0: the source's live entries when given, empty otherwise. */
  fork(source: ContextSelection | null, contextId: string = crypto.randomUUID()): ContextSelection {
    this.actor.assertCurrent();

    return this.atomic(() => {
      const actorId = this.actor.actorId;

      if (source !== null) {
        const exists = this.sql<{ revision: number }>`SELECT revision FROM context_revisions
          WHERE actor_id=${actorId} AND context_id=${source.contextId} AND revision=${source.revision}`[0];

        if (exists === undefined) throw new KinuError('missing', 'fork source revision does not exist');
      }

      void this.sql`INSERT INTO actor_contexts(actor_id,context_id) VALUES(${actorId},${contextId})`;
      void this.sql`INSERT INTO context_revisions(actor_id,context_id,revision,author,cause,recorded_at) VALUES(${actorId},${contextId},0,${actorId},'fork',${Date.now()})`;

      for (const entry of source === null ? [] : this.entries(source)) void this.sql`INSERT INTO context_memberships(actor_id,context_id,entry_id,from_revision,position,message_id)
        VALUES(${actorId},${contextId},${entry.entryId},0,${entry.position},${entry.messageId})`;

      return { contextId, revision: 0 };
    });
  }

  select(expected: ContextSelection, target: ContextSelection, assertIdle: () => Effect.Effect<void, KinuError>): void {
    return this.atomic(() => settleSync(Effect.gen({ self: this }, function* () {
      this.actor.assertCurrent();
      yield* assertIdle();
      const selected = this.selected();

      if (selected?.contextId !== expected.contextId || selected.revision !== expected.revision) throw new KinuError('denied', 'context selection changed');

      if (this.head(target.contextId) !== target.revision) throw new KinuError('denied', 'branch selection must name its current revision');
      void this.sql`UPDATE actor_context_selection SET context_id=${target.contextId} WHERE actor_id=${this.actor.actorId}`;
    })));
  }
}
