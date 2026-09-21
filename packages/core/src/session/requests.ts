import type { ModelMessage } from 'ai';
import type { ActorHandle } from '../identity/actor-handle';
import type { SqlExecutor } from '../types/primitives';
import type { JsonValue } from '../utils/json';
import { KinuError } from '../obs/error';
import type { ContextSelection } from './context';
import { SessionMessages, type MessageReference, type PreparedMessage } from './messages';
import { SessionPayloads, type SessionPayload } from './payload';

export interface PreparedRequest {
  readonly id: string;
  readonly turnId: string;
  readonly runId: string;
  readonly epoch: number;
  readonly revision: number;
  readonly step: number | null;
  readonly source: ContextSelection;
  readonly metadata: SessionPayload;
  readonly messages: readonly MessageReference[];
}

export interface PreparedRequestBundle { readonly request: PreparedRequest; readonly rendered: readonly PreparedMessage[] }

interface RequestRow { request_id: string; turn_id: string; run_id: string; epoch: number; revision: number; step_index: number | null; context_id: string; context_revision: number; metadata_json: string | null; metadata_path: string | null; metadata_digest: string | null }

/** Immutable prepared-request evidence; never a source for working-context replay. */
export class SessionRequests {
  constructor(private readonly sql: SqlExecutor, private readonly actor: ActorHandle,
    private readonly messages: SessionMessages, private readonly payloads: SessionPayloads) {}

  async prepare(input: Omit<PreparedRequest, 'metadata'> & { readonly metadata: JsonValue }): Promise<PreparedRequest> {
    return { ...input, metadata: await this.payloads.prepare(input.metadata) };
  }

  async prepareRendered(input: Omit<PreparedRequest, 'metadata' | 'messages'> & { readonly metadata: JsonValue; readonly messages: readonly ModelMessage[] }): Promise<PreparedRequestBundle> {
    const references: MessageReference[] = [];
    const rendered: PreparedMessage[] = [];

    for (const message of input.messages) {
      const source = this.messages.sourceOf(message);

      if (source !== null) references.push(source);
      else {
        const prepared = await this.messages.prepare(message, crypto.randomUUID());
        rendered.push(prepared);
        references.push({ messageId: prepared.id, sequence: prepared.updates.length - 1 });
      }
    }

    return { request: await this.prepare({ ...input, messages: references }), rendered };
  }

  recordPrepared(bundle: PreparedRequestBundle, assertEpoch: () => void): void {
    this.actor.assertCurrent();
    assertEpoch();

    for (const message of bundle.rendered) this.messages.seal(this.messages.insert(message, 'render'));
    this.record(bundle.request, assertEpoch);
  }

  forTurn(turnId: string): readonly PreparedRequest[] {
    this.actor.assertCurrent();
    const rows = this.sql<{ request_id: string }>`SELECT request_id FROM actor_requests WHERE actor_id=${this.actor.actorId} AND turn_id=${turnId} ORDER BY epoch,revision`;

    return rows.map(row => {
      const request = this.read(row.request_id);

      if (request === null) throw new KinuError('io', 'request metadata disappeared');

      return request;
    });
  }

  /** The claim owner calls this in its admission transaction after rechecking its epoch. */
  record(request: PreparedRequest, assertEpoch: () => void): void {
    this.actor.assertCurrent();
    assertEpoch();
    const actorId = this.actor.actorId;
    void this.sql`INSERT INTO actor_requests(actor_id,request_id,turn_id,run_id,epoch,step_index,revision,context_id,context_revision,metadata_json,metadata_path,metadata_digest,recorded_at)
      VALUES(${actorId},${request.id},${request.turnId},${request.runId},${request.epoch},${request.step},${request.revision},${request.source.contextId},${request.source.revision},${request.metadata.json},${request.metadata.path},${request.metadata.digest},${Date.now()})`;

    for (const [position, message] of request.messages.entries()) {
      void this.sql`INSERT INTO request_messages(actor_id,request_id,position,message_id,through_sequence)
        VALUES(${actorId},${request.id},${position},${message.messageId},${message.sequence})`;
    }
  }

  read(id: string): PreparedRequest | null {
    this.actor.assertCurrent();
    const actorId = this.actor.actorId;

    const row = this.sql<RequestRow>`SELECT request_id,turn_id,run_id,epoch,revision,step_index,context_id,context_revision,metadata_json,metadata_path,metadata_digest
      FROM actor_requests WHERE actor_id=${actorId} AND request_id=${id}`[0];

    if (row === undefined) return null;
    let metadata: SessionPayload;

    if (row.metadata_json !== null && row.metadata_path === null && row.metadata_digest === null) metadata = { json: row.metadata_json, path: null, digest: null };
    else if (row.metadata_json === null && row.metadata_path !== null && row.metadata_digest !== null) metadata = { json: null, path: row.metadata_path, digest: row.metadata_digest };
    else throw new KinuError('io', 'invalid prepared request metadata reference');

    const messages = this.sql<{ message_id: string; through_sequence: number }>`SELECT message_id,through_sequence FROM request_messages
      WHERE actor_id=${actorId} AND request_id=${id} ORDER BY position`;

    return {
      id: row.request_id, turnId: row.turn_id, runId: row.run_id, epoch: row.epoch, revision: row.revision, step: row.step_index,
      source: { contextId: row.context_id, revision: row.context_revision }, metadata,
      messages: messages.map(message => ({ messageId: message.message_id, sequence: message.through_sequence })),
    };
  }

  async materialize(id: string): Promise<{ readonly request: PreparedRequest; readonly messages: readonly ModelMessage[]; readonly metadata: JsonValue }> {
    const request = this.read(id);

    if (request === null) throw new KinuError('missing', 'prepared request does not exist');
    const messages: ModelMessage[] = [];

    for (const reference of request.messages) messages.push(await this.messages.materialize(reference));

    return { request, messages, metadata: await this.payloads.read(request.metadata) };
  }
}
