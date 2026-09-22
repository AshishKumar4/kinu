import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import type { ActorHandle } from '../identity/actor-handle';
import type { SqlExecutor } from '../types/primitives';
import { KinuError } from '../obs/error';
import { encodeModelMessages, decodeModelMessages } from './message-codec';
import { JsonObjectSchema, JsonValueSchema, type JsonObject, type JsonValue } from '../utils/json';
import type { SessionPayloads, SessionPayloadReader, SessionPayload } from './payload';

export interface MessageReference { readonly messageId: string }

export type MessageOrigin = 'input' | 'output' | 'edit' | 'context_transform' | 'render';

export interface MessagePartReference { readonly messageId: string; readonly partNo: number }

/** One part of a message's content, as `content_*` stores it. `value` is the
 *  native part, media externalized; `replyTo` pairs a tool result to its call. */
const StoredPartSchema = v.object({
  partNo: v.number(),
  kind: v.string(),
  streamOrder: v.number(),
  replyTo: v.nullable(v.object({ messageId: v.string(), partNo: v.number() })),
  value: JsonObjectSchema,
});

const StoredContentSchema = v.array(StoredPartSchema);

export type StoredPart = v.InferOutput<typeof StoredPartSchema>;

export interface PreparedContent { readonly parts: readonly StoredPart[]; readonly payload: SessionPayload }

export interface PreparedMessage {
  readonly id: string;
  readonly role: string;
  readonly contentKind: 'string' | 'parts';
  readonly envelope: JsonObject;
  readonly content: PreparedContent;
}

export interface StreamPartInput {
  readonly partNo: number;
  readonly kind: string;
  readonly streamOrder: number;
  /** The part without its text, through `SessionPayloads.prepare`. */
  readonly descriptor: SessionPayload;
  text?: string;
}

/** UTF-16 units one `stream_parts` row holds before the part continues in
 *  the next segment: at most three UTF-8 bytes each, so a row stays under
 *  the payload inline bound and far under the platform's row limit. */
const STREAM_SEGMENT_CHARS = 262_144;

interface MessageRow { role: string; native_content_kind: 'string' | 'parts'; envelope_json: string; sealed_at: number | null; content_json: string | null; content_path: string | null; content_digest: string | null }

interface StreamPartRow { part_no: number; segment: number; kind: string; stream_order: number; descriptor_json: string | null; descriptor_path: string | null; descriptor_digest: string | null; text: string }

export type ToolCallIndex = ReadonlyMap<string, { messageId: string; part: number }>;

function payloadOf(json: string | null, path: string | null, digest: string | null): SessionPayload {
  if (json !== null && path === null && digest === null) return { json, path: null, digest: null };

  if (json === null && path !== null && digest !== null) return { json: null, path, digest };

  throw new KinuError('io', 'invalid session payload reference');
}

/** Text in pieces no longer than one stream segment, never split inside a
 *  surrogate pair. */
function* segmented(text: string): Generator<string> {
  let at = 0;

  while (at < text.length) {
    let end = Math.min(text.length, at + STREAM_SEGMENT_CHARS);
    const last = text.charCodeAt(end - 1);

    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end += 1;
    yield text.slice(at, end);
    at = end;
  }
}

export interface ActorReadAuthority {
  readonly actorId: string;
  assertCurrent(): void;
}

/** Reads retain the caller's authorization across asynchronous payload access. */
export class SessionMessageReader<A extends ActorReadAuthority = ActorReadAuthority, P extends SessionPayloadReader = SessionPayloadReader> {
  constructor(protected readonly sql: SqlExecutor, protected readonly actor: A, readonly payloads: P) {}

  protected row(messageId: string): MessageRow {
    this.actor.assertCurrent();

    const row = this.sql<MessageRow>`SELECT role,native_content_kind,envelope_json,sealed_at,content_json,content_path,content_digest FROM session_messages
      WHERE actor_id=${this.actor.actorId} AND message_id=${messageId}`[0];

    if (row === undefined) throw new KinuError('missing', 'session message does not exist');

    return row;
  }

  /** An open message's parts, folded from its stream rows: segment 0 carries
   *  the descriptor, every segment its share of the text. A text-bearing kind
   *  reads its text back even while it is still empty. */
  protected async streamed(messageId: string): Promise<StoredPart[]> {
    const rows = this.sql<StreamPartRow>`SELECT part_no,segment,kind,stream_order,descriptor_json,descriptor_path,descriptor_digest,text FROM stream_parts
      WHERE actor_id=${this.actor.actorId} AND message_id=${messageId} ORDER BY part_no,segment`;

    const parts: StoredPart[] = [];

    for (const row of rows) {
      const open = parts.at(-1);

      if (row.segment > 0 && open !== undefined && open.partNo === row.part_no) {
        open.value.text = v.parse(v.string(), open.value.text) + row.text;
        continue;
      }

      const value = v.parse(JsonObjectSchema, await this.payloads.read(payloadOf(row.descriptor_json, row.descriptor_path, row.descriptor_digest)));

      if (row.kind === 'text' || row.kind === 'reasoning' || row.text !== '') value.text = row.text;
      parts.push({ partNo: row.part_no, kind: row.kind, streamOrder: row.stream_order, replyTo: null, value });
    }

    this.actor.assertCurrent();

    return parts;
  }

