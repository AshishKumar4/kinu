import { Effect } from 'effect';
import { settleSync, settle } from '../obs/effect';
import type { ModelMessage } from 'ai';
import type { ActorHandle } from '../identity/actor-handle';
import type { SqlExecutor } from '../types/primitives';
import type { JsonValue } from '../utils/json';
import { KinuError } from '../obs/error';
import type { ContextSelection, SessionContext } from './context';
import type { SessionMessages, MessageReference, PreparedMessage } from './messages';
import { storedPayload, type SessionPayload } from './payload';

/** The unselected context whose revisions are this actor's request lists. */
const REQUEST_LINEAGE = 'requests';

export interface PreparedRequest {
  readonly id: string;
  readonly turnId: string;
  readonly runId: string;
  readonly epoch: number;
  readonly revision: number;
  /** Null for the admission, which carried its source revision. */
  readonly step: number | null;
  readonly source: ContextSelection;
  readonly metadata: SessionPayload;
}

export interface PreparedRequestBundle {
  readonly request: PreparedRequest;
  readonly messages: readonly MessageReference[];
  /** Messages no row names yet, with their copies. */
  readonly rendered: readonly { readonly message: ModelMessage; readonly prepared: PreparedMessage }[];
}

interface RequestRow { request_id: string; turn_id: string; run_id: string; epoch: number; revision: number; step_index: number | null; context_id: string; context_revision: number; metadata_json: string | null; metadata_path: string | null; metadata_digest: string | null }

function requestOf(row: RequestRow): Effect.Effect<PreparedRequest, KinuError> {
  return Effect.map(storedPayload(row.metadata_json, row.metadata_path, row.metadata_digest), (metadata) => ({
    id: row.request_id, turnId: row.turn_id, runId: row.run_id, epoch: row.epoch, revision: row.revision, step: row.step_index,
    source: { contextId: row.context_id, revision: row.context_revision }, metadata,
  }));
}

/** Immutable prepared-request evidence; never a source for working-context replay. */
export class SessionRequests {
  constructor(private readonly sql: SqlExecutor, private readonly actor: ActorHandle,
    private readonly messages: SessionMessages, private readonly context: SessionContext) {}

  async prepare(input: Omit<PreparedRequest, 'metadata'> & { readonly metadata: JsonValue }): Promise<PreparedRequest> {
    return { ...input, metadata: await this.messages.payloads.prepare(input.metadata) };
  }

  async prepareRendered(input: Omit<PreparedRequest, 'metadata'> & { readonly metadata: JsonValue; readonly messages: readonly ModelMessage[] }): Promise<PreparedRequestBundle> {
    this.actor.assertCurrent();
    const { messages: sent, ...request } = input;
    const messages: MessageReference[] = [];
    const rendered: { message: ModelMessage; prepared: PreparedMessage }[] = [];

    for (const message of sent) {
      const source = this.messages.sourceOf(message);

      if (source !== null) {
        messages.push(source);
        continue;
      }

      const prepared = await this.messages.prepareRender(message);
      rendered.push({ message, prepared });
      messages.push({ messageId: prepared.id });
    }

    return { request: await this.prepare(request), messages, rendered };
  }

  /** Inside the claim owner's transaction, after it rechecked its epoch. A position the last request held writes nothing. */
  recordPrepared(bundle: PreparedRequestBundle): void {
    for (const { prepared } of bundle.rendered) this.messages.insertRender(prepared);
    const list = this.context.record(REQUEST_LINEAGE, bundle.messages);
    this.record(bundle.request);
    void this.sql`INSERT INTO request_renders(actor_id,request_id,context_id,revision)
      VALUES(${this.actor.actorId},${bundle.request.id},${list.contextId},${list.revision})`;
  }

  /** After commit, so a later request carrying the same copy names its row by identity. */
  remember(bundle: PreparedRequestBundle): void {
    for (const { message, prepared } of bundle.rendered) this.messages.remember(message, { messageId: prepared.id });
  }

  forTurn(turnId: string): readonly PreparedRequest[] {
    this.actor.assertCurrent();

    return settleSync(Effect.forEach(this.sql<RequestRow>`SELECT request_id,turn_id,run_id,epoch,revision,step_index,context_id,context_revision,metadata_json,metadata_path,metadata_digest
      FROM actor_requests WHERE actor_id=${this.actor.actorId} AND turn_id=${turnId} ORDER BY epoch,revision`, requestOf));
  }

  /** Inside the claim owner's transaction, after it rechecked its epoch. */
  record(request: PreparedRequest): void {
    void this.sql`INSERT INTO actor_requests(actor_id,request_id,turn_id,run_id,epoch,step_index,revision,context_id,context_revision,metadata_json,metadata_path,metadata_digest,recorded_at)
      VALUES(${this.actor.actorId},${request.id},${request.turnId},${request.runId},${request.epoch},${request.step},${request.revision},${request.source.contextId},${request.source.revision},${request.metadata.json},${request.metadata.path},${request.metadata.digest},${Date.now()})`;
  }

  /** Inline metadata only. */
  lastStep(): { readonly recordedAt: number; readonly metadata: string | null } | null {
    this.actor.assertCurrent();

    const row = this.sql<{ recorded_at: number; metadata_json: string | null }>`SELECT recorded_at,metadata_json FROM actor_requests
      WHERE actor_id=${this.actor.actorId} AND step_index IS NOT NULL ORDER BY recorded_at DESC LIMIT 1`[0];

    return row === undefined ? null : { recordedAt: row.recorded_at, metadata: row.metadata_json };
  }

  read(id: string): PreparedRequest | null {
    this.actor.assertCurrent();

    const row = this.sql<RequestRow>`SELECT request_id,turn_id,run_id,epoch,revision,step_index,context_id,context_revision,metadata_json,metadata_path,metadata_digest
      FROM actor_requests WHERE actor_id=${this.actor.actorId} AND request_id=${id}`[0];

    if (row === undefined) return null;

    return settleSync(requestOf(row));
  }

  /** A step's list is what it sent; an admission's, the conversation. */
  messagesOf(request: PreparedRequest): readonly MessageReference[] {
    return settleSync(Effect.gen({ self: this }, function* () {
      if (request.step === null) return this.context.conversationOf(this.context.entries(request.source));

      const list = this.sql<{ context_id: string; revision: number }>`SELECT context_id,revision FROM request_renders
        WHERE actor_id=${this.actor.actorId} AND request_id=${request.id}`[0];

      if (list === undefined) return yield* new KinuError('io', `request ${request.id} has no recorded message list`);

      return this.context.entries({ contextId: list.context_id, revision: list.revision });
    }));
  }

  materialize(id: string): Promise<{ readonly request: PreparedRequest; readonly messages: readonly ModelMessage[]; readonly metadata: JsonValue }> {
    return settle(Effect.gen({ self: this }, function* () {
      const request = this.read(id);

      if (request === null) return yield* new KinuError('missing', 'prepared request does not exist');
      const messages: ModelMessage[] = [];

      for (const reference of this.messagesOf(request)) messages.push(yield* Effect.promise(() => this.messages.materialize(reference)));

      return { request, messages, metadata: yield* Effect.promise(() => this.messages.payloads.read(request.metadata)) };
    }));
  }
}
