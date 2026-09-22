import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import type { ActorHandle } from '../identity/actor-handle';
import type { SqlExecutor } from '../types/primitives';
import { SessionMessages, type PreparedMessage, type MessageReference, type MessagePartReference, type MessageOrigin } from './messages';
import { SessionPayloads, type SessionFilePlane } from './payload';
import { SessionContext, type ContextSelection, type ContextEntry } from './context';
import { SessionProposals, type ContextProposal } from './proposals';
import { SessionRequests } from './requests';
import { KinuError } from '../obs/error';
import type { JsonObject } from '../utils/json';
import { SessionTranscript } from './transcript';
import { toolPairingGaps } from './tool-pairing';
import type { ContextEventRecorder } from '../types/context-plane';

export interface SessionHistoryDependencies {
  readonly actor: ActorHandle;
  readonly sql: SqlExecutor;
  readonly transactionSync: <T>(write: () => T) => T;
  readonly files: () => Promise<SessionFilePlane>;
}

/** Actor-bound context operations. Preparation may await VFS; publication is one fenced SQL transaction. */
export interface TurnOutput {
  readonly messages: readonly MessageReference[];
  readonly parts: readonly MessagePartReference[];
}

/** One `context_edit` run event waiting to be written: which proposal moved the
 *  context where, and the recorder it belongs on. A null `turnId` or `events`
 *  means there is no run to file it against, so nothing is written. */
interface ContextEditAudit {
  readonly proposalId: string;
  readonly selection: ContextSelection;
  readonly status: 'staged' | 'activated';
  readonly turnId: string | null;
  readonly events: ContextEventRecorder | null;
}

/** An input message being landed against the cutoff its preparation reserved. */
interface LandedInput {
  /** Null when the input was already admitted by an earlier attempt. */
  readonly prepared: PreparedMessage | null;
  readonly reference: MessageReference;
  readonly turnId: string;
  readonly assertOwner: () => void;
  readonly publish?: (selection: ContextSelection) => void;
}

export class SessionHistory {
  readonly messages: SessionMessages;
  readonly context: SessionContext;
  readonly proposals: SessionProposals;
  readonly requests: SessionRequests;

  constructor(private readonly dependencies: SessionHistoryDependencies) {
    const { sql, actor, transactionSync, files } = dependencies;
    const payloads = new SessionPayloads(files);
    this.messages = new SessionMessages(sql, actor, payloads);
    this.context = new SessionContext(sql, actor, transactionSync);
    this.proposals = new SessionProposals(sql, actor, this.context, transactionSync);
    this.requests = new SessionRequests(sql, actor, this.messages, payloads);
  }

  /** One fenced write to a message the working context already holds: a
   *  streamed delta extends the message and changes no membership, so it
   *  mints no context revision. The cutoff the context pins for that message
   *  moves once, when its step finishes. */
  extendOutput(turnId: string, epoch: number, write: () => MessageReference): MessageReference {
    return this.dependencies.transactionSync(() => {
      this.assertEpoch(turnId, epoch);

      return write();
    });
  }

  transcript(sessionId: string): SessionTranscript {
    return new SessionTranscript(this.dependencies.sql, this.dependencies.actor, sessionId, this.messages, this.messages.payloads, this.dependencies.transactionSync, () => this.context.selected());
  }

  clearConversation(sessionId: string, assertIdle: () => void): ContextSelection {
    return this.dependencies.transactionSync(() => {
      this.dependencies.actor.assertCurrent();
      assertIdle();
      const selected = this.context.selected() ?? this.context.initialize();

      for (const proposal of this.proposals.pending(selected.contextId)) this.proposals.close(proposal.proposal_id, 'history_rewritten');
      const cleared = this.context.commit(selected, 'edit', null, () => [], assertIdle);
      this.transcript(sessionId).clear();

      return cleared;
    });
  }

  /** Continue from before `entryId`: the context its nearest recorded ancestor held becomes a new branch, and later entries leave the head's ancestry. */
  revertTo(sessionId: string, entryId: string, assertIdle: () => void): ContextSelection {
    return this.dependencies.transactionSync(() => {
      this.dependencies.actor.assertCurrent();
      assertIdle();
      const transcript = this.transcript(sessionId);
      const entry = transcript.read(entryId);

      if (entry === null) throw new KinuError('missing', 'conversation entry does not exist');
      let base: ContextSelection | null = null;

      for (const ancestor of [...transcript.ancestry(entry.parentId)].reverse()) {
        if (ancestor.context) { base = ancestor.context; break; }
      }

      const selected = this.context.selected() ?? this.context.initialize();

      for (const proposal of this.proposals.pending(selected.contextId)) this.proposals.close(proposal.proposal_id, 'history_rewritten');
      const target = this.context.fork(base);
      this.context.select(selected, target, assertIdle);
      transcript.setHead(entry.parentId);

      return target;
    });
  }

