import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import type { ActorHandle } from '../identity/actor-handle';
import type { SqlExecutor } from '../types/primitives';
import { KinuError } from '../obs/error';
import { sha256Hex } from '../safety/argument-digest';
import { encodeModelMessage, decodeModelMessageValues } from './message-codec';
import { JsonObjectSchema, isParsedJsonObject, jsonObjectElements, type JsonObject, type JsonValue } from '../utils/json';
import { freezeTree } from '../utils/freeze';
import type { SessionPayloads, SessionPayloadReader, SessionPayload } from './payload';

export interface MessageReference { readonly messageId: string }

export type MessageOrigin = 'input' | 'output' | 'edit' | 'context_transform' | 'render';

export interface MessagePartReference { readonly messageId: string; readonly partNo: number }

const StoredPartFieldsSchema = v.object({
  partNo: v.number(),
  kind: v.string(),
  streamOrder: v.number(),
  replyTo: v.nullable(v.object({ messageId: v.string(), partNo: v.number() })),
});

/** `value` has media externalized; `replyTo` pairs a tool result to its call. */
export type StoredPart = v.InferOutput<typeof StoredPartFieldsSchema> & { value: JsonObject };

export interface PreparedContent { readonly parts: readonly StoredPart[]; readonly payload: SessionPayload }

export interface PreparedMessage {
  readonly id: string;
  readonly role: string;
  readonly contentKind: 'string' | 'parts';
  readonly envelope: JsonObject;
  readonly content: PreparedContent;
}

/** The claim a write belongs to, and the check that throws once it is no longer current. */
export interface ClaimFence {
  readonly turnId: string;
  readonly epoch: number;
  readonly assert: () => void;
}

export interface StreamPartInput {
  readonly partNo: number;
  readonly kind: string;
  readonly streamOrder: number;
  /** The part without its text, through `SessionPayloads.prepare`. */
  readonly descriptor: SessionPayload;
  text?: string;
}

// UTF-16 units per segment; at most three UTF-8 bytes each keeps a row under the inline bound.
const STREAM_SEGMENT_CHARS = 262_144;

interface MessageRow { origin: MessageOrigin; role: string; native_content_kind: 'string' | 'parts'; envelope_json: string; sealed_at: number | null; content_json: string | null; content_path: string | null; content_digest: string | null }

interface SealedMessage { readonly message: ModelMessage; readonly origin: MessageOrigin }

interface StreamPartRow { part_no: number; segment: number; kind: string; stream_order: number; descriptor_json: string | null; descriptor_path: string | null; descriptor_digest: string | null; text: string }

export type ToolCallIndex = ReadonlyMap<string, { messageId: string; part: number }>;

export interface StreamedMessage {
  /** The model request that produced it; null for a scaffold-authored stream. */
  readonly requestId?: string;
  readonly slot?: number;
  readonly envelope?: JsonObject;
}

export interface NativeMessage {
  readonly id: string;
  readonly role: string;
  readonly content: JsonValue;
  readonly envelope: JsonObject;
  /** Where each tool call was recorded, so a result part can point back at it. */
  readonly calls?: ToolCallIndex;
}

// Never splits a surrogate pair.
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

function descriptorObject(value: JsonValue): JsonObject {
  if (!isParsedJsonObject(value)) throw new KinuError('io', 'a stored part descriptor is not an object');

  return value;
}

function storedParts(content: JsonValue): StoredPart[] {
  const parts = jsonObjectElements(content);

  if (parts === null) throw new KinuError('io', 'a stored message content is not a list of parts');

  return parts.map((part) => {
    const value = part.value;

    if (value === undefined || !isParsedJsonObject(value)) throw new KinuError('io', 'a stored message part has no native value');

    return { ...v.parse(StoredPartFieldsSchema, part), value };
  });
}

export interface ActorReadAuthority {
  readonly actorId: string;
  assertCurrent(): void;
}

/** Reads retain the caller's authorization across asynchronous payload access. */
export class SessionMessageReader<A extends ActorReadAuthority = ActorReadAuthority, P extends SessionPayloadReader = SessionPayloadReader> {
  /** Sealed rows never change, so each is read once per reader. */
  private sealed = new Map<string, SealedMessage>();

