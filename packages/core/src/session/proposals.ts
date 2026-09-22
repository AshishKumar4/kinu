import * as v from 'valibot';
import type { ActorHandle } from '../identity/actor-handle';
import type { SqlExecutor } from '../types/primitives';
import { KinuError } from '../obs/error';
import { STAGED_CONTEXT_DEFERRALS, type ContextProposalClosure, type StagedContextDeferral } from '../types/context-plane';
import { SessionContext, type ContextEntry, type ContextSelection } from './context';
import type { MessageReference } from './messages';

export interface ContextChange {
  readonly entryId: string;
  readonly expected: MessageReference | null;
  readonly replacement: (MessageReference & { readonly position: number }) | null;
}

export interface ContextProposal {
  readonly id: string; readonly base: ContextSelection; readonly author: string; readonly via: string;
  readonly cause: string; readonly turnId: string | null; readonly buildIdentity?: string;
  readonly expectedPending?: string | null;
  readonly changes: readonly ContextChange[];
  readonly sources?: readonly { readonly outputMessageId: string; readonly outputPart: number; readonly entryId: string; readonly messageId: string; readonly part: number }[];
}

interface ProposalRow { context_id: string; base_revision: number; author: string; via: string; cause: string; turn_id: string | null; status: string }

interface ChangeRow { entry_id: string; expected_message_id: string | null; message_id: string | null; position: number | null }

export interface ContextProposalMetadata extends PendingContextProposal { readonly context_id: string; readonly status: string; readonly closed_reason: string | null; readonly build_identity: string | null }

export interface PendingContextProposal { readonly proposal_id: string; readonly base_revision: number; readonly author: string; readonly via: string; readonly cause: string; readonly turn_id: string | null; readonly deferred_reason: StagedContextDeferral | null; readonly recorded_at: number }

const DeferralSchema = v.picklist(STAGED_CONTEXT_DEFERRALS);

/** Sparse authored intent; committed intervals are the only selection history. */
export class SessionProposals {
  constructor(private readonly sql: SqlExecutor, private readonly actor: ActorHandle, private readonly context: SessionContext,
    private readonly atomic: <T>(operation: () => T) => T) {}

  pending(contextId: string): readonly PendingContextProposal[] {
    this.actor.assertCurrent();

    return this.sql<Omit<PendingContextProposal, 'deferred_reason'> & { readonly deferred_reason: string | null }>`SELECT proposal_id,base_revision,author,via,cause,turn_id,deferred_reason,recorded_at FROM context_proposals WHERE actor_id=${this.actor.actorId} AND context_id=${contextId} AND status='pending' ORDER BY rowid`
      .map(row => ({ ...row, deferred_reason: row.deferred_reason === null ? null : v.parse(DeferralSchema, row.deferred_reason) }));;
  }

  list(contextId: string): readonly ContextProposalMetadata[] {
    this.actor.assertCurrent();

    return this.sql`SELECT proposal_id,context_id,base_revision,author,via,cause,turn_id,deferred_reason,recorded_at,status,closed_reason,build_identity FROM context_proposals WHERE actor_id=${this.actor.actorId} AND context_id=${contextId} ORDER BY rowid DESC`;
  }

  inspect(id: string): { readonly metadata: ContextProposalMetadata; readonly entries: readonly ContextEntry[] } | null {
    this.actor.assertCurrent();
    const metadata = this.sql<ContextProposalMetadata>`SELECT proposal_id,context_id,base_revision,author,via,cause,turn_id,deferred_reason,recorded_at,status,closed_reason,build_identity FROM context_proposals WHERE actor_id=${this.actor.actorId} AND proposal_id=${id}`[0];

    return metadata === undefined ? null : { metadata, entries: this.compose(id, this.context.entries({ contextId: metadata.context_id, revision: metadata.base_revision })) };
  }