  async materialize(): Promise<{ selection: ContextSelection; entries: readonly ContextEntry[]; messages: ModelMessage[] }> {
    const selection = this.context.selected() ?? this.context.initialize();
    const entries = this.context.entries(selection);
    const messages: ModelMessage[] = [];

    for (const reference of entries) messages.push(await this.messages.materialize(reference));

    return { selection, entries, messages };
  }

  stagePrepared(proposal: Omit<ContextProposal, 'base'> & { readonly base: ContextSelection | null }, messages: readonly PreparedMessage[], assertOwner: () => void, events: ContextEventRecorder | null = null): void {
    const publication = this.dependencies.transactionSync(() => {
      this.dependencies.actor.assertCurrent();
      assertOwner();
      const base = proposal.base ?? this.context.initialize();

      for (const message of messages) this.messages.insert(message, proposal.cause === 'context_transform' ? 'context_transform' : 'edit');
      this.proposals.stage({ ...proposal, base });

      return this.editEvent({ proposalId: proposal.id, selection: base, status: 'staged', turnId: proposal.turnId, events });
    });

    publication?.publish();
  }

  async replaceHistory(messages: readonly ModelMessage[], options: { readonly author: string; readonly via: string; readonly turnId: string | null; readonly stage: boolean; readonly assertOwner: () => void; readonly events?: ContextEventRecorder | null }): Promise<{ readonly selection: ContextSelection; readonly proposalId: string | null }> {
    options.assertOwner();
    const selected = this.context.selected() ?? this.context.initialize();
    const pending = this.proposals.pending(selected.contextId).at(-1)?.proposal_id ?? null;
    const prepared: PreparedMessage[] = [];
    const calls = new Map<string, { messageId: string; part: number }>();

    for (const message of messages) {
      const id = crypto.randomUUID();

      if (message.role === 'assistant' && !v.is(v.string(), message.content)) for (const [part, value] of message.content.entries()) if (value.type === 'tool-call') calls.set(value.toolCallId, { messageId: id, part });
      prepared.push(await this.messages.prepare(message, id, calls));
    }

    const committed = this.dependencies.transactionSync(() => {
      options.assertOwner();
      const base = this.context.entries(selected);
      const entries = prepared.map((message, position) => ({ ...this.messages.insert(message, 'edit'), entryId: message.id, position }));

      if (options.stage) {
        // A replacement staged inside a turn replaces the history before that
        // turn; the turn's own exchange stays as the tail the edit lands under.
        const turnEntries = options.turnId === null ? new Set<string>() : this.entriesOfTurn(selected.contextId, options.turnId);
        const proposalId = crypto.randomUUID();
        this.proposals.stage({ id: proposalId, base: selected, author: options.author, via: options.via, cause: 'edit', turnId: options.turnId, expectedPending: pending,
          changes: [...base.filter(entry => !turnEntries.has(entry.entryId)).map(entry => ({ entryId: entry.entryId, expected: entry, replacement: null })), ...entries.map(entry => ({ entryId: entry.entryId, expected: null, replacement: entry }))] });

        return { result: { selection: selected, proposalId },
          publication: this.editEvent({ proposalId, selection: selected, status: 'staged', turnId: options.turnId, events: options.events ?? null }) };
      }

      for (const proposal of this.proposals.pending(selected.contextId)) this.proposals.close(proposal.proposal_id, 'history_rewritten');

      return { result: { selection: this.context.commit(selected, 'edit', options.turnId, () => entries, options.assertOwner), proposalId: null }, publication: null };
    });

    committed.publication?.publish();

    return committed.result;
  }

  private entriesOfTurn(contextId: string, turnId: string): Set<string> {
    const actorId = this.dependencies.actor.actorId;

    return new Set(this.dependencies.sql<{ entry_id: string }>`SELECT m.entry_id FROM context_memberships m
      JOIN context_revisions r ON r.actor_id=m.actor_id AND r.context_id=m.context_id AND r.revision=m.from_revision
      WHERE m.actor_id=${actorId} AND m.context_id=${contextId} AND m.to_revision IS NULL AND r.turn_id=${turnId}`.map(row => row.entry_id));
  }