  /** The caller has just read or committed this immutable message. */
  protected cache(reference: MessageReference, message: ModelMessage, origin: MessageOrigin): void {
    freezeTree({ value: message });
    this.sealed.set(reference.messageId, { message, origin });
  }

  constructor(protected readonly sql: SqlExecutor, protected readonly actor: A, readonly payloads: P) {}

  protected row(messageId: string): MessageRow {
    this.actor.assertCurrent();

    const row = this.sql<MessageRow>`SELECT origin,role,native_content_kind,envelope_json,sealed_at,content_json,content_path,content_digest FROM session_messages
      WHERE actor_id=${this.actor.actorId} AND message_id=${messageId}`[0];

    if (row === undefined) throw new KinuError('missing', 'session message does not exist');

    return row;
  }

  /** Segment 0 carries the descriptor; every segment carries its share of the text. */
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

      const value = descriptorObject(await this.payloads.readStored(row.descriptor_json, row.descriptor_path, row.descriptor_digest));

      if (row.kind === 'text' || row.kind === 'reasoning' || row.text !== '') value.text = row.text;
      parts.push({ partNo: row.part_no, kind: row.kind, streamOrder: row.stream_order, replyTo: null, value });
    }

    this.actor.assertCurrent();

    return parts;
  }

  /** Lets a reader without a file plane know what it cannot open. */
  spilled(messageId: string): boolean {
    const row = this.row(messageId);

    if (row.sealed_at !== null) return row.content_path !== null;

    return this.sql<{ x: number }>`SELECT 1 AS x FROM stream_parts
      WHERE actor_id=${this.actor.actorId} AND message_id=${messageId} AND descriptor_path IS NOT NULL LIMIT 1`.length > 0;
  }

  protected async stored(reference: MessageReference): Promise<{ readonly row: MessageRow; readonly parts: readonly StoredPart[] }> {
    const row = this.row(reference.messageId);

    if (row.sealed_at === null) return { row, parts: await this.streamed(reference.messageId) };
    const parts = storedParts(await this.payloads.readStored(row.content_json, row.content_path, row.content_digest));
    this.actor.assertCurrent();

    return { row, parts };
  }

  /** Each named message's parts, its rows in one statement; a message no row holds is absent. */
  async materializePartsOf(messageIds: readonly string[]): Promise<Map<string, readonly StoredPart[]>> {
    this.actor.assertCurrent();

    const rows = this.sql<MessageRow & { message_id: string }>`SELECT message_id,origin,role,native_content_kind,envelope_json,sealed_at,content_json,content_path,content_digest
      FROM session_messages WHERE actor_id=${this.actor.actorId} AND message_id IN (SELECT value FROM json_each(${JSON.stringify(messageIds)}))`;

    const parts = new Map<string, readonly StoredPart[]>();

    for (const row of rows) {
      parts.set(row.message_id, row.sealed_at === null
        ? await this.streamed(row.message_id)
        : storedParts(await this.payloads.readStored(row.content_json, row.content_path, row.content_digest)));
    }

    this.actor.assertCurrent();

    return parts;
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
    const cached = this.sealed.get(reference.messageId);

    if (cached !== undefined) {
      this.actor.assertCurrent();

      return cached.message;
    }

    const { row, parts } = await this.stored(reference);
    const content: JsonObject[] = [];

    for (const part of parts) content.push(part.value.type === 'image' || part.value.type === 'file' ? await this.payloads.resolveMedia(part.value) : part.value);
    const envelope = v.parse(JsonObjectSchema, JSON.parse(row.envelope_json));
    const native: JsonObject = { ...envelope, role: row.role, content: row.native_content_kind === 'string' ? v.parse(v.string(), content[0]?.text ?? '') : content };
    const decoded = decodeModelMessageValues([native])[0];
    this.actor.assertCurrent();

    if (decoded === undefined) throw new KinuError('io', 'session message failed to materialize');

    if (row.sealed_at === null) return decoded;
    this.cache(reference, decoded, row.origin);

    return decoded;
  }

  originOf(reference: MessageReference): MessageOrigin {
    const cached = this.sealed.get(reference.messageId);

    if (cached !== undefined) return cached.origin;
    this.actor.assertCurrent();
    const row = this.sql<{ origin: MessageOrigin }>`SELECT origin FROM session_messages WHERE actor_id=${this.actor.actorId} AND message_id=${reference.messageId}`[0];

    if (row === undefined) throw new KinuError('missing', 'session message does not exist');

    return row.origin;
  }

  /** Asserts the actor once, after the last await; keeps only the messages this context names. */
  async materializeAll(references: readonly MessageReference[]): Promise<ModelMessage[]> {
    const messages: ModelMessage[] = [];
    const named = new Map<string, SealedMessage>();

    for (const reference of references) {
      const message = this.sealed.get(reference.messageId)?.message ?? await this.materialize(reference);
      const sealed = this.sealed.get(reference.messageId);
      messages.push(message);

      if (sealed?.message === message) named.set(reference.messageId, sealed);
    }

    this.actor.assertCurrent();
    this.sealed = named;

    return messages;
  }
}