  /** A sealed message reads its content row; an open one reads what its
   *  stream has accumulated so far. */
  protected async stored(reference: MessageReference): Promise<{ readonly row: MessageRow; readonly parts: readonly StoredPart[] }> {
    const row = this.row(reference.messageId);

    if (row.sealed_at === null) return { row, parts: await this.streamed(reference.messageId) };
    const parts = v.parse(StoredContentSchema, await this.payloads.read(payloadOf(row.content_json, row.content_path, row.content_digest)));
    this.actor.assertCurrent();

    return { row, parts };
  }

  async projection(reference: MessageReference): Promise<JsonObject> {
    const { row, parts } = await this.stored(reference);
    const envelope = v.parse(JsonObjectSchema, JSON.parse(row.envelope_json));

    return { ...envelope, role: row.role, content: row.native_content_kind === 'string' ? v.parse(v.string(), parts[0]?.value.text ?? '') : parts.map(part => part.value) };
  }

  async materializeParts(reference: MessageReference): Promise<readonly StoredPart[]> {
    return (await this.stored(reference)).parts;
  }

  async materialize(reference: MessageReference): Promise<ModelMessage> {
    const { row, parts } = await this.stored(reference);
    const content: JsonObject[] = [];

    for (const part of parts) content.push(part.value.type === 'image' || part.value.type === 'file' ? await this.payloads.resolveMedia(part.value) : part.value);
    const envelope = v.parse(JsonObjectSchema, JSON.parse(row.envelope_json));
    const native = { ...envelope, role: row.role, content: row.native_content_kind === 'string' ? v.parse(v.string(), content[0]?.text ?? '') : content };
    const decoded = decodeModelMessages(JSON.stringify([v.parse(JsonValueSchema, native)]))[0];
    this.actor.assertCurrent();

    if (decoded === undefined) throw new KinuError('io', 'session message failed to materialize');

    return decoded;
  }
}

/** Native message rows. A whole message is inserted sealed; a streamed one is
 *  opened, accumulates in `stream_parts`, and seals once at its step's end.
 *  Selection is owned by the context store. */
export class SessionMessages extends SessionMessageReader<ActorHandle, SessionPayloads> {
  private readonly sources = new WeakMap<ModelMessage, MessageReference>();

  sourceOf(message: ModelMessage): MessageReference | null {
    this.actor.assertCurrent();

    return this.sources.get(message) ?? null;
  }

  async bindSource(message: ModelMessage, reference: MessageReference): Promise<void> {
    const recorded = await this.materialize(reference);

    if (encodeModelMessages([recorded]) !== encodeModelMessages([message])) throw new KinuError('io', 'native output differs from its recorded content');
    this.sources.set(message, reference);
  }

  async prepare(message: ModelMessage, id: string, calls: ToolCallIndex = new Map()): Promise<PreparedMessage> {
    const encoded = v.parse(v.array(JsonObjectSchema), JSON.parse(encodeModelMessages([message])))[0];

    if (encoded === undefined) throw new KinuError('bad_input', 'missing native message');
    const { role, content, ...envelope } = encoded;

    return this.prepareParts(v.parse(v.string(), role), v.parse(JsonValueSchema, content), envelope, id, calls);
  }

  async prepareProjection(value: JsonObject, id: string, calls: ToolCallIndex = new Map()): Promise<PreparedMessage> {
    const { role, content, ...envelope } = value;
    const decodedContent = v.is(v.string(), content) ? content : await Promise.all(v.parse(v.array(JsonObjectSchema), content).map(part => part.type === 'file' || part.type === 'image' ? this.payloads.resolveMedia(part) : part));
    decodeModelMessages(JSON.stringify([{ ...envelope, role, content: decodedContent }]));

    return this.prepareParts(v.parse(v.string(), role), v.parse(JsonValueSchema, content), envelope, id, calls);
  }

