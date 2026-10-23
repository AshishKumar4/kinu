import { Effect } from 'effect';
import * as v from 'valibot';
import { classify, renderThrownChain, settleSync } from '../obs/index';
import { headEnd } from './text';

export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  [key: string]: JsonValue;
}

/** An interface, not `JsonValue[]`: workers-types' `Serializable<T>` on a typed DO stub hits TS2589 on alias recursion. */
interface JsonArray extends Array<JsonValue> {}

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

const StringSchema = v.string();

/** Walks the value: a JSON-typed value can still hold `undefined` members. A value that is no object is answered before
 *  the walk, which formats an issue for each value it refuses. */
export function isJsonObject(value: JsonValue): value is JsonObject {
  return isParsedJsonObject(value) && v.is(JsonObjectSchema, value);
}

/** A JSON value that is text: asked with no schema, as a refused parse formats an issue for every value it refuses. */
export function isJsonString(value: JsonValue): value is string {
  return typeof value === 'string';
}

/** One-step check; only for values JSON by construction. Otherwise use {@link isJsonObject}. */
export function isParsedJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

/** One walk that allocates nothing for a valid value: a union recorded an issue for every option each node failed,
 *  on every stored event and message read (the heap gate's churn, 2026-10-07). */
export const JsonValueSchema = v.custom<JsonValue>(function json(input): boolean {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return true;

  if (typeof input === 'number') return Number.isFinite(input);

  if (Array.isArray(input)) return input.every(json);

  return typeof input === 'object' && Object.values(input).every(json);
}, (issue) => `Invalid JSON value: Received ${issue.received}`);

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

/** JSON text as a value; text that is not JSON dies with `unreadable`, its parse failure the cause. */
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
  // Already JSON, as nearly every value is: returned without a runner, which only a projection needs.
  if (v.is(JsonValueSchema, input.value)) return input.value;

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

/** The digest's first `DIGEST_LIMIT` units, short of a surrogate pair the limit would split. */
const digestCut = (text: string): string => text.slice(0, headEnd(text, DIGEST_LIMIT));

function bounded(json: JsonValue): JsonValue {
  const serialized = JSON.stringify(json);

  return serialized.length <= DIGEST_LIMIT ? json : digestCut(serialized) + '...';
}

/** Bounded projection for durable records; oversized values degrade to a truncated JSON string ending in `…`. */
export function digestJsonValue(input: { value: unknown }): JsonValue | undefined {
  const { value } = input;

  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return value.length > DIGEST_LIMIT ? digestCut(value) + '...' : value;

  return settleSync(Effect.try({
    try: (): JsonValue => bounded(projectJsonValue(input)),
    catch: (cause) => ({ cause }),
  }).pipe(
    // `String()` would give "[object Object]"; the reason takes its place.
    Effect.catch((failed) => Effect.succeed(digestCut(`unserializable digest input: ${renderThrownChain(failed)}`))),
  ));
}

/** The most of one path key an issue's path shows: a record's keys are the input's own text. */
const ISSUE_KEY_CHARS = 40;

/** Where an issue is, as dotted keys; '' for the input itself. */
function issuePath(issue: v.BaseIssue<unknown>): string {
  return issue.path?.map((segment) => String(segment.key).slice(0, ISSUE_KEY_CHARS)).join('.') ?? '';
}

/**
 * A valibot failure as one line without a value of its input: per issue, its path, what was expected and the type that
 * came. A valibot message quotes what it received, a string whole, and a model's refused answer rides every log line its
 * refusal crosses (a 200 KB string where a number belongs, 2026-10-20).
 */
export function renderIssuesUnquoted(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues
    .map((issue) => {
      const path = issuePath(issue);
      const check = issue.kind === 'schema' ? '' : ` (${issue.type})`;

      return `${path === '' ? 'the answer' : path}: expected ${issue.expected ?? issue.type}${check}, received ${receivedType(issue)}`;
    })
    .join('; ');
}

/** The type of what an issue received, as JSON names it. */
function receivedType(issue: v.BaseIssue<unknown>): string {
  if (issue.input === null) return 'null';

  return Array.isArray(issue.input) ? 'array' : typeof issue.input;
}

/** A valibot failure as one line, `path: message` per issue. */
export function renderIssues(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues
    .map((issue) => {
      const path = issuePath(issue);

      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

/** `input.value` as `schema` reads it, or undefined where it does not fit: a tool argument an executor's own refusal names. */
export function parseInput<TSchema extends v.GenericSchema>(schema: TSchema, input: { value: unknown }): v.InferOutput<TSchema> | undefined {
  const result = v.safeParse(schema, input.value);

  return result.success ? result.output : undefined;
}

/** Trimmed non-empty text, or undefined. */
export function nonEmptyString(input: { value: unknown }): string | undefined {
  const parsed = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), input.value);

  return parsed.success ? parsed.output : undefined;
}

/** A `JSON.stringify` replacer for previews and size estimates: a binary body becomes its size. Lossy on purpose; the
 *  lossless codec is `session/message-codec.ts`. */
export function binaryReplacer<Value>(_key: string, value: Value): Value | string {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;

  return value;
}
