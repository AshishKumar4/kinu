// Lossless codec for native model messages. A decoded message is confirmed by the SDK's `modelMessageSchema`: a row
// outlives the code that wrote it, and a message crosses isolates as JSON. An encoded one is this isolate's own typed
// value and is not walked again. Not `JSON.stringify`: it turns `Uint8Array`/`ArrayBuffer`/`URL` into different values, and a
// context revision must round-trip exactly. The compaction `binaryReplacer` is preview-only.

import { Effect } from 'effect';
import { settleSync } from '../obs/effect';
import { modelMessageSchema, type ModelMessage } from 'ai';
import { isParsedJsonObject, type JsonObject, type JsonValue } from '../utils/json';
import * as v from 'valibot';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import { KinuError } from '../obs/error';

export type NativeValue =
  | string | number | boolean | null | undefined
  | Uint8Array | ArrayBuffer | URL
  | readonly NativeValue[]
  | { readonly [key: string]: NativeValue };

export type StoredValue = JsonValue;

/** What the codec carries, confirmed by one walk that allocates nothing: a union schema here recorded an issue for
 *  every option a node failed, on every write of every message (the heap gate's largest Kinu churn, 2026-10-07). */
const NativeValueSchema = v.custom<NativeValue>(function native(input): boolean {
  if (input === null || input === undefined || typeof input === 'string' || typeof input === 'boolean') return true;

  if (typeof input === 'number') return Number.isFinite(input);

  if (input instanceof Uint8Array || input instanceof ArrayBuffer || input instanceof URL) return true;

  if (Array.isArray(input)) return input.every(native);

  return typeof input === 'object' && Object.values(input).every(native);
});

/** `bytes` lets the decoder detect truncation; `buffer` restores an `ArrayBuffer` source type. */
const BinaryEnvelopeSchema = v.object({
  $binary: v.string(),
  bytes: v.number(),
  buffer: v.optional(v.literal(true)),
});

const UrlEnvelopeSchema = v.object({ $url: v.string() });

/** Defined, not assigned: a key named `__proto__` stays data and never sets the prototype. */
function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  if (key === '__proto__') Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  else target[key] = value;
}

function isNativeArray(value: NativeValue): value is readonly NativeValue[] {
  return Array.isArray(value);
}

function encodeValue(value: NativeValue): StoredValue {
  if (value instanceof Uint8Array) return { $binary: bytesToBase64(value), bytes: value.byteLength };

  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value);

    return { $binary: bytesToBase64(bytes), bytes: bytes.byteLength, buffer: true };
  }

  if (value === undefined) return null;

  if (value instanceof URL) return { $url: value.href };

  if (isNativeArray(value)) return value.map(encodeValue);

  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;

  // Built in place: entry pairs for `fromEntries` cost every key of every message two arrays on each write.
  const mapped: Record<string, StoredValue> = {};
  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const item = value[key];

    if (item !== undefined) setOwn(mapped, key, encodeValue(item));
  }

  // A source object carrying a reserved key is wrapped, so the codec is total.
  return reserved(value) ? { $plain: mapped } : mapped;
}

interface Truncation { readonly decoded: number; readonly declared: number }

/** The first truncation ends the walk and refuses the message. */
function decodeValue(value: StoredValue, truncated: Truncation[]): NativeValue {
  if (truncated.length > 0) return null;

  if (Array.isArray(value)) return value.map((item) => decodeValue(item, truncated));

  if (!isParsedJsonObject(value)) return value;
  const binary = Object.hasOwn(value, '$binary') ? v.safeParse(BinaryEnvelopeSchema, value) : null;

  if (binary?.success === true) {
    const bytes = base64ToBytes(binary.output.$binary);

    if (bytes.byteLength !== binary.output.bytes) truncated.push({ decoded: bytes.byteLength, declared: binary.output.bytes });

    if (binary.output.buffer !== true) return bytes;
    const restored = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(restored).set(bytes);

    return restored;
  }

  const url = Object.hasOwn(value, '$url') ? v.safeParse(UrlEnvelopeSchema, value) : null;

  if (url?.success === true) return new URL(url.output.$url);
  const plain = value.$plain;
  const inner = plain !== undefined && isParsedJsonObject(plain) ? plain : value;
  const object: Record<string, NativeValue> = {};
  const keys = Object.keys(inner);

  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const item = inner[key];

    if (item !== undefined) setOwn(object, key, decodeValue(item, truncated));
  }

  return object;
}

function validated(message: NativeValue, position: number): Effect.Effect<ModelMessage, KinuError> {
  const parsed = modelMessageSchema.safeParse(message);

  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(new KinuError('bad_input', `message ${position} is not a model message the SDK accepts`));
}

function encoded(message: ModelMessage): StoredValue {
  return encodeValue(v.parse(NativeValueSchema, message));
}

function decoded(value: StoredValue, position: number): Effect.Effect<ModelMessage, KinuError> {
  const truncated: Truncation[] = [];
  const native = decodeValue(value, truncated);
  const short = truncated[0];

  return short === undefined
    ? validated(native, position)
    : Effect.fail(new KinuError('io', `a stored message payload is truncated: ${short.decoded} of ${short.declared} bytes decoded`));
}