/** A streamed message accumulates in `stream_parts` and seals once. Selection belongs to the context store. */
export class SessionMessages extends SessionMessageReader<ActorHandle, SessionPayloads> {
  private readonly sources = new WeakMap<ModelMessage, MessageReference>();

  /** In-memory lookup; the caller asserts the actor. */
  sourceOf(message: ModelMessage): MessageReference | null {
    return this.sources.get(message) ?? null;
  }

  /** The stream has committed these native parts; they may include parts its final message omitted. */
  bindSource(message: ModelMessage, reference: MessageReference, native: JsonObject): void {
    this.actor.assertCurrent();
    const recorded = decodeModelMessageValues([native])[0];

    if (recorded === undefined || !carries(recorded, message)) throw new KinuError('io', 'native output differs from its recorded content');
    this.cache(reference, recorded, 'output');
    this.sources.set(message, reference);
    this.sources.set(recorded, reference);
  }

  /** Frozen, so it cannot drift from the committed row it names. */
  remember(message: ModelMessage, reference: MessageReference): void {
    freezeTree({ value: message });
    this.sources.set(message, reference);
  }

  async prepare(message: ModelMessage, id: string, calls: ToolCallIndex = new Map()): Promise<PreparedMessage> {
    const { role, content, ...envelope } = encodeModelMessage(message);

    return this.prepareParts({ id, role: v.parse(v.string(), role), content, envelope, calls });
  }

  async prepareProjection(value: JsonObject, id: string, calls: ToolCallIndex = new Map()): Promise<PreparedMessage> {
    const { role, content, ...envelope } = value;
    const parts = v.is(v.string(), content) ? null : jsonObjectElements(content);
    const decodedContent = parts === null ? content : await Promise.all(parts.map(part => part.type === 'file' || part.type === 'image' ? this.payloads.resolveMedia(part) : part));
    decodeModelMessageValues([{ ...envelope, role, content: decodedContent }]);

    return this.prepareParts({ id, role: v.parse(v.string(), role), content, envelope, calls });
  }

  /** Native structure the codec does not validate: render-only parts a transcript entry shows and the model never reads. */
  async prepareParts(message: NativeMessage): Promise<PreparedMessage> {
    const { id, role, content, envelope, calls = new Map() } = message;
    const text = v.is(v.string(), content);
    const nativeParts = text ? [{ type: 'text', text: content }] : jsonObjectElements(content);

    if (nativeParts === null) throw new KinuError('bad_input', 'message content is neither text nor a list of parts');
    const parts = nativeParts.map((value, partNo) => ({ partNo, kind: v.parse(v.string(), value.type), streamOrder: partNo, replyTo: replyOf(value, calls), value }));

    return { id, role, contentKind: text ? 'string' : 'parts', envelope, content: await this.prepareContent(parts) };
  }