  async stepBase(assertOwner: () => void, turnId: string | null = null, events: ContextEventRecorder | null = null): Promise<{ readonly messages: ModelMessage[]; readonly changed: boolean }> {
    assertOwner();
    const current = await this.materialize();
    const pending = this.proposals.pending(current.selection.contextId).at(-1);

    if (pending === undefined) return { messages: current.messages, changed: false };
    let candidate: readonly ContextEntry[];

    try { candidate = this.proposals.preview(pending.proposal_id); } catch (cause) {
      if (!(cause instanceof KinuError) || cause.code !== 'denied') throw cause;
      assertOwner();
      this.proposals.close(pending.proposal_id, 'history_rewritten');

      return { messages: current.messages, changed: false };
    }

    const messages: ModelMessage[] = [];

    for (const entry of candidate) messages.push(await this.messages.materialize(entry));
    const before = toolPairingGaps(current.messages);
    const after = toolPairingGaps(messages);
    const refusal = before.calls.size > 0 || after.calls.size > 0 || after.results.size > 0 ? 'unpaired_tool_call' : null;

    const committed = this.dependencies.transactionSync(() => {
      const applied = this.proposals.apply(pending.proposal_id, assertOwner, entries => {
        if (entries.length !== candidate.length || entries.some((entry, index) => entry.entryId !== candidate[index]?.entryId || entry.messageId !== candidate[index]?.messageId || entry.sequence !== candidate[index]?.sequence)) return 'history_rewritten';

        return refusal;
      }, turnId);

      return { applied,
        publication: applied === null ? null : this.editEvent({ proposalId: pending.proposal_id, selection: applied, status: 'activated', turnId, events }) };
    });

    committed.publication?.publish();

    return { messages: committed.applied === null ? (await this.materialize()).messages : messages, changed: committed.applied !== null };
  }

  private editEvent(edit: ContextEditAudit): { publish(): void } | null {
    const { proposalId, selection, status, turnId, events } = edit;

    if (events === null || turnId === null) return null;
    const claim = this.dependencies.sql<{ run_id: string; status: string }>`SELECT run_id,status FROM actor_turn_claims WHERE actor_id=${this.dependencies.actor.actorId} AND turn_id=${turnId}`[0];

    if (claim?.status !== 'admitted') return null;
    const proposal = this.proposals.inspect(proposalId);

    if (proposal === null) throw new KinuError('missing', 'context proposal disappeared before its audit event');
    const via = proposal.metadata.via;

    if (via !== 'file' && via !== 'session' && via !== 'owner') return null;

    return events.emitDeferred(claim.run_id, { type: 'context_edit', contextId: selection.contextId, proposalId,
      revision: selection.revision, baseRevision: proposal.metadata.base_revision, author: proposal.metadata.author, via, status,
      messageCount: status === 'staged' ? proposal.entries.length : this.context.entries(selection).length,
      effectiveAt: 'step', turnId, stepIndex: null });
  }

  /** `messages` is the model-facing output; `parts` also carries render-only parts for the public transcript. */
  outputForTurn(turnId: string): TurnOutput {
    this.dependencies.actor.assertCurrent();

    const rows = this.dependencies.sql<{ message_id: string; origin: string; sequence: number; epoch: number; step: number; output_slot: number }>`SELECT m.message_id,m.origin,MAX(u.sequence) AS sequence,r.epoch,COALESCE(r.step_index,m.output_slot/3) AS step,m.output_slot
      FROM session_messages m JOIN actor_requests r ON r.actor_id=m.actor_id AND r.request_id=m.request_id
      JOIN message_updates u ON u.actor_id=m.actor_id AND u.message_id=m.message_id
      WHERE m.actor_id=${this.dependencies.actor.actorId} AND r.turn_id=${turnId} AND m.origin IN ('output','render')
      GROUP BY m.message_id,m.origin,r.epoch,r.step_index,m.output_slot ORDER BY r.epoch,step,m.output_slot`;

    const parts: (MessagePartReference & { epoch: number; step: number; order: number })[] = [];

    for (const row of rows) {
      const references = this.dependencies.sql<{ part_no: number; stream_order: number | null }>`SELECT part_no,stream_order FROM message_parts WHERE actor_id=${this.dependencies.actor.actorId} AND message_id=${row.message_id} ORDER BY part_no`;

      for (const part of references) parts.push({ messageId: row.message_id, partNo: part.part_no, throughSequence: row.sequence, epoch: row.epoch, step: row.step, order: part.stream_order ?? part.part_no });
    }

    parts.sort((a, b) => a.epoch - b.epoch || a.step - b.step || a.order - b.order);

    return { messages: rows.filter(row => row.origin === 'output').map(row => ({ messageId: row.message_id, sequence: row.sequence })), parts: parts.map(({ messageId, partNo, throughSequence }) => ({ messageId, partNo, throughSequence })) };
  }

  admittedInput(ingressId: string): MessageReference | null {
    this.dependencies.actor.assertCurrent();
    const row = this.dependencies.sql<{ message_id: string; sequence: number }>`SELECT m.message_id,MAX(u.sequence) AS sequence FROM session_messages m JOIN message_updates u ON u.actor_id=m.actor_id AND u.message_id=m.message_id WHERE m.actor_id=${this.dependencies.actor.actorId} AND m.ingress_id=${ingressId} GROUP BY m.message_id`[0];

    return row === undefined ? null : { messageId: row.message_id, sequence: row.sequence };
  }

