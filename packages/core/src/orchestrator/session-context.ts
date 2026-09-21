import type { ActorHandle } from '../identity/actor-handle';
import type { SqlExecutor } from '../types/primitives';
import { KinuError } from '../obs/error';
import type { MessageReference } from './session-messages';

export interface ContextSelection { readonly contextId: string; readonly revision: number }

export interface ContextEntry extends MessageReference { readonly entryId: string; readonly position: number }

interface MemberRow { entry_id: string; position: number; message_id: string; through_sequence: number }

/** Interval membership is both the current selection and its historical record. */
export class SessionContext {
  constructor(private readonly sql: SqlExecutor, private readonly actor: ActorHandle, private readonly atomic: <T>(operation: () => T) => T) {}

  selected(): ContextSelection | null {
    this.actor.assertCurrent();

    const row = this.sql<{ context_id: string; revision: number }>`SELECT s.context_id,MAX(r.revision) AS revision
      FROM actor_context_selection s JOIN context_revisions r ON r.actor_id=s.actor_id AND r.context_id=s.context_id
      WHERE s.actor_id=${this.actor.actorId} GROUP BY s.context_id`[0];

    return row === undefined ? null : { contextId: row.context_id, revision: row.revision };
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

  entries(selection: ContextSelection): ContextEntry[] {
    this.actor.assertCurrent();
    const exists = this.sql<{ revision: number }>`SELECT revision FROM context_revisions WHERE actor_id=${this.actor.actorId} AND context_id=${selection.contextId} AND revision=${selection.revision}`[0];

    if (exists === undefined) throw new KinuError('missing', 'context revision does not exist');
    const head = this.sql<{ revision: number }>`SELECT MAX(revision) AS revision FROM context_revisions WHERE actor_id=${this.actor.actorId} AND context_id=${selection.contextId}`[0];

    const rows = head?.revision === selection.revision
      ? this.sql<MemberRow>`SELECT entry_id,position,message_id,through_sequence FROM context_memberships WHERE actor_id=${this.actor.actorId} AND context_id=${selection.contextId} AND to_revision IS NULL ORDER BY position`
      : this.sql<MemberRow>`SELECT entry_id,position,message_id,through_sequence FROM context_memberships WHERE actor_id=${this.actor.actorId} AND context_id=${selection.contextId} AND from_revision<=${selection.revision} AND (to_revision IS NULL OR to_revision>${selection.revision}) ORDER BY position`;

    return rows.map(row => ({ entryId: row.entry_id, position: row.position, messageId: row.message_id, sequence: row.through_sequence }));
  }

  /** The mutation callback publishes message updates under the same transaction as their selected cutoffs. */
  commit(expected: ContextSelection, cause: string, turnId: string | null,
    mutate: (current: readonly ContextEntry[]) => readonly ContextEntry[], assertEpoch: () => void, proposal?: { readonly id: string; readonly author: string }): ContextSelection {
    return this.atomic(() => {
      this.actor.assertCurrent();
      assertEpoch();
      const selected = this.selected();

      if (selected?.contextId !== expected.contextId || selected.revision !== expected.revision) throw new KinuError('denied', 'context changed during preparation');
      const current = this.entries(expected);
      const next = mutate(current);
      const ids = new Set<string>();
      const prior = new Map(current.map(entry => [entry.entryId, entry]));

      for (const [position, entry] of next.entries()) {
        if (entry.position !== position || ids.has(entry.entryId)) throw new KinuError('bad_input', 'context entries must have unique identities and dense positions');

        if (prior.get(entry.entryId)?.messageId !== entry.messageId) {
          const message = this.sql<{ origin: string }>`SELECT origin FROM session_messages WHERE actor_id=${this.actor.actorId} AND message_id=${entry.messageId}`[0];

          if (message === undefined || message.origin === 'render') throw new KinuError('denied', 'working context requires an actor-owned semantic message');
        }

        ids.add(entry.entryId);
      }

      const retained = new Set<string>();

      for (const entry of next) {
        const old = prior.get(entry.entryId);

        if (old !== undefined && old.position === entry.position && old.messageId === entry.messageId && old.sequence === entry.sequence) retained.add(entry.entryId);
      }

      // An authored edit is recorded even when it changes nothing: an explicitly
      // empty history is a statement, not an unborn context.
      if (proposal === undefined && cause !== 'edit' && retained.size === current.length && current.length === next.length) return expected;
      const revision = expected.revision + 1;
      const actorId = this.actor.actorId;
      void this.sql`INSERT INTO context_revisions(actor_id,context_id,revision,author,cause,turn_id,proposal_id,recorded_at)
        VALUES(${actorId},${expected.contextId},${revision},${proposal?.author ?? actorId},${cause},${turnId},${proposal?.id ?? null},${Date.now()})`;

      // Release all changed live positions before inserting replacements: swaps cannot collide.
      for (const entry of current) if (!retained.has(entry.entryId)) {
        void this.sql`UPDATE context_memberships SET to_revision=${revision}
          WHERE actor_id=${actorId} AND context_id=${expected.contextId} AND entry_id=${entry.entryId} AND to_revision IS NULL`;
      }

      for (const entry of next) if (!retained.has(entry.entryId)) {
        void this.sql`INSERT INTO context_memberships(actor_id,context_id,entry_id,from_revision,position,message_id,through_sequence)
          VALUES(${actorId},${expected.contextId},${entry.entryId},${revision},${entry.position},${entry.messageId},${entry.sequence})`;
      }

      return { contextId: expected.contextId, revision };
    });
  }

  /** A new context at revision 0: the source's live entries when given, empty otherwise. */
  fork(source: ContextSelection | null, contextId = crypto.randomUUID()): ContextSelection {
    this.actor.assertCurrent();

    return this.atomic(() => {
      const actorId = this.actor.actorId;

      if (source !== null) {
        const exists = this.sql<{ revision: number }>`SELECT revision FROM context_revisions
          WHERE actor_id=${actorId} AND context_id=${source.contextId} AND revision=${source.revision}`[0];

        if (exists === undefined) throw new KinuError('missing', 'fork source revision does not exist');
      }

      void this.sql`INSERT INTO actor_contexts(actor_id,context_id,fork_context_id,fork_revision) VALUES(${actorId},${contextId},${source?.contextId ?? null},${source?.revision ?? null})`;
      void this.sql`INSERT INTO context_revisions(actor_id,context_id,revision,author,cause,recorded_at) VALUES(${actorId},${contextId},0,${actorId},'fork',${Date.now()})`;

      for (const entry of source === null ? [] : this.entries(source)) void this.sql`INSERT INTO context_memberships(actor_id,context_id,entry_id,from_revision,position,message_id,through_sequence)
        VALUES(${actorId},${contextId},${entry.entryId},0,${entry.position},${entry.messageId},${entry.sequence})`;

      return { contextId, revision: 0 };
    });
  }

  select(expected: ContextSelection, target: ContextSelection, assertIdle: () => void): void {
    this.atomic(() => {
      this.actor.assertCurrent();
      assertIdle();
      const selected = this.selected();

      if (selected?.contextId !== expected.contextId || selected.revision !== expected.revision) throw new KinuError('denied', 'context selection changed');

      const head = this.sql<{ revision: number | null }>`SELECT MAX(revision) AS revision FROM context_revisions
        WHERE actor_id=${this.actor.actorId} AND context_id=${target.contextId}`[0]?.revision;

      if (head !== target.revision) throw new KinuError('denied', 'branch selection must name its current revision');
      void this.sql`UPDATE actor_context_selection SET context_id=${target.contextId} WHERE actor_id=${this.actor.actorId}`;
    });
  }
}