  async prepareContent(parts: readonly StoredPart[]): Promise<PreparedContent> {
    const stored: StoredPart[] = [];

    for (const part of parts) {
      const value = part.value.type === 'image' || part.value.type === 'file' ? await this.payloads.externalizeMedia(part.value) : part.value;
      stored.push({ ...part, value });
    }

    return { parts: stored, payload: await this.payloads.prepare(stored) };
  }

  private recorded(messageId: string): boolean {
    return this.sql<{ message_id: string }>`SELECT message_id FROM session_messages WHERE actor_id=${this.actor.actorId} AND message_id=${messageId}`.length > 0;
  }

  private assertUnrecorded(messageId: string): void {
    if (this.recorded(messageId)) throw new KinuError('denied', 'message identity is already recorded');
  }

  /** A render-only copy named by its bytes (a spilled payload by their digest), so one row serves every request. */
  async prepareRender(message: ModelMessage): Promise<PreparedMessage> {
    const prepared = await this.prepare(message, '');
    const { role, contentKind, envelope, content: { payload } } = prepared;

    return { ...prepared, id: `render:${sha256Hex(`${role}\n${contentKind}\n${JSON.stringify(envelope)}\n${payload.json ?? payload.digest}`)}` };
  }

  insertRender(prepared: PreparedMessage): void {
    if (!this.recorded(prepared.id)) this.insert(prepared, 'render');
  }

  /** Called inside the context owner's transaction; no filesystem work occurs here. */
  insert(prepared: PreparedMessage, origin: MessageOrigin, identity: { requestId?: string; slot?: number; ingressId?: string } = {}): MessageReference {
    this.actor.assertCurrent();
    this.assertUnrecorded(prepared.id);
    const { payload } = prepared.content;
    void this.sql`INSERT INTO session_messages(actor_id,message_id,role,native_content_kind,origin,request_id,output_slot,ingress_id,envelope_json,sealed_at,content_json,content_path,content_digest)
      VALUES(${this.actor.actorId},${prepared.id},${prepared.role},${prepared.contentKind},${origin},${identity.requestId ?? null},${identity.slot ?? null},${identity.ingressId ?? null},${JSON.stringify(prepared.envelope)},${Date.now()},${payload.json},${payload.path},${payload.digest})`;

    return { messageId: prepared.id };
  }

  open(role: 'assistant' | 'tool', id: string, origin: MessageOrigin, stream: StreamedMessage = {}): MessageReference {
    this.actor.assertCurrent();

    const opened = this.sql<{ message_id: string }>`INSERT INTO session_messages(actor_id,message_id,role,native_content_kind,origin,request_id,output_slot,ingress_id,envelope_json)
      VALUES(${this.actor.actorId},${id},${role},'parts',${origin},${stream.requestId ?? null},${stream.slot ?? null},${null},${JSON.stringify(stream.envelope ?? {})})
      ON CONFLICT(actor_id,message_id) DO NOTHING RETURNING message_id`;

    if (opened.length === 0) throw new KinuError('denied', 'message identity is already recorded');

    return { messageId: id };
  }

  async prepareDescriptor(native: JsonObject): Promise<SessionPayload> {
    const { text: _text, ...rest } = native;
    const descriptor = rest.type === 'image' || rest.type === 'file' ? await this.payloads.externalizeMedia(rest) : rest;

    return this.payloads.prepare(descriptor);
  }

  streamOpenPart(messageId: string, part: StreamPartInput): void {
    this.actor.assertCurrent();

    const opened = this.sql<{ part_no: number }>`INSERT INTO stream_parts(actor_id,message_id,part_no,segment,kind,stream_order,descriptor_json,descriptor_path,descriptor_digest,text,ended)
      SELECT ${this.actor.actorId},${messageId},${part.partNo},0,${part.kind},${part.streamOrder},${part.descriptor.json},${part.descriptor.path},${part.descriptor.digest},'',0
      FROM session_messages WHERE actor_id=${this.actor.actorId} AND message_id=${messageId} AND sealed_at IS NULL RETURNING part_no`;

    if (opened.length === 0) throw new KinuError('denied', 'message is missing or sealed');

    if (part.text !== undefined && part.text !== '') this.streamAppend(messageId, part.partNo, part.text);
  }