  /** Native structure the codec does not validate: render-only parts a transcript entry shows and the model never reads. */
  async prepareParts(role: string, content: JsonValue, envelope: JsonObject, id: string, calls: ToolCallIndex = new Map()): Promise<PreparedMessage> {
    const kind = v.is(v.string(), content) ? 'string' : 'parts';
    const nativeParts = v.is(v.string(), content) ? [{ type: 'text', text: content }] : v.parse(v.array(JsonObjectSchema), content);

    const parts = nativeParts.map((value, partNo) => ({ partNo, kind: v.parse(v.string(), value.type), streamOrder: partNo, replyTo: replyOf(value, calls), value }));

    return { id, role, contentKind: kind, envelope, content: await this.prepareContent(parts) };
  }

  /** Media leaves the row for the attachment plane; the parts array then
   *  follows the payload spill rule. */
  async prepareContent(parts: readonly StoredPart[]): Promise<PreparedContent> {
    const stored: StoredPart[] = [];

    for (const part of parts) {
      const value = part.value.type === 'image' || part.value.type === 'file' ? await this.payloads.externalizeMedia(part.value) : part.value;
      stored.push({ ...part, value });
    }

    return { parts: stored, payload: await this.payloads.prepare(stored) };
  }

  private assertUnrecorded(messageId: string): void {
    const existing = this.sql<{ message_id: string }>`SELECT message_id FROM session_messages WHERE actor_id=${this.actor.actorId} AND message_id=${messageId}`[0];

    if (existing !== undefined) throw new KinuError('denied', 'message identity is already recorded');
  }

  /** Called inside the context owner's transaction; no filesystem work occurs here. */
  insert(prepared: PreparedMessage, origin: MessageOrigin, identity: { requestId?: string; slot?: number; ingressId?: string } = {}): MessageReference {
    this.actor.assertCurrent();
    this.assertUnrecorded(prepared.id);
    const { payload } = prepared.content;
    void this.sql`INSERT INTO session_messages(actor_id,message_id,role,native_content_kind,origin,request_id,output_slot,ingress_id,recorded_at,envelope_json,sealed_at,content_json,content_path,content_digest)
      VALUES(${this.actor.actorId},${prepared.id},${prepared.role},${prepared.contentKind},${origin},${identity.requestId ?? null},${identity.slot ?? null},${identity.ingressId ?? null},${Date.now()},${JSON.stringify(prepared.envelope)},${Date.now()},${payload.json},${payload.path},${payload.digest})`;

    return { messageId: prepared.id };
  }

  /** A streamed message: its row only. Parts arrive through `stream*`. */
  open(role: 'assistant' | 'tool', id: string, origin: MessageOrigin, identity: { requestId?: string; slot?: number } = {}, envelope: JsonObject = {}): MessageReference {
    this.actor.assertCurrent();
    this.assertUnrecorded(id);
    void this.sql`INSERT INTO session_messages(actor_id,message_id,role,native_content_kind,origin,request_id,output_slot,ingress_id,recorded_at,envelope_json)
      VALUES(${this.actor.actorId},${id},${role},'parts',${origin},${identity.requestId ?? null},${identity.slot ?? null},${null},${Date.now()},${JSON.stringify(envelope)})`;

    return { messageId: id };
  }

  private assertOpen(messageId: string): void {
    const row = this.sql<{ sealed_at: number | null }>`SELECT sealed_at FROM session_messages WHERE actor_id=${this.actor.actorId} AND message_id=${messageId}`[0];

    if (row === undefined || row.sealed_at !== null) throw new KinuError('denied', 'message is missing or sealed');
  }

  /** The descriptor a part opens with: the native part without its text,
   *  media externalized, through the payload spill rule. */
  async prepareDescriptor(native: JsonObject): Promise<{ readonly descriptor: SessionPayload; readonly text: string | undefined }> {
    const { text, ...rest } = native;
    const descriptor = rest.type === 'image' || rest.type === 'file' ? await this.payloads.externalizeMedia(rest) : rest;

    return { descriptor: await this.payloads.prepare(descriptor), text: v.is(v.string(), text) ? text : undefined };
  }

  /** An open part's descriptor with its provider options replaced. */
  async prepareMetadata(messageId: string, partNo: number, providerOptions: JsonObject | undefined): Promise<SessionPayload> {
    this.actor.assertCurrent();

    const row = this.sql<StreamPartRow>`SELECT part_no,segment,kind,stream_order,descriptor_json,descriptor_path,descriptor_digest,text FROM stream_parts
      WHERE actor_id=${this.actor.actorId} AND message_id=${messageId} AND part_no=${partNo} AND segment=0`[0];

    if (row === undefined) throw new KinuError('denied', 'stream part is missing or sealed');
    const descriptor = v.parse(JsonObjectSchema, await this.payloads.read(payloadOf(row.descriptor_json, row.descriptor_path, row.descriptor_digest)));
    delete descriptor.providerOptions;

    if (providerOptions !== undefined) descriptor.providerOptions = providerOptions;

    return this.payloads.prepare(descriptor);
  }

