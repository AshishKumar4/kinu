import type { ModelMessage } from 'ai';
import { Effect } from 'effect';
import * as v from 'valibot';
import type { ActorHandle } from '../identity/actor-handle';
import type { SqlExecutor } from '../types/primitives';
import { SessionMessages, type PreparedMessage, type MessageReference, type MessagePartReference, type MessageOrigin } from './messages';
import { SessionPayloads, type SessionFilePlane } from './payload';
import { SessionContext, type ContextSelection, type ContextEntry } from './context';
import { SessionProposals, type ContextProposal } from './proposals';
import { SessionRequests } from './requests';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import { diagnostics } from '../obs/log';
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

/** Null `turnId` or `events`: no run to file against, nothing written. */
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

/** `before`/`after`: the conversation messages around it. */
export interface CarriedRender {
  readonly message: ModelMessage;
  readonly before: ModelMessage | null;
  readonly after: ModelMessage | null;
}

/** `entries` index with `messages`, the conversation; `rendered` is runtime context. */
export interface MaterializedContext {
  readonly entries: readonly ContextEntry[];
  readonly messages: ModelMessage[];
  readonly rendered: readonly CarriedRender[];
}

/** The turn keeps the partition while this membership remains selected. */
export interface MaterializedHistory extends MaterializedContext {
  readonly selection: ContextSelection;
  readonly members: readonly ContextEntry[];
}

export class SessionHistory {
  readonly messages: SessionMessages;
  readonly context: SessionContext;
  readonly proposals: SessionProposals;
  readonly requests: SessionRequests;
  /** One SQL transaction; the caller fences it. */
  readonly atomic: <T>(write: () => T) => T;

  constructor(private readonly dependencies: SessionHistoryDependencies) {
    const { sql, actor, transactionSync, files } = dependencies;
    this.atomic = transactionSync;
    const payloads = new SessionPayloads(files);
    this.messages = new SessionMessages(sql, actor, payloads);
    this.context = new SessionContext(sql, actor, transactionSync, this.messages);
    this.proposals = new SessionProposals(sql, actor, this.context, transactionSync);
    this.requests = new SessionRequests(sql, actor, this.messages, this.context);
  }

  /** Seals orphaned open messages (claim settled or epoch superseded); live streams are never touched. */
  async sealAbandoned(): Promise<void> {
    this.dependencies.actor.assertCurrent();
    const actorId = this.dependencies.actor.actorId;

    const abandoned = () => this.dependencies.sql<{ message_id: string; origin: string }>`SELECT m.message_id,m.origin FROM session_messages m
      JOIN actor_requests r ON r.actor_id=m.actor_id AND r.request_id=m.request_id
      LEFT JOIN actor_turn_claims c ON c.actor_id=r.actor_id AND c.turn_id=r.turn_id
      WHERE m.actor_id=${actorId} AND m.sealed_at IS NULL AND (c.turn_id IS NULL OR c.outcome IS NOT NULL OR c.epoch!=r.epoch) ORDER BY m.rowid`;

    for (const row of abandoned()) {
      const parts = await this.messages.openParts(row.message_id);

      if (parts === null) continue;
      const content = await this.messages.prepareContent(parts);
      const selected = this.context.selected() ?? this.context.initialize();
      this.dependencies.transactionSync(() => {
        if (!abandoned().some(candidate => candidate.message_id === row.message_id)) return;
        this.context.commit(selected, { cause: 'output', turnId: null, assertEpoch: () => Effect.sync(() => this.dependencies.actor.assertCurrent()), mutate: entries => {
          this.messages.seal(row.message_id, content);

          if (row.origin !== 'output' || entries.some(entry => entry.messageId === row.message_id)) return entries;

          return [...entries, { messageId: row.message_id, entryId: row.message_id, position: entries.length }];
        } });
      });
    }
  }

  /** A text-only cut step is sealed empty and leaves the context, so the model writes it again whole (Chat loop C1). */
  async retract(outputs: readonly string[], assertOwner: () => void): Promise<void> {
    const cut = new Set(outputs);
    const empty = await this.messages.prepareContent([]);
    const selected = this.context.selected() ?? this.context.initialize();

    this.context.commit(selected, { cause: 'edit', turnId: null, assertEpoch: () => Effect.sync(assertOwner), mutate: (entries) => {
      for (const id of outputs) this.messages.seal(id, empty);

      return entries.filter((entry) => !cut.has(entry.messageId)).map((entry, position) => ({ ...entry, position }));
    } });
  }

