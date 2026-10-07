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

// Source objects carrying a reserved key are wrapped in `{ $plain: … }` so the codec is total.
const RESERVED = ['$binary', '$url', '$plain'] as const;

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

  // fromEntries defines each key, so a key named `__proto__` stays data and never sets the prototype.
  const mapped: Record<string, StoredValue> = Object.fromEntries(Object.keys(value).flatMap((key) => {
    const item = value[key];

    return item === undefined ? [] : [[key, encodeValue(item)]];
  }));

  return RESERVED.some((key) => Object.hasOwn(value, key)) ? { $plain: mapped } : mapped;
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

  return Object.fromEntries(Object.keys(inner).flatMap((key) => {
    const item = inner[key];

    return item === undefined ? [] : [[key, decodeValue(item, truncated)]];
  }));
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

export function encodeModelMessage(message: ModelMessage): JsonObject {
  const value = encoded(message);

  return settleSync(isParsedJsonObject(value)
    ? Effect.succeed(value)
    : Effect.fail(new KinuError('bad_input', 'a native message did not encode to an object')));
}

export function decodeModelMessageValues(values: readonly JsonValue[]): ModelMessage[] {
  return settleSync(Effect.forEach(values, decoded));
}
