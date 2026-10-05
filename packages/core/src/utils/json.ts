import { Effect } from 'effect';
import * as v from 'valibot';
import { classify, renderThrownChain, settleSync } from '../obs/index';

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

/** No walk, no copy: JSON by construction. */
export function readJsonObjectText(text: string): JsonObject | null {
  const value: JsonValue = JSON.parse(text);

  return isParsedJsonObject(value) ? value : null;
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

/** `JSON.parse` output is JSON by construction: no walk. */
export function parseJsonValue(text: string): JsonValue {
  const value: JsonValue = JSON.parse(text);

  return value;
}

const ParsedObjectSchema = v.custom<JsonObject>((value) => !Array.isArray(value) && v.is(BoundaryObjectSchema, value), 'Invalid type: Expected Object');

const ParsedArraySchema = v.custom<JsonValue[]>(Array.isArray, 'Invalid type: Expected Array');

/** Text that is not JSON reads back as itself; any other failure throws. */
export function jsonText(text: string, unreadable: string): Effect.Effect<JsonValue> {
  return Effect.try({ try: () => v.parse(JsonValueSchema, JSON.parse(text)), catch: (cause) => ({ cause }) }).pipe(
    Effect.catch((failed) => Effect.die(new Error(unreadable, { cause: failed.cause }))),
  );
}

export function safeJsonParse(text: string): JsonValue {
  return settleSync(Effect.try({ try: () => parseJsonValue(text), catch: (cause) => ({ cause }) }).pipe(
    Effect.catchIf((failed) => classify(failed) === 'malformed-input', () => Effect.succeed<JsonValue>(text)),
    Effect.catch((failed) => Effect.die(failed.cause)),
  ));
}

/** Checks the top level only; the members are JSON by construction. */
export function parseJsonObject(text: string): JsonObject {
  return v.parse(ParsedObjectSchema, parseJsonValue(text));
}

export function parseJsonArray(text: string): JsonValue[] {
  return v.parse(ParsedArraySchema, parseJsonValue(text));
}

export function decodeJsonValue(input: { value: unknown }): JsonValue {
  return v.parse(JsonValueSchema, input.value);
}

export async function jsonResultOrVoid<Result>(result: Promise<Result>): Promise<JsonValue | undefined> {
  const value = await result;

  return value === undefined ? undefined : decodeJsonValue({ value });
}

export function assertJsonValue(
  input: { value: unknown },
): asserts input is { value: JsonValue } {
  v.parse(JsonValueSchema, input.value);
}

/** Omits `undefined` properties, maps `undefined` array elements to `null`; unrepresentable values still throw. */
export function projectJsonValue(input: { value: unknown }): JsonValue {
  return settleSync(projected(input));
}

function projected(input: { value: unknown }): Effect.Effect<JsonValue> {
  const checked = { value: input.value };

  return Effect.try({ try: (): JsonValue => {
    assertJsonValue(checked);

    return checked.value;
  }, catch: (cause) => ({ cause }) }).pipe(
    Effect.matchEffect({ onSuccess: Effect.succeed, onFailure: (failed): Effect.Effect<JsonValue> => {
      const array = v.safeParse(BoundaryArraySchema, input.value);

      if (array.success) {
        return Effect.forEach(array.output, (item) => (v.safeParse(UndefinedSchema, item).success ? Effect.succeed(null) : projected({ value: item })));
      }

      const object = v.safeParse(BoundaryObjectSchema, input.value);

      if (!object.success) return Effect.die(failed.cause);

      return Effect.gen(function* () {
        const result: JsonObject = {};

        for (const [key, item] of Object.entries(object.output)) {
          if (v.safeParse(UndefinedSchema, item).success) continue;
          result[key] = yield* projected({ value: item });
        }

        return result;
      });
    } }),
  );
}

/** One truncation limit so durable records of the same call agree. */
const DIGEST_LIMIT = 800;

/** Bounded projection for durable records; oversized values degrade to a truncated JSON string ending in `…`. */
export function digestJsonValue(input: { value: unknown }): JsonValue | undefined {
  const absent = v.safeParse(v.union([v.null(), UndefinedSchema]), input.value);

  if (absent.success) return absent.output;
  const text = v.safeParse(v.string(), input.value);

  if (text.success) {
    return text.output.length > DIGEST_LIMIT ? text.output.slice(0, DIGEST_LIMIT) + '...' : text.output;
  }

  return settleSync(Effect.try({
    try: (): JsonValue => {
      const json = projectJsonValue(input);
      const serialized = JSON.stringify(json);

      return serialized.length <= DIGEST_LIMIT ? json : serialized.slice(0, DIGEST_LIMIT) + '...';
    },
    catch: (cause) => ({ cause }),
  }).pipe(
    // `String()` would give "[object Object]"; the reason takes its place.
    Effect.catch((failed) => Effect.succeed(`unserializable digest input: ${renderThrownChain(failed)}`.slice(0, DIGEST_LIMIT))),
  ));
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