  /** The outputs a run left open: its cut step's. A claim's {@link sealAbandoned} seals them, so they are named before it. */
  openOutputs(runId: string): readonly string[] {
    this.dependencies.actor.assertCurrent();

    return this.dependencies.sql<{ message_id: string }>`SELECT m.message_id FROM session_messages m
      JOIN actor_requests r ON r.actor_id=m.actor_id AND r.request_id=m.request_id
      WHERE m.actor_id=${this.dependencies.actor.actorId} AND r.run_id=${runId} AND m.origin='output' AND m.sealed_at IS NULL
      ORDER BY m.rowid`.map((row) => row.message_id);
  }

  /** What a step cut mid-stream had streamed, read from the stream buffer or the content a seal gave it: `tools` once it
   *  called one, else `text`; null when it streamed neither. */
  async cutStep(outputs: readonly string[]): Promise<'text' | 'tools' | null> {
    const parts = [...(await this.messages.materializePartsOf(outputs)).values()].flat();

    if (parts.some((part) => part.kind === 'tool-call')) return 'tools';

    return parts.some((part) => (part.kind === 'text' || part.kind === 'reasoning') && v.parse(v.string(), part.value.text) !== '') ? 'text' : null;
  }

  transcript(sessionId: string): SessionTranscript {
    return new SessionTranscript({ sql: this.dependencies.sql, actor: this.dependencies.actor, sessionId,
      messages: this.messages, payloads: this.messages.payloads,
      atomic: this.dependencies.transactionSync, selection: () => this.context.selected() });
  }

  clearConversation(sessionId: string, assertIdle: () => Effect.Effect<void, KinuError>): ContextSelection {
    return this.dependencies.transactionSync(() => settleSync(Effect.gen({ self: this }, function* () {
      this.dependencies.actor.assertCurrent();
      yield* assertIdle();
      const selected = this.context.selected() ?? this.context.initialize();

      for (const proposal of this.proposals.pending(selected.contextId)) this.proposals.close(proposal.proposal_id, 'history_rewritten');
      const cleared = this.context.commit(selected, { cause: 'edit', turnId: null, mutate: () => [], assertEpoch: assertIdle });
      this.transcript(sessionId).clear();

      return cleared;
    })));
  }

  /** Continue from before `entryId`: the context of the nearest earlier entry that recorded one branches, and
   *  `entryId` and everything after it is deleted. */
  revertTo(sessionId: string, entryId: string, assertIdle: () => Effect.Effect<void, KinuError>): ContextSelection {
    return this.dependencies.transactionSync(() => settleSync(Effect.gen({ self: this }, function* () {
      this.dependencies.actor.assertCurrent();
      yield* assertIdle();
      const transcript = this.transcript(sessionId);
      const entry = transcript.read(entryId);

      if (entry === null) throw new KinuError('missing', 'conversation entry does not exist');
      const base = transcript.contextAt(entry.position - 1);
      const selected = this.context.selected() ?? this.context.initialize();

      for (const proposal of this.proposals.pending(selected.contextId)) this.proposals.close(proposal.proposal_id, 'history_rewritten');
      const target = this.context.fork(base);
      this.context.select(selected, target, assertIdle);
      transcript.truncate(entry.position);
      // The only deletion short of a clear; recorded so it is distinguishable from lost rows.
      diagnostics.event('session.transcript_rewound', { session: sessionId, from: entryId, position: entry.position });

      return target;
    })));
  }

  async materialize(kept: MaterializedHistory | null = null): Promise<MaterializedHistory> {
    const { selection, entries: members } = this.context.snapshot();

    if (kept?.members === members && kept.selection.contextId === selection.contextId && kept.selection.revision === selection.revision) return kept;

    return { selection, members, ...await this.partition(members) };
  }

  /** Revisions are durable: a past one reads back as it was. */
  async materializeAt(selection: ContextSelection): Promise<MaterializedContext> {
    return this.partition(this.context.entries(selection));
  }