export function encodeModelMessageValues(messages: readonly ModelMessage[]): JsonValue[] {
  return messages.map(encoded);
}

type NativeObject = { readonly [key: string]: NativeValue };

function isNativeObject(value: NativeValue): value is NativeObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && !(value instanceof Uint8Array) && !(value instanceof ArrayBuffer) && !(value instanceof URL);
}

function reserved(value: NativeObject): boolean {
  return Object.hasOwn(value, '$binary') || Object.hasOwn(value, '$url') || Object.hasOwn(value, '$plain');
}

/** Whether `recorded` stores every part of `message`, in order, under the same role and envelope. Compared in place:
 *  encoding and serializing both cost each sealed step four copies of its output. */
export function recordCarries(recorded: ModelMessage, message: ModelMessage): boolean {
  const record = v.parse(NativeValueSchema, recorded);
  const wanted = v.parse(NativeValueSchema, message);

  if (!isNativeObject(record) || !isNativeObject(wanted)) return false;

  // A root with a reserved key stores whole, wrapped, so only the whole message compares.
  if (reserved(record) || reserved(wanted)) return sameStoredValue(record, wanted);
  const { content: recordedContent, ...recordedEnvelope } = record;
  const { content: wantedContent, ...wantedEnvelope } = wanted;

  if (!sameStoredValue(recordedEnvelope, wantedEnvelope)) return false;

  if (!isNativeArray(recordedContent) || !isNativeArray(wantedContent)) return sameStoredValue(recordedContent, wantedContent);

  // An undefined part stores as null; a sparse slot, as the encoding's own list kept it, matches only another.
  const carried = (at: number, index: number): boolean => (at in recordedContent) === (index in wantedContent)
    && (!(at in recordedContent) || sameStoredValue(recordedContent[at] ?? null, wantedContent[index] ?? null));

  let at = 0;

  for (let index = 0; index < wantedContent.length; index++) {
    while (at < recordedContent.length && !carried(at, index)) at += 1;

    if (at === recordedContent.length) return false;
    at += 1;
  }

  return true;
}

/** Whether two values store as the same JSON, read without encoding either: a key whose value is undefined is absent,
 *  as an undefined item is null; bytes compare by content, a URL by its href. */
function sameStoredValue(left: NativeValue, right: NativeValue): boolean {
  if (left === right) return true;

  if (left instanceof Uint8Array || right instanceof Uint8Array) return left instanceof Uint8Array && right instanceof Uint8Array && sameBytes(left, right);

  if (left instanceof ArrayBuffer || right instanceof ArrayBuffer) {
    return left instanceof ArrayBuffer && right instanceof ArrayBuffer && sameBytes(new Uint8Array(left), new Uint8Array(right));
  }

  if (left instanceof URL || right instanceof URL) return left instanceof URL && right instanceof URL && left.href === right.href;

  if (isNativeArray(left) || isNativeArray(right)) {
    if (!isNativeArray(left) || !isNativeArray(right) || left.length !== right.length) return false;

    for (let index = 0; index < left.length; index++) {
      if (!sameStoredValue(left[index] ?? null, right[index] ?? null)) return false;
    }

    return true;
  }

  return isNativeObject(left) && isNativeObject(right) && reserved(left) === reserved(right) && sameEntries(left, right);
}

/** The defined entries of both, in order: serialized JSON compares key order too. */
function sameEntries(left: NativeObject, right: NativeObject): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  let at = 0;

  for (let index = 0; index < leftKeys.length; index++) {
    const value = left[leftKeys[index]];

    if (value === undefined) continue;

    while (at < rightKeys.length && right[rightKeys[at]] === undefined) at += 1;

    if (at === rightKeys.length || rightKeys[at] !== leftKeys[index] || !sameStoredValue(value, right[rightKeys[at]])) return false;
    at += 1;
  }

  while (at < rightKeys.length && right[rightKeys[at]] === undefined) at += 1;

  return at === rightKeys.length;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;

  for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;

  return true;
}

export function encodeModelMessage(message: ModelMessage): JsonObject {
  const value = encoded(message);

  return settleSync(isParsedJsonObject(value)
    ? Effect.succeed(value)
    : Effect.fail(new KinuError('bad_input', 'a native message did not encode to an object')));
}

export function decodeModelMessageValues(values: readonly JsonValue[]): ModelMessage[] {
  return settleSync(Effect.forEach(values, decoded));
}

const OwnModelMessageSchema = v.custom<ModelMessage>((input) => v.is(v.object({ role: v.picklist(['system', 'user', 'assistant', 'tool']) }), input));

/** A message this isolate assembled from parts the SDK already typed: decoded, and not walked by its schema again. */
export function decodeOwnModelMessage(value: JsonObject): ModelMessage {
  return v.parse(OwnModelMessageSchema, decodeValue(value, []));
}
