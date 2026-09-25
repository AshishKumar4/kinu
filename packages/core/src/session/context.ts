import type { ActorHandle } from '../identity/actor-handle';
import type { SqlExecutor } from '../types/primitives';
import { KinuError } from '../obs/error';
import type { MessageReference, SessionMessageReader } from './messages';

export interface ContextSelection { readonly contextId: string; readonly revision: number }

export interface ContextEntry extends MessageReference { readonly entryId: string; readonly position: number }

interface MemberRow { entry_id: string; position: number; message_id: string }

/** `recordUnchanged`: an authored edit is a statement even when it moves nothing. */
interface RevisionOrigin {
  readonly author: string; readonly cause: string; readonly turnId: string | null; readonly proposalId: string | null;
  readonly recordUnchanged: boolean;
}

export interface ContextCommitRequest {
  /** What the revision is recorded as: `input`, `output`, `edit`, `context_transform`. */
  readonly cause: string;
  readonly turnId: string | null;
  /** Returns the membership the revision publishes; runs inside the transaction. */
  readonly mutate: (current: readonly ContextEntry[]) => readonly ContextEntry[];
  /** Throws when the turn that prepared this change no longer holds the actor. */
  readonly assertEpoch: () => void;
  /** The staged proposal this change applies: it authors the revision and is recorded on it. */
  readonly proposal?: { readonly id: string; readonly author: string };
}

/** Interval membership is both the current selection and its historical record. */
export class SessionContext {
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

  entries(selection: ContextSelection): ContextEntry[] {
    this.actor.assertCurrent();
    const exists = this.sql<{ revision: number }>`SELECT revision FROM context_revisions WHERE actor_id=${this.actor.actorId} AND context_id=${selection.contextId} AND revision=${selection.revision}`[0];

    if (exists === undefined) throw new KinuError('missing', 'context revision does not exist');

    const rows = this.head(selection.contextId) === selection.revision
      ? this.sql<MemberRow>`SELECT entry_id,position,message_id FROM context_memberships WHERE actor_id=${this.actor.actorId} AND context_id=${selection.contextId} AND to_revision IS NULL ORDER BY position`
      : this.sql<MemberRow>`SELECT entry_id,position,message_id FROM context_memberships WHERE actor_id=${this.actor.actorId} AND context_id=${selection.contextId} AND from_revision<=${selection.revision} AND (to_revision IS NULL OR to_revision>${selection.revision}) ORDER BY position`;

    return rows.map(row => ({ entryId: row.entry_id, position: row.position, messageId: row.message_id }));
  }

  conversationOf(members: readonly ContextEntry[]): ContextEntry[] {
    return members.filter(member => this.messages.originOf(member) !== 'render');
  }