  private async partition(members: readonly ContextEntry[]): Promise<MaterializedContext> {
    const all = await this.messages.materializeAll(members);
    const entries: ContextEntry[] = [];
    const messages: ModelMessage[] = [];
    const renders: { readonly message: ModelMessage; readonly at: number }[] = [];

    for (const [index, member] of members.entries()) {
      const message = all[index];

      if (message === undefined) throw new KinuError('io', 'a context member did not materialize');

      if (this.messages.originOf(member) === 'render') renders.push({ message, at: messages.length });
      else { entries.push(member); messages.push(message); }
    }

    return { entries, messages, rendered: renders.map(({ message, at }) => ({ message, before: messages[at] ?? null, after: messages[at - 1] ?? null })) };
  }

  /** The render row its request names too. */
  async recordRender(message: ModelMessage, at: { readonly before: string | null; readonly replaces: boolean }, turnId: string, assertOwner: () => void): Promise<void> {
    const prepared = await this.messages.prepareRender(message);

    this.dependencies.transactionSync(() => {
      assertOwner();
      this.messages.insertRender(prepared);
      this.context.addRender({ messageId: prepared.id }, at, { turnId, assertEpoch: () => Effect.sync(assertOwner) });
    });
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

      return { result: { selection: this.context.commit(selected, { cause: 'edit', turnId: options.turnId, mutate: () => entries, assertEpoch: () => Effect.sync(options.assertOwner) }), proposalId: null }, publication: null };
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

  async stepBase(assertOwner: () => void, turnId: string | null = null, events: ContextEventRecorder | null = null, kept: MaterializedHistory | null = null): Promise<MaterializedHistory & { readonly changed: boolean }> {
    assertOwner();
    // Tools, steers and authored edits can advance the head between requests. Keep the partition, not a stale selection.
    const current = await this.materialize(kept);
    const pending = this.proposals.pending(current.selection.contextId).at(-1);

    if (pending === undefined) return { ...current, changed: false };
    let candidate: readonly ContextEntry[];

    try { candidate = this.proposals.preview(pending.proposal_id); } catch (cause) {
      if (!(cause instanceof KinuError) || cause.code !== 'denied') throw cause;
      assertOwner();
      this.proposals.close(pending.proposal_id, 'history_rewritten');

      return { ...current, changed: false };
    }

    const staged = await this.partition(candidate);
    const before = toolPairingGaps(current.messages);
    const after = toolPairingGaps(staged.messages);
    const refusal = before.calls.size > 0 || after.calls.size > 0 || after.results.size > 0 ? 'unpaired_tool_call' : null;

    const committed = this.dependencies.transactionSync(() => {
      const applied = this.proposals.apply(pending.proposal_id, () => Effect.sync(assertOwner), entries => {
        if (entries.length !== candidate.length || entries.some((entry, index) => entry.entryId !== candidate[index]?.entryId || entry.messageId !== candidate[index]?.messageId)) return 'history_rewritten';

        return refusal;
      }, turnId);

      return { applied,
        publication: applied === null ? null : this.editEvent({ proposalId: pending.proposal_id, selection: applied, status: 'activated', turnId, events }) };
    });

    committed.publication?.publish();

    if (committed.applied !== null) return { ...staged, selection: committed.applied, members: candidate, changed: true };
    const settled = await this.materialize(current);

    return { ...settled, changed: false };
  }

  private editEvent(edit: ContextEditAudit): { publish(): void } | null {
    const { proposalId, selection, status, turnId, events } = edit;

    if (events === null || turnId === null) return null;
    const claim = this.dependencies.sql<{ run_id: string; outcome: string | null }>`SELECT run_id,outcome FROM actor_turn_claims WHERE actor_id=${this.dependencies.actor.actorId} AND turn_id=${turnId}`[0];

    if (claim === undefined || claim.outcome !== null) return null;
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
  async outputForTurn(turnId: string): Promise<TurnOutput> {
    this.dependencies.actor.assertCurrent();

    // CROSS JOIN keeps this turn's requests outer; the other order walked every message (190 ms at 184K rows).
    const rows = this.dependencies.sql<{ message_id: string; origin: string; epoch: number; step: number; output_slot: number }>`SELECT m.message_id,m.origin,r.epoch,COALESCE(r.step_index,m.output_slot/3) AS step,m.output_slot
      FROM actor_requests r CROSS JOIN session_messages m ON m.actor_id=r.actor_id AND m.request_id=r.request_id
      WHERE r.actor_id=${this.dependencies.actor.actorId} AND r.turn_id=${turnId} AND m.origin IN ('output','render')
      ORDER BY r.epoch,step,m.output_slot`;

    const parts: (MessagePartReference & { epoch: number; step: number; order: number })[] = [];

    for (const row of rows) {
      for (const part of await this.messages.materializeParts({ messageId: row.message_id })) parts.push({ messageId: row.message_id, partNo: part.partNo, epoch: row.epoch, step: row.step, order: part.streamOrder });
    }

    parts.sort((a, b) => a.epoch - b.epoch || a.step - b.step || a.order - b.order);

    return { messages: rows.filter(row => row.origin === 'output').map(row => ({ messageId: row.message_id })), parts: parts.map(({ messageId, partNo }) => ({ messageId, partNo })) };
  }

  admittedInput(ingressId: string): MessageReference | null {
    this.dependencies.actor.assertCurrent();
    const row = this.dependencies.sql<{ message_id: string }>`SELECT message_id FROM session_messages WHERE actor_id=${this.dependencies.actor.actorId} AND ingress_id=${ingressId}`[0];

    return row === undefined ? null : { messageId: row.message_id };
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
        this.messages.insert(prepared, 'input', { ingressId: reference.messageId });
      }

      const selected = this.activateInput(reference, input.turnId, assertOwner);
      input.publish?.(selected);
    });
  }
  activateInput(reference: MessageReference, turnId: string, assertOwner: () => void): ContextSelection {
    return this.context.commit(null, { cause: 'input', turnId, assertEpoch: () => Effect.sync(assertOwner), mutate: entries => {
      const owned = this.dependencies.sql<{ entry_id: string }>`SELECT entry_id FROM context_memberships WHERE actor_id=${this.dependencies.actor.actorId} AND message_id=${reference.messageId} LIMIT 1`[0];

      return owned === undefined ? [...entries, { ...reference, entryId: reference.messageId, position: entries.length }] : entries;
    } });
  }

  async append(input: {
    readonly id: string; readonly message: ModelMessage; readonly origin: MessageOrigin;
    readonly turnId: string | null; readonly ingressId?: string;
    readonly assertOwner: () => void;
  }): Promise<MessageReference> {
    const selected = this.context.selected() ?? this.context.initialize();
    const prepared = await this.messages.prepare(input.message, input.id);
    let reference: MessageReference | null = null;
    this.context.commit(selected, { cause: input.origin, turnId: input.turnId, assertEpoch: () => Effect.sync(input.assertOwner), mutate: entries => {
      reference = this.messages.insert(prepared, input.origin, input.ingressId === undefined ? {} : { ingressId: input.ingressId });

      return [...entries, { ...reference, entryId: input.id, position: entries.length }];
    } });

    if (reference === null) throw new KinuError('io', 'message publication did not return its identity');

    return reference;
  }

  assertClaimEpoch(turnId: string, epoch: number): void {
    this.dependencies.actor.assertCurrent();
    const claim = this.dependencies.sql<{ epoch: number }>`SELECT epoch FROM actor_turn_claims WHERE actor_id=${this.dependencies.actor.actorId} AND turn_id=${turnId}`[0];

    if (claim?.epoch !== epoch) throw new KinuError('denied', 'actor claim epoch is no longer current');
  }

  epochCurrent(turnId: string, epoch: number): boolean {
    this.dependencies.actor.assertCurrent();
    const actorId = this.dependencies.actor.actorId;
    const claim = this.dependencies.sql<{ epoch: number; outcome: string | null }>`SELECT epoch,outcome FROM actor_turn_claims WHERE actor_id=${actorId} AND turn_id=${turnId}`[0];

    return claim?.epoch === epoch && claim.outcome === null;
  }

  assertEpoch(turnId: string, epoch: number): void {
    if (!this.epochCurrent(turnId, epoch)) throw new KinuError('denied', 'actor execution epoch is no longer current');
  }
}