  /** With a `fence`, the append checks the turn's claim in its own statement; without one, the caller has. */
  streamAppend(messageId: string, partNo: number, text: string, fence: ClaimFence | null = null): void {
    this.actor.assertCurrent();
    const actorId = this.actor.actorId;

    for (const piece of segmented(text)) {
      // Two statements, not one with an optional clause: a store without claims has no claim table to name.
      const extended = fence === null
        ? this.sql<{ segment: number }>`UPDATE stream_parts SET text = text || ${piece}
          WHERE actor_id=${actorId} AND message_id=${messageId} AND part_no=${partNo} AND ended=0 AND length(text) + ${piece.length} <= ${STREAM_SEGMENT_CHARS}
          AND segment=(SELECT MAX(segment) FROM stream_parts WHERE actor_id=${actorId} AND message_id=${messageId} AND part_no=${partNo}) RETURNING segment`
        : this.sql<{ segment: number }>`UPDATE stream_parts SET text = text || ${piece}
          WHERE actor_id=${actorId} AND message_id=${messageId} AND part_no=${partNo} AND ended=0 AND length(text) + ${piece.length} <= ${STREAM_SEGMENT_CHARS}
          AND segment=(SELECT MAX(segment) FROM stream_parts WHERE actor_id=${actorId} AND message_id=${messageId} AND part_no=${partNo})
          AND EXISTS (SELECT 1 FROM actor_turn_claims c WHERE c.actor_id=${actorId} AND c.turn_id=${fence.turnId} AND c.epoch=${fence.epoch} AND c.outcome IS NULL)
          RETURNING segment`;

      if (extended.length > 0) continue;
      // A stale claim is refused here, not by a new segment.
      fence?.assert();

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

  seal(messageId: string, content: PreparedContent, envelope?: JsonObject): void {
    this.actor.assertCurrent();
    const { payload } = content;
    const envelopeJson = envelope === undefined ? this.row(messageId).envelope_json : JSON.stringify(envelope);

    const sealed = this.sql<{ message_id: string }>`UPDATE session_messages SET sealed_at=${Date.now()},content_json=${payload.json},content_path=${payload.path},content_digest=${payload.digest},envelope_json=${envelopeJson}
      WHERE actor_id=${this.actor.actorId} AND message_id=${messageId} AND sealed_at IS NULL RETURNING message_id`;

    if (sealed.length === 0) {
      this.row(messageId);
      throw new KinuError('denied', 'message is already sealed');
    }

    void this.sql`DELETE FROM stream_parts WHERE actor_id=${this.actor.actorId} AND message_id=${messageId}`;
  }

  override async materialize(reference: MessageReference): Promise<ModelMessage> {
    const decoded = await super.materialize(reference);
    this.sources.set(decoded, reference);

    return decoded;
  }
}

/** Compares codec encodings: same role and envelope, every message part in order within the record. */
function carries(recorded: ModelMessage, message: ModelMessage): boolean {
  const { content: recordedContent, ...recordedEnvelope } = encodeModelMessage(recorded);
  const { content: wantedContent, ...wantedEnvelope } = encodeModelMessage(message);

  if (JSON.stringify(recordedEnvelope) !== JSON.stringify(wantedEnvelope)) return false;

  if (!Array.isArray(recordedContent) || !Array.isArray(wantedContent)) {
    return JSON.stringify(recordedContent) === JSON.stringify(wantedContent);
  }

  const recordedParts = recordedContent.map((part) => JSON.stringify(part));
  let at = 0;

  for (const part of wantedContent) {
    const encoded = JSON.stringify(part);

    while (at < recordedParts.length && recordedParts[at] !== encoded) at += 1;

    if (at === recordedParts.length) return false;
    at += 1;
  }

  return true;
}

function replyOf(value: JsonObject, calls: ToolCallIndex): StoredPart['replyTo'] {
  if (value.type !== 'tool-result') return null;
  const callId = v.safeParse(v.string(), value.toolCallId);
  const call = callId.success ? calls.get(callId.output) : undefined;

  return call === undefined ? null : { messageId: call.messageId, partNo: call.part };
}