  async admitInput(input: { readonly id: string; readonly message: ModelMessage; readonly turnId: string; readonly assertOwner: () => void }): Promise<MessageReference> {
    input.assertOwner();
    const existing = this.admittedInput(input.id);

    if (existing !== null) return existing;
    const prepared = await this.messages.prepare(input.message, input.id);

    return this.dependencies.transactionSync(() => {
      input.assertOwner();
      const admitted = this.admittedInput(input.id);

      if (admitted !== null) return admitted;

      return this.messages.insert(prepared, 'input', { ingressId: input.id });
    });
  }

  landInput(input: LandedInput): void {
    const { prepared, reference, assertOwner } = input;
    this.dependencies.transactionSync(() => {
      assertOwner();
      const existing = this.admittedInput(reference.messageId);

      if (existing === null) {
        if (prepared === null) throw new KinuError('missing', 'landed input was not prepared');
        const inserted = this.messages.insert(prepared, 'input', { ingressId: reference.messageId });

        if (inserted.sequence !== reference.sequence) throw new KinuError('io', 'landed input cutoff differs from preparation');
      } else if (existing.sequence !== reference.sequence) throw new KinuError('denied', 'landed input changed during preparation');
      this.activateInput(reference, input.turnId, assertOwner);
      const selected = this.context.selected();

      if (selected === null) throw new KinuError('missing', 'landed input has no context');
      input.publish?.(selected);
    });
  }
  activateInput(reference: MessageReference, turnId: string, assertOwner: () => void): void {
    this.dependencies.transactionSync(() => {
      this.dependencies.actor.assertCurrent();
      assertOwner();
      const owned = this.dependencies.sql<{ entry_id: string }>`SELECT entry_id FROM context_memberships WHERE actor_id=${this.dependencies.actor.actorId} AND message_id=${reference.messageId} LIMIT 1`[0];

      if (owned !== undefined) return;
      const selected = this.context.selected() ?? this.context.initialize();
      this.context.commit(selected, 'input', turnId, entries => [...entries, { ...reference, entryId: reference.messageId, position: entries.length }], assertOwner);
    });
  }

  async append(input: {
    readonly id: string; readonly message: ModelMessage; readonly origin: MessageOrigin;
    readonly turnId: string | null; readonly ingressId?: string;
    readonly assertOwner: () => void;
  }): Promise<MessageReference> {
    const selected = this.context.selected() ?? this.context.initialize();
    const prepared = await this.messages.prepare(input.message, input.id);
    let reference: MessageReference | null = null;
    this.context.commit(selected, input.origin, input.turnId, entries => {
      reference = this.messages.insert(prepared, input.origin, input.ingressId === undefined ? {} : { ingressId: input.ingressId });

      return [...entries, { ...reference, entryId: input.id, position: entries.length }];
    }, input.assertOwner);

    if (reference === null) throw new KinuError('io', 'message publication did not return its identity');

    return reference;
  }

  /** Publish one message and its transcript entry together, outside working
   *  context: search trajectories and other non-chat sessions. */
  async record(sessionId: string, input: { readonly id: string; readonly parentId: string | null; readonly message: ModelMessage; readonly origin: MessageOrigin; readonly metadata?: JsonObject }): Promise<MessageReference> {
    const prepared = await this.messages.prepare(input.message, input.id);
    const metadata = input.metadata === undefined ? null : await this.messages.payloads.prepare(input.metadata);
    const transcript = this.transcript(sessionId);

    return this.dependencies.transactionSync(() => {
      const reference = this.messages.insert(prepared, input.origin);
      transcript.record({ id: input.id, parentId: input.parentId, role: input.message.role, turnId: null, runId: null, metadata, context: null,
        parts: prepared.parts.map(part => ({ messageId: reference.messageId, partNo: part.number, throughSequence: reference.sequence })) });

      return reference;
    });
  }

  assertClaimEpoch(turnId: string, epoch: number): void {
    this.dependencies.actor.assertCurrent();
    const claim = this.dependencies.sql<{ epoch: number }>`SELECT epoch FROM actor_turn_claims WHERE actor_id=${this.dependencies.actor.actorId} AND turn_id=${turnId}`[0];

    if (claim?.epoch !== epoch) throw new KinuError('denied', 'actor claim epoch is no longer current');
  }

  assertEpoch(turnId: string, epoch: number): void {
    this.dependencies.actor.assertCurrent();
    const actorId = this.dependencies.actor.actorId;
    const claim = this.dependencies.sql<{ epoch: number; status: string }>`SELECT epoch,status FROM actor_turn_claims WHERE actor_id=${actorId} AND turn_id=${turnId}`[0];

    if (claim?.epoch !== epoch || claim.status !== 'admitted') throw new KinuError('denied', 'actor execution epoch is no longer current');
  }
}