  streamOpenPart(messageId: string, part: StreamPartInput): void {
    this.actor.assertCurrent();
    this.assertOpen(messageId);
    void this.sql`INSERT INTO stream_parts(actor_id,message_id,part_no,segment,kind,stream_order,descriptor_json,descriptor_path,descriptor_digest,text,ended)
      VALUES(${this.actor.actorId},${messageId},${part.partNo},0,${part.kind},${part.streamOrder},${part.descriptor.json},${part.descriptor.path},${part.descriptor.digest},'',0)`;

    if (part.text !== undefined && part.text !== '') this.streamAppend(messageId, part.partNo, part.text);
  }

  /** One window of deltas is one statement on the part's last segment; a
   *  window the segment cannot hold opens the next one. */
  streamAppend(messageId: string, partNo: number, text: string): void {
    this.actor.assertCurrent();
    const actorId = this.actor.actorId;

    for (const piece of segmented(text)) {
      const extended = this.sql<{ segment: number }>`UPDATE stream_parts SET text = text || ${piece}
        WHERE actor_id=${actorId} AND message_id=${messageId} AND part_no=${partNo} AND ended=0 AND length(text) + ${piece.length} <= ${STREAM_SEGMENT_CHARS}
        AND segment=(SELECT MAX(segment) FROM stream_parts WHERE actor_id=${actorId} AND message_id=${messageId} AND part_no=${partNo}) RETURNING segment`;

      if (extended.length > 0) continue;

      const last = this.sql<{ segment: number; ended: number; kind: string; stream_order: number }>`SELECT segment,ended,kind,stream_order FROM stream_parts
        WHERE actor_id=${actorId} AND message_id=${messageId} AND part_no=${partNo} ORDER BY segment DESC LIMIT 1`[0];

      if (last === undefined || last.ended !== 0) throw new KinuError('denied', 'stream part is missing, sealed or ended');
      void this.sql`INSERT INTO stream_parts(actor_id,message_id,part_no,segment,kind,stream_order,descriptor_json,descriptor_path,descriptor_digest,text,ended)
        VALUES(${actorId},${messageId},${partNo},${last.segment + 1},${last.kind},${last.stream_order},${null},${null},${null},${piece},0)`;
    }
  }

  streamMetadata(messageId: string, partNo: number, descriptor: SessionPayload): void {
    this.actor.assertCurrent();

    const written = this.sql<{ segment: number }>`UPDATE stream_parts SET descriptor_json=${descriptor.json},descriptor_path=${descriptor.path},descriptor_digest=${descriptor.digest}
      WHERE actor_id=${this.actor.actorId} AND message_id=${messageId} AND part_no=${partNo} AND segment=0 RETURNING segment`;

    if (written.length === 0) throw new KinuError('denied', 'stream part is missing or sealed');
  }

  streamEnd(messageId: string, partNo: number): void {
    this.actor.assertCurrent();
    const ended = this.sql<{ segment: number }>`UPDATE stream_parts SET ended=1 WHERE actor_id=${this.actor.actorId} AND message_id=${messageId} AND part_no=${partNo} AND ended=0 RETURNING segment`;

    if (ended.length === 0) throw new KinuError('denied', 'stream part is missing, sealed or ended');
  }

  /** The open message's parts as its stream holds them; null once sealed. */
  async openParts(messageId: string): Promise<readonly StoredPart[] | null> {
    return this.row(messageId).sealed_at === null ? this.streamed(messageId) : null;
  }

  /** One transaction: the content row lands, the stream rows go. */
  seal(messageId: string, content: PreparedContent, envelope?: JsonObject): void {
    const row = this.row(messageId);

    if (row.sealed_at !== null) throw new KinuError('denied', 'message is already sealed');
    const { payload } = content;
    const envelopeJson = envelope === undefined ? row.envelope_json : JSON.stringify(envelope);
    void this.sql`UPDATE session_messages SET sealed_at=${Date.now()},content_json=${payload.json},content_path=${payload.path},content_digest=${payload.digest},envelope_json=${envelopeJson}
      WHERE actor_id=${this.actor.actorId} AND message_id=${messageId}`;
    void this.sql`DELETE FROM stream_parts WHERE actor_id=${this.actor.actorId} AND message_id=${messageId}`;
  }

  override async materialize(reference: MessageReference): Promise<ModelMessage> {
    const decoded = await super.materialize(reference);
    this.sources.set(decoded, reference);

    return decoded;
  }
}

function replyOf(value: JsonObject, calls: ToolCallIndex): StoredPart['replyTo'] {
  if (value.type !== 'tool-result') return null;
  const callId = v.safeParse(v.string(), value.toolCallId);
  const call = callId.success ? calls.get(callId.output) : undefined;

  return call === undefined ? null : { messageId: call.messageId, partNo: call.part };
}
