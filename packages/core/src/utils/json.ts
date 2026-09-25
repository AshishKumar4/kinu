import * as v from 'valibot';
import { classify, renderThrownChain } from '../obs/index';

export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  [key: string]: JsonValue;
}

/** An interface, not `JsonValue[]`: workers-types' `Serializable<T>` on a typed DO stub hits TS2589 on alias recursion. */
export interface JsonArray extends Array<JsonValue> {}

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

const StringSchema = v.string();

const NumberSchema = v.number();

const BooleanSchema = v.boolean();

/** Walks the value: a JSON-typed value can still hold `undefined` members. */
export function isJsonObject(value: JsonValue): value is JsonObject {
  return !Array.isArray(value) && v.is(JsonObjectSchema, value);
}

/** One-step check; only for values JSON by construction. Otherwise use {@link isJsonObject}. */
export function isParsedJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && !Array.isArray(value)
    && !v.is(StringSchema, value) && !v.is(NumberSchema, value) && !v.is(BooleanSchema, value);
}

/** The elements of a parsed JSON array of objects; null when it is not one. */
export function jsonObjectElements(value: JsonValue | undefined): JsonObject[] | null {
  if (value === undefined || !Array.isArray(value)) return null;
  const objects = value.filter(isParsedJsonObject);

  return objects.length === value.length ? objects : null;
}

export const JsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() => JsonValueOptions);

const JsonValueOptions: v.GenericSchema<JsonValue> = v.union([
  StringSchema,
  v.pipe(NumberSchema, v.finite()),
  BooleanSchema,
  v.null(),
  v.array(JsonValueSchema),
  v.record(StringSchema, JsonValueSchema),
]);

export const JsonObjectSchema = v.record(StringSchema, JsonValueSchema);

export const JsonArraySchema = v.array(JsonValueSchema);

const UndefinedSchema = v.undefined();

const BoundaryArraySchema = v.array(v.unknown());

const BoundaryObjectSchema = v.record(v.string(), v.unknown());

export function parseJsonValue(text: string): JsonValue {
  return v.parse(JsonValueSchema, JSON.parse(text));
}

/** Text that is not JSON reads back as itself; any other failure throws. */
export function safeJsonParse(text: string): JsonValue {
  try { return parseJsonValue(text); }
  catch (error) {
    if (classify({ cause: error }) !== 'malformed-input') throw error;

    return text;
  }
}

export function parseJsonObject(text: string): JsonObject {
  return v.parse(JsonObjectSchema, JSON.parse(text));
}

export function parseJsonArray(text: string): JsonValue[] {
  return v.parse(JsonArraySchema, JSON.parse(text));
}

export function decodeJsonValue(input: { value: unknown }): JsonValue {
  return v.parse(JsonValueSchema, input.value);
}

export function assertJsonValue(
  input: { value: unknown },
): asserts input is { value: JsonValue } {
  v.parse(JsonValueSchema, input.value);
}

/** Omits `undefined` properties, maps `undefined` array elements to `null`; unrepresentable values still throw. */
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

/** One truncation limit so durable records of the same call agree. */
const DIGEST_LIMIT = 800;

/** Bounded projection for durable records; oversized values degrade to a truncated JSON string ending in `…`. */
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
  } catch (error) {
    // `String()` would give "[object Object]"; the reason takes its place.
    return `unserializable digest input: ${renderThrownChain({ cause: error })}`.slice(0, DIGEST_LIMIT);
  }
}

/** A valibot failure as one line, `path: message` per issue. */
export function renderIssues(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues
    .map((issue) => {
      const path = issue.path?.map((segment) => String(segment.key)).join('.');

      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/** Trimmed non-empty text, or undefined. */
export function nonEmptyString(input: { value: unknown }): string | undefined {
  const parsed = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), input.value);

  return parsed.success ? parsed.output : undefined;
}
