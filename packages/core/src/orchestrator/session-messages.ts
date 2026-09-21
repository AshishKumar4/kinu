import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import type { ActorHandle } from '../identity/actor-handle';
import type { SqlExecutor } from '../types/primitives';
import { KinuError } from '../obs/error';
import { encodeModelMessages, decodeModelMessages } from '../prompting/message-codec';
import { JsonObjectSchema, JsonValueSchema, type JsonObject } from '../utils/json';
import type { SessionPayloads, SessionPayloadReader, SessionPayload } from './session-payload';
import { PreparedMessageUpdate } from './session-updates';

export interface MessageReference { readonly messageId: string; readonly sequence: number }

export type MessageOrigin = 'input' | 'output' | 'edit' | 'context_transform' | 'render';

export interface MessagePartReference { readonly messageId: string; readonly partNo: number; readonly throughSequence: number }

export type MessageOperation = 'open' | 'append' | 'envelope-metadata' | 'metadata' | 'content-end' | 'replace-content';


export interface PreparedMessage {
  readonly id: string;
  readonly role: string;
  readonly contentKind: 'string' | 'parts';
  readonly parts: readonly { readonly number: number; readonly kind: string; readonly streamOrder?: number; readonly reply: { readonly messageId: string; readonly part: number } | null }[];
  readonly updates: readonly PreparedMessageUpdate[];
}

interface MessageRow { role: string; native_content_kind: 'string' | 'parts'; sealed_sequence: number | null }

interface UpdateRow { sequence: number; part_no: number | null; operation: MessageOperation; payload_json: string | null; payload_path: string | null; payload_digest: string | null }

interface PartRow { part_no: number; kind: string; reply_to_message_id: string | null; reply_to_part_no: number | null }

function payloadOf(row: UpdateRow): SessionPayload {
  if (row.payload_json !== null && row.payload_path === null && row.payload_digest === null) {
    return { json: row.payload_json, path: null, digest: null };
  }

  if (row.payload_json === null && row.payload_path !== null && row.payload_digest !== null) {
    return { json: null, path: row.payload_path, digest: row.payload_digest };
  }

  throw new KinuError('io', 'invalid session payload reference');
}

export interface ActorReadAuthority {
  readonly actorId: string;
  assertCurrent(): void;
}

/** Reads retain the caller's authorization across asynchronous payload access. */
export class SessionMessageReader<A extends ActorReadAuthority = ActorReadAuthority, P extends SessionPayloadReader = SessionPayloadReader> {
  constructor(protected readonly sql: SqlExecutor, protected readonly actor: A, readonly payloads: P) {}

  async projection(reference: MessageReference): Promise<JsonObject> {
    const stored = await this.materializeEnvelope(reference);

    return { ...stored.envelope, role: stored.role, content: stored.contentKind === 'string' ? v.parse(v.string(), stored.parts[0]?.value.text ?? '') : stored.parts.map(part => part.value) };
  }

