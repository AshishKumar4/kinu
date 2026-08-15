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
