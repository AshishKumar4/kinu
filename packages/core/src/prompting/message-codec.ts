/**
 * The durable representation of a native model-message array.
 *
 * The typed boundary is the AI SDK's OWN `modelMessageSchema` — the same
 * predicate `events/recorder.ts` validates a stored message with and the
 * compaction codec narrows a native handle with. Nothing here re-declares a
 * part union, and nothing flattens a message into display prose: what goes in
 * is what comes out, including tool calls, tool results, reasoning and typed
 * attachments.
 *
 * WHY A CODEC AND NOT `JSON.stringify`. A `FilePart.data` / `ImagePart.image`
 * may hold a `Uint8Array`, an `ArrayBuffer` or a `URL`, and `JSON.stringify`
 * renders all three as something that parses back as a DIFFERENT value: a byte
 * array becomes `{"0":137,"1":80,…}` (an object the SDK schema rejects), and a
 * `URL` becomes its href with its type lost. A context revision is the exact
 * input a model step consumed and a recovery must reproduce, so a lossy round
 * trip is not a representation of it. The compaction codec's `binaryReplacer`
 * is deliberately NOT reused: it renders `[binary N bytes]` for a transcript a
 * human or a model reads, which is the right answer for a preview and the wrong
 * one for bytes that must come back.
 *
 * Both directions walk NAMED types — {@link NativeValue} on the way in,
 * {@link StoredValue} on the way out — and the stored side is PARSED before it
 * is walked, so a corrupt row is named at the boundary instead of narrowing
 * field by field on the way through.
 */

import { modelMessageSchema, type ModelMessage } from 'ai';
import * as v from 'valibot';
import { sha256Hex } from '../safety/argument-digest';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import { KinuError } from '../obs/error';

/** Anything a native model message holds: JSON, plus the three carriers an SDK
 *  attachment may use for its payload. */
export type NativeValue =
  | string | number | boolean | null | undefined
  | Uint8Array | ArrayBuffer | URL
  | readonly NativeValue[]
  | { readonly [key: string]: NativeValue };

/** Anything the stored form holds: JSON only, which is what a SQLite TEXT
 *  column can carry back unchanged. */
export type StoredValue =
  | string | number | boolean | null
  | readonly StoredValue[]
  | { readonly [key: string]: StoredValue };

/** The native side as a schema, so the walk below branches on a PARSED domain
 *  value rather than sniffing representations as it goes. */
const NativeValueSchema: v.GenericSchema<NativeValue> = v.lazy(() => v.union([
  v.string(), v.number(), v.boolean(), v.null(), v.undefined(),
  v.instance(Uint8Array), v.instance(ArrayBuffer), v.instance(URL),
  v.array(NativeValueSchema),
  v.record(v.string(), NativeValueSchema),
]));

const NativeRecordSchema: v.GenericSchema<{ readonly [key: string]: NativeValue }> =
  v.record(v.string(), NativeValueSchema);

const StoredValueSchema: v.GenericSchema<StoredValue> = v.lazy(() => v.union([
  v.string(), v.number(), v.boolean(), v.null(),
  v.array(StoredValueSchema),
  v.record(v.string(), StoredValueSchema),
]));

/** Base64 of a byte payload. `bytes` is the length the decoder asserts, so a
 *  truncated row is named rather than decoded into a shorter buffer.
 *  `buffer` marks an `ArrayBuffer` source, so the decode restores that type
 *  rather than substituting a view of it. */
const BinaryEnvelopeSchema = v.object({
  $binary: v.string(),
  bytes: v.number(),
  buffer: v.optional(v.literal(true)),
});

const UrlEnvelopeSchema = v.object({ $url: v.string() });

/** The escape hatch: a SOURCE object that itself carries a reserved key travels
 *  inside this wrapper, so an encode/decode pair is total rather than
 *  total-unless-the-data-looks-like-the-encoding. */
const PlainEnvelopeSchema = v.object({ $plain: v.record(v.string(), StoredValueSchema) });

const StoredRecordSchema = v.record(v.string(), StoredValueSchema);

const RESERVED = ['$binary', '$url', '$plain'] as const;