  private async materializeEnvelope(reference: MessageReference): Promise<{ readonly envelope: JsonObject; readonly role: string; readonly contentKind: 'string' | 'parts'; readonly parts: readonly { partNo: number; value: JsonObject }[] }> {
    this.actor.assertCurrent();
    const actorId = this.actor.actorId;
    const message = this.sql<MessageRow>`SELECT role,native_content_kind,sealed_sequence FROM session_messages WHERE actor_id=${actorId} AND message_id=${reference.messageId}`[0];

    if (message === undefined) throw new KinuError('missing', 'session message does not exist');

    const rows = this.sql<UpdateRow>`SELECT sequence,part_no,operation,payload_json,payload_path,payload_digest FROM message_updates
      WHERE actor_id=${actorId} AND message_id=${reference.messageId} AND sequence<=${reference.sequence} ORDER BY sequence`;

    if (rows.at(-1)?.sequence !== reference.sequence) throw new KinuError('missing', 'message cutoff does not exist');
    let envelope: JsonObject = {};
    const parts = new Map<number, JsonObject>();

    for (const row of rows) {
      if (row.operation === 'content-end') continue;
      const value = await this.payloads.read(payloadOf(row));

      if (row.operation === 'envelope-metadata') { envelope = v.parse(JsonObjectSchema, value); continue; }

      if (row.part_no === null) throw new KinuError('io', 'part update has no part');

      if (row.operation === 'open') { parts.set(row.part_no, v.parse(JsonObjectSchema, value)); continue; }

      const part = parts.get(row.part_no);

      if (part === undefined) throw new KinuError('io', 'part update precedes its open');

      if (row.operation === 'metadata') {
        const metadata = v.parse(JsonObjectSchema, value);
        delete part.providerOptions;

        if (metadata.providerOptions !== undefined) part.providerOptions = metadata.providerOptions;
        continue;
      }

      if (row.operation === 'replace-content' && v.is(JsonObjectSchema, value)) { Object.assign(part, value); continue; }

      const text = v.parse(v.string(), value);
      part.text = row.operation === 'replace-content' ? text : (v.is(v.string(), part.text) ? part.text : '') + text;
    }

    const identities = this.sql<PartRow>`SELECT part_no,kind,reply_to_message_id,reply_to_part_no FROM message_parts WHERE actor_id=${actorId} AND message_id=${reference.messageId} ORDER BY part_no`;

    for (const identity of identities) {
      const part = parts.get(identity.part_no);

      if (part === undefined) continue;

      if (identity.reply_to_message_id !== null && identity.reply_to_part_no !== null) {
        const call = this.sql<UpdateRow>`SELECT sequence,part_no,operation,payload_json,payload_path,payload_digest FROM message_updates
          WHERE actor_id=${actorId} AND message_id=${identity.reply_to_message_id} AND part_no=${identity.reply_to_part_no} AND operation='open'`[0];

        if (call === undefined) throw new KinuError('io', 'result references a missing tool call');
        const descriptor = v.parse(JsonObjectSchema, await this.payloads.read(payloadOf(call)));
        part.toolCallId = v.parse(v.string(), descriptor.toolCallId);
        part.toolName = v.parse(v.string(), descriptor.toolName);
      }
    }

    this.actor.assertCurrent();

    return { envelope, role: message.role, contentKind: message.native_content_kind, parts: identities.flatMap(identity => {
      const value = parts.get(identity.part_no);

      return value === undefined ? [] : [{ partNo: identity.part_no, value }];
    }) };
  }

  async materializeParts(reference: MessageReference): Promise<readonly { readonly partNo: number; readonly value: JsonObject }[]> {
    return (await this.materializeEnvelope(reference)).parts;
  }

  async materialize(reference: MessageReference): Promise<ModelMessage> {
    const stored = await this.materializeEnvelope(reference);
    const content: JsonObject[] = [];

    for (const part of stored.parts) content.push(part.value.type === 'image' || part.value.type === 'file' ? await this.payloads.resolveMedia(part.value) : part.value);
    const native = { ...stored.envelope, role: stored.role, content: stored.contentKind === 'string' ? v.parse(v.string(), content[0]?.text ?? '') : content };
    const decoded = decodeModelMessages(JSON.stringify([v.parse(JsonValueSchema, native)]))[0];
    this.actor.assertCurrent();

    if (decoded === undefined) throw new KinuError('io', 'session message failed to materialize');

    return decoded;
  }
}

/** Native message bytes and their ordered, immutable updates. Selection is owned by the context store. */
export class SessionMessages extends SessionMessageReader<ActorHandle, SessionPayloads> {
  private readonly sources = new WeakMap<ModelMessage, MessageReference>();

  sourceOf(message: ModelMessage): MessageReference | null {
    this.actor.assertCurrent();

    return this.sources.get(message) ?? null;
  }