  stage(proposal: ContextProposal): void {
    this.atomic(() => {
      this.actor.assertCurrent();
      const selected = this.context.selected();

      if (selected?.contextId !== proposal.base.contextId) throw new KinuError('denied', 'proposal belongs to another context');
      const original = this.context.entries(proposal.base);
      const current = this.context.entries(selected);

      if (original.some((entry, position) => {
        const live = current[position];

        return live?.entryId !== entry.entryId || live.messageId !== entry.messageId;
      })) throw new KinuError('denied', 'proposal base was changed rather than extended');
      const pending = this.pending(selected.contextId);
      const previous = pending.at(-1)?.proposal_id ?? null;

      if (previous !== (proposal.expectedPending ?? null)) throw new KinuError('denied', 'a pending context edit changed during preparation');
      const base = new Map(original.map(entry => [entry.entryId, entry]));
      const actorId = this.actor.actorId;

      if (previous !== null) this.close(previous, 'superseded_by_edit');
      void this.sql`INSERT INTO context_proposals(actor_id,proposal_id,context_id,base_revision,author,via,cause,turn_id,build_identity,status,recorded_at)
        VALUES(${actorId},${proposal.id},${proposal.base.contextId},${proposal.base.revision},${proposal.author},${proposal.via},${proposal.cause},${proposal.turnId},${proposal.buildIdentity ?? null},'pending',${Date.now()})`;

      for (const change of proposal.changes) {
        this.validateExpected(base.get(change.entryId), change.expected);
        void this.sql`INSERT INTO context_proposal_entries(actor_id,proposal_id,entry_id,expected_message_id,message_id,position)
          VALUES(${actorId},${proposal.id},${change.entryId},${change.expected?.messageId ?? null},${change.replacement?.messageId ?? null},${change.replacement?.position ?? null})`;
      }

      for (const source of proposal.sources ?? []) {
        this.validateExpected(base.get(source.entryId), { messageId: source.messageId });

        if (!proposal.changes.some(change => change.replacement?.messageId === source.outputMessageId)) throw new KinuError('bad_input', 'transformation source names an output outside the proposal');
        void this.sql`INSERT INTO context_proposal_sources(actor_id,proposal_id,output_message_id,output_part_no,source_entry_id,source_message_id,source_part_no)
          VALUES(${actorId},${proposal.id},${source.outputMessageId},${source.outputPart},${source.entryId},${source.messageId},${source.part})`;
      }
    });
  }

  preview(id: string): readonly ContextEntry[] {
    const proposal = this.requirePending(id);
    const selected = this.context.selected();

    if (selected === null || selected.contextId !== proposal.context_id) throw new KinuError('denied', 'proposal belongs to another selected context');

    return this.compose(id, this.context.entries(selected));
  }

  previewAt(id: string, selection: ContextSelection): readonly ContextEntry[] {
    const proposal = this.inspect(id);

    if (proposal === null || proposal.metadata.context_id !== selection.contextId || proposal.metadata.base_revision > selection.revision) {
      throw new KinuError('missing', 'context proposal does not belong to this revision');
    }

    return this.compose(id, this.context.entries(selection));
  }

  apply(id: string, assertEpoch: () => void, validate: (entries: readonly ContextEntry[]) => StagedContextDeferral | null, turnId: string | null = null): ContextSelection | null {
    return this.atomic(() => {
      this.actor.assertCurrent();
      assertEpoch();
      const proposal = this.requirePending(id);
      const selected = this.context.selected();

      if (selected === null || selected.contextId !== proposal.context_id) throw new KinuError('denied', 'proposal belongs to another selected context');
      const next = this.compose(id, this.context.entries(selected));
      const refusal = validate(next);
      const actorId = this.actor.actorId;

      if (refusal !== null) {
        void this.sql`UPDATE context_proposals SET deferred_reason=${refusal},deferred_at=${Date.now()} WHERE actor_id=${actorId} AND proposal_id=${id}`;

        return null;
      }

      const committed = this.context.commit(selected, proposal.cause, turnId, () => next, assertEpoch, { id, author: proposal.author });
      void this.sql`UPDATE context_proposals SET status='applied',deferred_reason=NULL,deferred_at=NULL WHERE actor_id=${actorId} AND proposal_id=${id}`;

      return committed;
    });
  }

  close(id: string, reason: ContextProposalClosure): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE context_proposals SET status='closed',closed_reason=${reason}
      WHERE actor_id=${this.actor.actorId} AND proposal_id=${id} AND status='pending'`;
  }

  private requirePending(id: string): ProposalRow {
    this.actor.assertCurrent();
    const row = this.sql<ProposalRow>`SELECT context_id,base_revision,author,via,cause,turn_id,status FROM context_proposals WHERE actor_id=${this.actor.actorId} AND proposal_id=${id}`[0];

    if (row === undefined || row.status !== 'pending') throw new KinuError('denied', 'context proposal is not pending');

    return row;
  }

  private compose(id: string, current: readonly ContextEntry[]): ContextEntry[] {
    const changes = this.sql<ChangeRow>`SELECT entry_id,expected_message_id,message_id,position
      FROM context_proposal_entries WHERE actor_id=${this.actor.actorId} AND proposal_id=${id}`;

    const members = new Map(current.map(entry => [entry.entryId, entry]));

    for (const change of changes) {
      this.validateExpected(members.get(change.entry_id), change.expected_message_id === null ? null : { messageId: change.expected_message_id });
      members.delete(change.entry_id);
    }

    const ordered = [...members.values()];

    for (const change of changes.sort((a, b) => (a.position ?? -1) - (b.position ?? -1))) {
      if (change.message_id === null) continue;

      if (change.position === null) throw new KinuError('io', 'proposal replacement is incomplete');
      ordered.splice(change.position, 0, { entryId: change.entry_id, messageId: change.message_id, position: change.position });
    }

    return ordered.map((entry, position) => ({ ...entry, position }));
  }

  private validateExpected(actual: ContextEntry | undefined, expected: MessageReference | null): void {
    if (expected === null ? actual !== undefined : actual?.messageId !== expected.messageId) throw new KinuError('denied', 'context edit targets content that changed since its base');
  }
}
