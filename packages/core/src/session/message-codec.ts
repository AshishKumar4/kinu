// Lossless codec for native model messages, validated by the SDK's `modelMessageSchema`.
// Not `JSON.stringify`: it turns `Uint8Array`/`ArrayBuffer`/`URL` into different values, and a
// context revision must round-trip exactly. The compaction `binaryReplacer` is preview-only.

import { modelMessageSchema, type ModelMessage } from 'ai';
import { JsonValueSchema, isParsedJsonObject, type JsonObject, type JsonValue } from '../utils/json';
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
  v.string(), v.number(), v.boolean(), v.null(), v.undefined(),
  v.instance(Uint8Array), v.instance(ArrayBuffer), v.instance(URL),
  v.array(NativeValueSchema),
  v.record(v.string(), NativeValueSchema),
]);

const NativeScalarSchema = v.union([v.string(), v.number(), v.boolean(), v.null()]);

const StoredValueSchema: v.GenericSchema<StoredValue> = JsonValueSchema;

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

  // Non-finite numbers are refused, as the stored schema refuses them.
  if (v.is(NativeScalarSchema, value)) return v.parse(StoredValueSchema, value);
  const mapped: Record<string, StoredValue> = {};

  for (const key of Object.keys(value)) {
    const item = value[key];

    if (item !== undefined) mapped[key] = encodeValue(item);
  }

  return RESERVED.some((key) => Object.hasOwn(value, key)) ? { $plain: mapped } : mapped;
}

function decodeValue(value: StoredValue): NativeValue {
  if (Array.isArray(value)) return value.map(decodeValue);

  if (!isParsedJsonObject(value)) return value;
  const binary = Object.hasOwn(value, '$binary') ? v.safeParse(BinaryEnvelopeSchema, value) : null;

  if (binary?.success === true) {
    const bytes = base64ToBytes(binary.output.$binary);

    if (bytes.byteLength !== binary.output.bytes) {
      throw new KinuError('io',
        `a stored message payload is truncated: ${bytes.byteLength} of ${binary.output.bytes} bytes decoded`);
    }

    if (binary.output.buffer !== true) return bytes;
    const restored = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(restored).set(bytes);

    return restored;
  }

  const url = Object.hasOwn(value, '$url') ? v.safeParse(UrlEnvelopeSchema, value) : null;

  if (url?.success === true) return new URL(url.output.$url);
  const plain = value.$plain;
  const inner = plain !== undefined && isParsedJsonObject(plain) ? plain : value;
  const mapped: Record<string, NativeValue> = {};

  for (const key of Object.keys(inner)) {
    const item = inner[key];

    if (item !== undefined) mapped[key] = decodeValue(item);
  }

  return mapped;
}

/** Runs on write and read: stored revisions are always valid requests; corrupt rows are named. */
function validated(message: NativeValue | ModelMessage, position: number): ModelMessage {
  const parsed = modelMessageSchema.safeParse(message);

  if (!parsed.success) {
    throw new KinuError('bad_input', `message ${position} is not a model message the SDK accepts`);
  }

  return parsed.data;
}

function nativeMessage(message: ModelMessage, position: number): NativeValue {
  return v.parse(NativeValueSchema, validated(message, position));
}

export function encodeModelMessageValues(messages: readonly ModelMessage[]): JsonValue[] {
  return messages.map((message, index) => encodeValue(nativeMessage(message, index)));
}

export function encodeModelMessage(message: ModelMessage): JsonObject {
  const encoded = encodeValue(nativeMessage(message, 0));

  if (!isParsedJsonObject(encoded)) throw new KinuError('bad_input', 'a native message did not encode to an object');

  return encoded;
}

export function decodeModelMessageValues(values: readonly JsonValue[]): ModelMessage[] {
  return values.map((message, index) => validated(decodeValue(message), index));
}