  async bindSource(message: ModelMessage, reference: MessageReference): Promise<void> {
    const recorded = await this.materialize(reference);

    if (encodeModelMessages([recorded]) !== encodeModelMessages([message])) throw new KinuError('io', 'native output differs from its canonical cutoff');
    this.sources.set(message, reference);
  }

  async prepare(message: ModelMessage, id: string, calls: ReadonlyMap<string, { messageId: string; part: number }> = new Map()): Promise<PreparedMessage> {
    const encoded = v.parse(v.array(JsonObjectSchema), JSON.parse(encodeModelMessages([message])))[0];

    if (encoded === undefined) throw new KinuError('bad_input', 'missing native message');
    const { role, content, ...envelope } = encoded;

    return this.prepareParts(v.parse(v.string(), role), v.parse(JsonValueSchema, content), envelope, id, calls);
  }

  async prepareProjection(value: JsonObject, id: string, calls: ReadonlyMap<string, { messageId: string; part: number }> = new Map()): Promise<PreparedMessage> {
    const { role, content, ...envelope } = value;
    const decodedContent = v.is(v.string(), content) ? content : await Promise.all(v.parse(v.array(JsonObjectSchema), content).map(part => part.type === 'file' || part.type === 'image' ? this.payloads.resolveMedia(part) : part));
    decodeModelMessages(JSON.stringify([{ ...envelope, role, content: decodedContent }]));

    return this.prepareParts(v.parse(v.string(), role), v.parse(JsonValueSchema, content), envelope, id, calls);
  }


  async prepareParts(role: string, content: import('../utils/json').JsonValue, envelope: JsonObject, id: string, calls: ReadonlyMap<string, { messageId: string; part: number }> = new Map()): Promise<PreparedMessage> {
    const kind = v.is(v.string(), content) ? 'string' : 'parts';
    const nativeParts = v.is(v.string(), content) ? [{ type: 'text', text: content }] : v.parse(v.array(JsonObjectSchema), content);

    const updates = [await PreparedMessageUpdate.prepare({ part: null, operation: 'envelope-metadata', value: envelope }, this.payloads)];
    const parts: PreparedMessage['parts'][number][] = [];

    for (const [number, native] of nativeParts.entries()) {
      const type = v.parse(v.string(), native.type);
      const callId = v.safeParse(v.string(), native.toolCallId);
      const reply = type === 'tool-result' && callId.success ? calls.get(callId.output) ?? null : null;
      const { text, ...descriptor } = native;

      if (reply !== null) { delete descriptor.toolCallId; delete descriptor.toolName; }

      parts.push({ number, kind: type, reply });
      updates.push(await PreparedMessageUpdate.prepare({ part: number, operation: 'open', value: descriptor }, this.payloads));

      if (text !== undefined) updates.push(await PreparedMessageUpdate.prepare({ part: number, operation: 'append', value: v.parse(v.string(), text) }, this.payloads));
    }

    return { id, role: v.parse(v.string(), role), contentKind: kind, parts, updates };
  }

  /** Called inside the context owner's transaction; no filesystem work occurs here. */
  insert(prepared: PreparedMessage, origin: MessageOrigin, identity: { requestId?: string; slot?: number; ingressId?: string } = {}): MessageReference {
    this.actor.assertCurrent();
    const actorId = this.actor.actorId;
    const existing = this.sql<MessageRow>`SELECT role,native_content_kind,sealed_sequence FROM session_messages WHERE actor_id=${actorId} AND message_id=${prepared.id}`[0];

    if (existing !== undefined) throw new KinuError('denied', 'message identity is already recorded');
    void this.sql`INSERT INTO session_messages(actor_id,message_id,role,native_content_kind,origin,request_id,output_slot,ingress_id,recorded_at)
      VALUES(${actorId},${prepared.id},${prepared.role},${prepared.contentKind},${origin},${identity.requestId ?? null},${identity.slot ?? null},${identity.ingressId ?? null},${Date.now()})`;

    for (const part of prepared.parts) {
      void this.sql`INSERT INTO message_parts(actor_id,message_id,part_no,kind,reply_to_message_id,reply_to_part_no,stream_order)
        VALUES(${actorId},${prepared.id},${part.number},${part.kind},${part.reply?.messageId ?? null},${part.reply?.part ?? null},${part.streamOrder ?? null})`;
    }

    return this.append(prepared.id, -1, prepared.updates);
  }

