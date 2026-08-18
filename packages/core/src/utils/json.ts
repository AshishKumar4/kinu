import * as v from 'valibot';

export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export function isJsonObject(value: JsonValue): value is JsonObject {
  return !Array.isArray(value) && v.is(JsonObjectSchema, value);
}

export const JsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() => v.union([
  v.string(),
  v.number(),
  v.boolean(),
  v.null(),
  v.array(JsonValueSchema),
  v.record(v.string(), JsonValueSchema),
]));

export const JsonObjectSchema = v.record(v.string(), JsonValueSchema);
export const JsonArraySchema = v.array(JsonValueSchema);
const UndefinedSchema = v.undefined();
const BoundaryArraySchema = v.array(v.unknown());
const BoundaryObjectSchema = v.record(v.string(), v.unknown());

/** Parse serialized JSON and establish its recursive value contract. */
export function parseJsonValue(text: string): JsonValue {
  return v.parse(JsonValueSchema, JSON.parse(text));
}

/** Parse serialized JSON whose root must be an object. */
export function parseJsonObject(text: string): JsonObject {
  return v.parse(JsonObjectSchema, JSON.parse(text));
}

/** Parse serialized JSON whose root must be an array. */
export function parseJsonArray(text: string): JsonValue[] {
  return v.parse(JsonArraySchema, JSON.parse(text));
}

/** Validate an already-decoded boundary value before durable storage. */
export function decodeJsonValue(input: { value: unknown }): JsonValue {
  return v.parse(JsonValueSchema, input.value);
}

/** Validate a decoded boundary value without replacing the original value. */
export function assertJsonValue(
  input: { value: unknown },
): asserts input is { value: JsonValue } {
  v.parse(JsonValueSchema, input.value);
}

/**
 * Project an SDK/library value onto the JSON wire contract. Optional object
 * properties with an explicit `undefined` are omitted; an undefined array
 * element becomes `null`, matching JSON's positional semantics. Values that
 * JSON cannot represent still fail validation instead of being stringified or
 * silently coerced. Already-valid values retain their original identity.
 */
export function projectJsonValue(input: { value: unknown }): JsonValue {
  try {
    assertJsonValue(input);
    return input.value;
  } catch (validationError) {
    const array = v.safeParse(BoundaryArraySchema, input.value);
    if (array.success) {
      return array.output.map((value) =>
        v.safeParse(UndefinedSchema, value).success
          ? null
          : projectJsonValue({ value }));
    }

    const object = v.safeParse(BoundaryObjectSchema, input.value);
    if (object.success) {
      const projected: JsonObject = {};
      for (const [key, value] of Object.entries(object.output)) {
        if (v.safeParse(UndefinedSchema, value).success) continue;
        projected[key] = projectJsonValue({ value });
      }
      return projected;
    }

    throw validationError;
  }
}

/**
 * How much of a digested value survives. One number, because two truncation
 * limits on the same kind of payload would make two durable records of the
 * same call disagree about what the call was.
 */
export const DIGEST_LIMIT = 800;

/**
 * A bounded projection of an SDK value, for durable records that must describe
 * a call without storing it. A tool's arguments and a step's tool trace are the
 * two payloads that carry unbounded content — a `write` body, a crafted tool's
 * source — and a ledger that stored them whole would grow with the content the
 * turn moved rather than with what it did.
 *
 * Structure is preserved when it fits, which is the common case and the one
 * that matters: a dispatcher call is a handful of short scalars, so it stays a
 * queryable object. Only an oversized value degrades to a truncated JSON
 * string, and it degrades visibly — the trailing ellipsis is the record saying
 * it is a digest, so a reader never mistakes it for the whole argument.
 */
export function digestJsonValue(input: { value: unknown }): JsonValue | undefined {
  const absent = v.safeParse(v.union([v.null(), UndefinedSchema]), input.value);
  if (absent.success) return absent.output;
  const text = v.safeParse(v.string(), input.value);
  if (text.success) {
    return text.output.length > DIGEST_LIMIT ? text.output.slice(0, DIGEST_LIMIT) + '…' : text.output;
  }
  try {
    const projected = projectJsonValue(input);
    const serialized = JSON.stringify(projected);
    return serialized.length <= DIGEST_LIMIT ? projected : serialized.slice(0, DIGEST_LIMIT) + '…';
  } catch { return String(input.value).slice(0, DIGEST_LIMIT); }
}