  /** The mutation callback publishes message rows under the same transaction as their membership. */
  commit(expected: ContextSelection, request: ContextCommitRequest): ContextSelection {
    const { cause, turnId, mutate, assertEpoch, proposal } = request;

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

      // An empty authored edit is still recorded: an explicitly empty history is a statement.
      return this.revise(expected, current, next, { author: proposal?.author ?? this.actor.actorId, cause, turnId, proposalId: proposal?.id ?? null,
        recordUnchanged: proposal !== undefined || cause === 'edit' });
    });
  }

  /** Before entry `before`, else at the end; one revision, less the renders it `replaces`. */
  addRender(
    reference: MessageReference, at: { readonly before: string | null; readonly replaces: boolean },
    request: { readonly turnId: string | null; readonly assertEpoch: () => void },
  ): ContextSelection {
    return this.atomic(() => {
      this.actor.assertCurrent();
      request.assertEpoch();
      const selected = this.selected() ?? this.initialize();
      const current = this.entries(selected);
      const kept = at.replaces ? this.conversationOf(current) : current;
      const anchor = kept.findIndex(entry => entry.entryId === at.before);
      const index = anchor < 0 ? kept.length : anchor;
      const added = { entryId: crypto.randomUUID(), messageId: reference.messageId, position: index };
      const next = [...kept.slice(0, index), added, ...kept.slice(index)].map((entry, position) => ({ ...entry, position }));

      return this.revise(selected, current, next, { author: this.actor.actorId, cause: 'render', turnId: request.turnId, proposalId: null, recordUnchanged: false });
    });
  }

  /** The next revision of an unselected context, opened on first use: an entry is its position, so a kept message writes nothing. */
  record(contextId: string, messages: readonly MessageReference[]): ContextSelection {
    return this.atomic(() => {
      this.actor.assertCurrent();
      const head = this.head(contextId);
      const expected = head === null ? this.fork(null, contextId) : { contextId, revision: head };
      const next = messages.map((message, position) => ({ messageId: message.messageId, entryId: String(position), position }));

      return this.revise(expected, this.entries(expected), next, { author: this.actor.actorId, cause: 'render', turnId: null, proposalId: null, recordUnchanged: false });
    });
  }

  private revise(expected: ContextSelection, current: readonly ContextEntry[], next: readonly ContextEntry[], origin: RevisionOrigin): ContextSelection {
    const prior = new Map(current.map(entry => [entry.entryId, entry]));
    const retained = new Set<string>();

    for (const entry of next) {
      const old = prior.get(entry.entryId);

      if (old !== undefined && old.position === entry.position && old.messageId === entry.messageId) retained.add(entry.entryId);
    }

    if (!origin.recordUnchanged && retained.size === current.length && current.length === next.length) return expected;
    const revision = expected.revision + 1;
    const actorId = this.actor.actorId;
    void this.sql`INSERT INTO context_revisions(actor_id,context_id,revision,author,cause,turn_id,proposal_id,recorded_at)
      VALUES(${actorId},${expected.contextId},${revision},${origin.author},${origin.cause},${origin.turnId},${origin.proposalId},${Date.now()})`;

    // Release all changed live positions before inserting replacements: swaps cannot collide.
    for (const entry of current) if (!retained.has(entry.entryId)) {
      void this.sql`UPDATE context_memberships SET to_revision=${revision}
        WHERE actor_id=${actorId} AND context_id=${expected.contextId} AND entry_id=${entry.entryId} AND to_revision IS NULL`;
    }

    for (const entry of next) if (!retained.has(entry.entryId)) {
      void this.sql`INSERT INTO context_memberships(actor_id,context_id,entry_id,from_revision,position,message_id)
        VALUES(${actorId},${expected.contextId},${entry.entryId},${revision},${entry.position},${entry.messageId})`;
    }

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

      void this.sql`INSERT INTO actor_contexts(actor_id,context_id,fork_context_id,fork_revision) VALUES(${actorId},${contextId},${source?.contextId ?? null},${source?.revision ?? null})`;
      void this.sql`INSERT INTO context_revisions(actor_id,context_id,revision,author,cause,recorded_at) VALUES(${actorId},${contextId},0,${actorId},'fork',${Date.now()})`;

      for (const entry of source === null ? [] : this.entries(source)) void this.sql`INSERT INTO context_memberships(actor_id,context_id,entry_id,from_revision,position,message_id)
        VALUES(${actorId},${contextId},${entry.entryId},0,${entry.position},${entry.messageId})`;

      return { contextId, revision: 0 };
    });
  }

  select(expected: ContextSelection, target: ContextSelection, assertIdle: () => void): void {
    this.atomic(() => {
      this.actor.assertCurrent();
      assertIdle();
      const selected = this.selected();

      if (selected?.contextId !== expected.contextId || selected.revision !== expected.revision) throw new KinuError('denied', 'context selection changed');

      if (this.head(target.contextId) !== target.revision) throw new KinuError('denied', 'branch selection must name its current revision');
      void this.sql`UPDATE actor_context_selection SET context_id=${target.contextId} WHERE actor_id=${this.actor.actorId}`;
    });
  }
}