  addPart(reference: MessageReference, part: PreparedMessage['parts'][number], updates: readonly PreparedMessageUpdate[]): MessageReference {
    this.actor.assertCurrent();
    void this.sql`INSERT INTO message_parts(actor_id,message_id,part_no,kind,reply_to_message_id,reply_to_part_no,stream_order) VALUES(${this.actor.actorId},${reference.messageId},${part.number},${part.kind},${part.reply?.messageId ?? null},${part.reply?.part ?? null},${part.streamOrder ?? null})`;

    return this.append(reference.messageId, reference.sequence, updates);
  }

  append(messageId: string, expectedSequence: number, updates: readonly PreparedMessageUpdate[]): MessageReference {
    this.actor.assertCurrent();
    const actorId = this.actor.actorId;
    const row = this.sql<MessageRow>`SELECT role,native_content_kind,sealed_sequence FROM session_messages WHERE actor_id=${actorId} AND message_id=${messageId}`[0];

    if (row === undefined || row.sealed_sequence !== null) throw new KinuError('denied', 'message is missing or sealed');
    const current = this.sql<{ sequence: number | null }>`SELECT MAX(sequence) AS sequence FROM message_updates WHERE actor_id=${actorId} AND message_id=${messageId}`[0]?.sequence ?? -1;

    if (current !== expectedSequence) throw new KinuError('denied', 'message changed while its payload was prepared');
    let sequence = current;

    for (const update of updates) {
      if (update.part !== null && update.operation !== 'open') {
        const state = this.sql<{ operation: string }>`SELECT operation FROM message_updates WHERE actor_id=${actorId} AND message_id=${messageId} AND part_no=${update.part} AND operation IN ('open','content-end') ORDER BY sequence`;

        if (!state.some(item => item.operation === 'open')) throw new KinuError('denied', 'part update precedes open');

        if (update.operation === 'append' && state.some(item => item.operation === 'content-end')) throw new KinuError('denied', 'stream content already ended');
      }

      if (!(update instanceof PreparedMessageUpdate)) throw new KinuError('bad_input', 'message update was not prepared');

      sequence += 1;
      void this.sql`INSERT INTO message_updates(actor_id,message_id,sequence,part_no,operation,payload_json,payload_path,payload_digest)
        VALUES(${actorId},${messageId},${sequence},${update.part},${update.operation},${update.payload?.json ?? null},${update.payload?.path ?? null},${update.payload?.digest ?? null})`;
    }

    return { messageId, sequence };
  }

  seal(reference: MessageReference): void {
    this.actor.assertCurrent();
    const current = this.sql<{ sequence: number | null }>`SELECT MAX(sequence) AS sequence FROM message_updates WHERE actor_id=${this.actor.actorId} AND message_id=${reference.messageId}`[0]?.sequence;

    if (current !== reference.sequence) throw new KinuError('denied', 'cannot seal a stale message cutoff');
    void this.sql`UPDATE session_messages SET sealed_sequence=${reference.sequence}
      WHERE actor_id=${this.actor.actorId} AND message_id=${reference.messageId} AND sealed_sequence IS NULL`;
  }

  override async materialize(reference: MessageReference): Promise<ModelMessage> {
    const decoded = await super.materialize(reference);
    this.sources.set(decoded, reference);

    return decoded;
  }
}