function encodeValue(value: NativeValue): StoredValue {
  if (value instanceof Uint8Array) return { $binary: bytesToBase64(value), bytes: value.byteLength };

  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value);

    return { $binary: bytesToBase64(bytes), bytes: bytes.byteLength, buffer: true };
  }

  if (value === undefined) return null;

  if (value instanceof URL) return { $url: value.href };

  if (Array.isArray(value)) return value.map(encodeValue);
  // Not a record: a primitive, which the stored form carries unchanged. An
  // absent value became `null` above, which is what JSON does with it anyway
  // and what the SDK schema reads as an absent optional field.
  const record = v.safeParse(NativeRecordSchema, value);

  if (!record.success) {
    // Everything left is a JSON primitive the stored form carries unchanged;
    // parsing says so rather than an assertion claiming it.
    return v.parse(StoredValueSchema, value);
  }

  const mapped: Record<string, StoredValue> = {};
  const source = record.output;

  for (const key of Object.keys(source)) {
    const item = source[key];

    if (item !== undefined) mapped[key] = encodeValue(item);
  }

  return RESERVED.some((key) => Object.hasOwn(source, key)) ? { $plain: mapped } : mapped;
}

function decodeValue(value: StoredValue): NativeValue {
  if (Array.isArray(value)) return value.map(decodeValue);
  const record = v.safeParse(StoredRecordSchema, value);

  if (!record.success) return value;
  const binary = v.safeParse(BinaryEnvelopeSchema, record.output);

  if (binary.success) {
    const bytes = base64ToBytes(binary.output.$binary);

    if (bytes.byteLength !== binary.output.bytes) {
      throw new KinuError('io',
        `a stored message payload is truncated: ${bytes.byteLength} of ${binary.output.bytes} bytes decoded`);
    }

    if (binary.output.buffer !== true) return bytes;
    // A fresh buffer rather than `bytes.buffer`: the view's backing store is
    // typed `ArrayBufferLike`, and a copy states the exact type the source had
    // without an assertion about which kind of buffer it is.
    const restored = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(restored).set(bytes);

    return restored;
  }

  const url = v.safeParse(UrlEnvelopeSchema, record.output);

  if (url.success) return new URL(url.output.$url);
  const plain = v.safeParse(PlainEnvelopeSchema, record.output);
  const inner = plain.success ? plain.output.$plain : record.output;
  const mapped: Record<string, NativeValue> = {};

  for (const key of Object.keys(inner)) {
    const item = inner[key];

    if (item !== undefined) mapped[key] = decodeValue(item);
  }

  return mapped;
}

/** Validate one message through the SDK's own schema. The single narrowing in
 *  this module, and it runs on BOTH directions: a message that does not parse
 *  is refused at the WRITE, so a stored revision is always a request a provider
 *  could be handed, and refused at the READ, so a corrupt row is named. */
function validated(message: NativeValue, position: number): ModelMessage {
  const parsed = modelMessageSchema.safeParse(message);

  if (!parsed.success) {
    throw new KinuError('bad_input', `message ${position} is not a model message the SDK accepts`);
  }

  return parsed.data;
}

/** One message as the native walk sees it: the SDK's own parse, then this
 *  module's value domain. Two schemas rather than one assertion — the SDK owns
 *  what a message IS, and `NativeValueSchema` owns what this codec can carry. */
function nativeMessage(message: NativeValue, position: number): NativeValue {
  return v.parse(NativeValueSchema, validated(message, position));
}

/** The durable form of a step's message array. */
export function encodeModelMessages(messages: readonly ModelMessage[]): string {
  return JSON.stringify(messages.map((message, index) =>
    encodeValue(nativeMessage(v.parse(NativeValueSchema, message), index))));
}

/** The array a stored revision holds, as native SDK messages — byte-identical
 *  attachments included. */
export function decodeModelMessages(payload: string): ModelMessage[] {
  const parsed = v.safeParse(v.array(StoredValueSchema), JSON.parse(payload));

  if (!parsed.success) throw new KinuError('io', 'a stored message payload is not a JSON message array');

  return parsed.output.map((message, index) => validated(decodeValue(message), index));
}

/** The identity of one encoded revision. Over the ENCODED bytes rather than the
 *  live array: two revisions with the same digest decode to the same messages,
 *  and a digest over a live object would depend on key order nobody controls. */
export function modelMessagesDigest(encoded: string): string {
  return sha256Hex(encoded);
}
