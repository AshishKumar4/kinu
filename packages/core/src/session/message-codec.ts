// Lossless codec for native model messages, validated by the SDK's `modelMessageSchema`.
// Not `JSON.stringify`: it turns `Uint8Array`/`ArrayBuffer`/`URL` into different values, and a
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

const NativeValueSchema: v.GenericSchema<NativeValue> = v.lazy(() => NativeValueOptions);

const NativeValueOptions: v.GenericSchema<NativeValue> = v.union([
  v.string(), v.pipe(v.number(), v.finite()), v.boolean(), v.null(), v.undefined(),
  v.instance(Uint8Array), v.instance(ArrayBuffer), v.instance(URL),
  v.array(NativeValueSchema),
  v.record(v.string(), NativeValueSchema),
]);

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

/** Runs on write and read: stored revisions are always valid requests; corrupt rows are named. */
function validated(message: NativeValue | ModelMessage, position: number): Effect.Effect<ModelMessage, KinuError> {
  const parsed = modelMessageSchema.safeParse(message);

  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(new KinuError('bad_input', `message ${position} is not a model message the SDK accepts`));
}

function encoded(message: ModelMessage, position: number): Effect.Effect<StoredValue, KinuError> {
  return Effect.map(validated(message, position), (valid) => encodeValue(v.parse(NativeValueSchema, valid)));
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
  return settleSync(Effect.forEach(messages, encoded));
}

export function encodeModelMessage(message: ModelMessage): JsonObject {
  return settleSync(Effect.flatMap(encoded(message, 0), (value) => (isParsedJsonObject(value)
    ? Effect.succeed(value)
    : Effect.fail(new KinuError('bad_input', 'a native message did not encode to an object')))));
}

export function decodeModelMessageValues(values: readonly JsonValue[]): ModelMessage[] {
  return settleSync(Effect.forEach(values, decoded));
}
