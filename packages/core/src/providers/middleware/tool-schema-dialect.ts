/**
 * Tool input schemas as the serving model takes them. `@ai-sdk/anthropic` and `@ai-sdk/openai-compatible` send a
 * schema verbatim, and no `@ai-sdk/google` converts one here: Gemini is reached through OpenAI-compatible routes.
 * - Every model: a root union becomes one object root (Anthropic: "input_schema does not support oneOf, allOf, or
 *   anyOf at the top level"); a boolean subschema becomes `{}` or drops its property.
 * - Gemini: its OpenAPI subset, so no `$schema` (`Invalid JSON payload received. Unknown name "$schema"`), `const` as
 *   `enum`, and a `null` member as `nullable`.
 */
import type { LanguageModelMiddleware } from 'ai';
import type { JSONSchema7, LanguageModelV4 } from '@ai-sdk/provider';
import * as v from 'valibot';
import { JsonObjectSchema, type JsonObject, type JsonValue } from '../../utils/json';

const GeminiSchemaKeySchema = v.picklist([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'maxItems', 'minItems', 'properties', 'required',
  'minProperties', 'maxProperties', 'minLength', 'maxLength', 'pattern', 'example', 'anyOf', 'propertyOrdering',
  'default', 'items', 'minimum', 'maximum',
]);

const SubschemaKeySchema = v.picklist([
  'items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames',
  'unevaluatedProperties', 'unevaluatedItems', 'additionalItems',
]);

const SubschemaListKeySchema = v.picklist(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

const SubschemaMapKeySchema = v.picklist(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

const JsonListSchema = v.array(v.unknown());

const COMBINERS = ['anyOf', 'oneOf', 'allOf'] as const;

const StringListSchema = v.array(v.string());

/** Keyed by the schema the SDK sends: a `jsonSchema()` tool sends the same object on every call. */
const fittedForAny = new WeakMap<JSONSchema7, JSONSchema7>();

const fittedForGemini = new WeakMap<JSONSchema7, JSONSchema7>();

/** Gemini by its route (`google`, `google-vertex`) or by its id through a gateway (`google/gemini-2.5-pro`). */
function servesGemini(model: LanguageModelV4): boolean {
  const [route = ''] = model.provider.toLowerCase().split('.');

  return route === 'google' || route.startsWith('google-') || model.modelId.toLowerCase().includes('gemini');
}

function flattenRoot(schema: JsonObject): JsonObject {
  const combiner = COMBINERS.find((key) => v.is(v.array(v.unknown()), schema[key]));

  if (combiner === undefined) return schema;
  const branches = v.parse(v.array(v.unknown()), schema[combiner]).filter((branch) => v.is(JsonObjectSchema, branch));
  const definitions = new Map<string, JsonValue[]>();
  const requiredSets = branches.map((branch) => new Set(v.is(StringListSchema, branch.required) ? branch.required : []));

  for (const branch of branches) {
    if (!v.is(JsonObjectSchema, branch.properties)) continue;

    for (const [name, property] of Object.entries(branch.properties)) definitions.set(name, [...(definitions.get(name) ?? []), property]);
  }

  const properties: JsonObject = Object.fromEntries([...definitions].map(([name, found]) => [name, mergeBranchDefinitions(found)]));

  const required = Object.keys(properties).filter((name) => (combiner === 'allOf'
    ? requiredSets.some((set) => set.has(name))
    : requiredSets.length > 0 && requiredSets.every((set) => set.has(name))));

  const rest = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== combiner));

  if (v.is(JsonObjectSchema, rest.properties)) Object.assign(properties, rest.properties);
  const rootRequired = v.is(StringListSchema, rest.required) ? rest.required : [];

  return { ...rest, type: 'object', properties, required: [...new Set([...required, ...rootRequired])] };
}

function mergeBranchDefinitions(found: readonly JsonValue[]): JsonValue {
  const distinct = uniqueJson(found);

  if (distinct.length === 1) return distinct[0] ?? {};

  if (distinct.some((definition) => definition === true || (v.is(JsonObjectSchema, definition) && Object.keys(definition).length === 0))) return {};
  const valueSets = distinct.map(allowedValues);

  if (!valueSets.every((values) => values !== null)) return { anyOf: [...distinct] };
  const [first, ...others] = distinct.filter((definition) => v.is(JsonObjectSchema, definition));

  const shared = Object.entries(first ?? {}).filter(([key, value]) => key !== 'const' && key !== 'enum'
    && others.every((other) => JSON.stringify(other[key]) === JSON.stringify(value)));

  return { ...Object.fromEntries(shared), enum: uniqueJson(valueSets.flat()) };
}

function allowedValues(definition: JsonValue): JsonValue[] | null {
  if (!v.is(JsonObjectSchema, definition) || v.is(JsonListSchema, definition)) return null;

  if ('const' in definition) return [definition.const ?? null];

  return v.is(JsonListSchema, definition.enum) ? definition.enum : null;
}

function uniqueJson(values: readonly JsonValue[]): JsonValue[] {
  return values.filter((value, index) => values.findIndex((other) => JSON.stringify(other) === JSON.stringify(value)) === index);
}

function normalizeNode(node: JsonObject, gemini: boolean): JsonObject {
  const out: JsonObject = {};

  for (const [key, value] of Object.entries(node)) out[key] = normalizeKeyword(key, value, gemini);

  if (v.is(JsonObjectSchema, node.properties) && v.is(StringListSchema, node.required)) {
    const kept = v.parse(JsonObjectSchema, out.properties);
    out.required = node.required.filter((name) => name in kept);
  }

  return gemini ? geminiNode(out) : out;
}

function normalizeKeyword(key: string, value: JsonValue, gemini: boolean): JsonValue {
  const list = v.is(JsonListSchema, value);

  if (v.is(SubschemaMapKeySchema, key) && !list && v.is(JsonObjectSchema, value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, subschema]) => key !== 'properties' || subschema !== false)
      .map(([name, subschema]) => [name, normalizeSchema(subschema, gemini)]));
  }

  if ((v.is(SubschemaListKeySchema, key) || v.is(SubschemaKeySchema, key)) && list) {
    return value.map((subschema) => normalizeSchema(subschema, gemini));
  }

  return v.is(SubschemaKeySchema, key) ? normalizeSchema(value, gemini) : value;
}

function normalizeSchema(value: JsonValue, gemini: boolean): JsonValue {
  if (value === true) return {};

  return v.is(JsonObjectSchema, value) && !v.is(JsonListSchema, value) ? normalizeNode(value, gemini) : value;
}

function geminiNode(node: JsonObject): JsonObject {
  const out: JsonObject = {};

  for (const [key, value] of Object.entries(node)) {
    if (key === 'const') {
      if (v.is(v.string(), value)) out.enum = [value];
      continue;
    }

    if (key === 'oneOf' || key === 'anyOf') {
      Object.assign(out, geminiUnion(value));
      continue;
    }

    if (key === 'type' && v.is(StringListSchema, value)) {
      out.type = value.find((type) => type !== 'null') ?? 'string';

      if (value.includes('null')) out.nullable = true;
      continue;
    }

    if (v.is(GeminiSchemaKeySchema, key)) out[key] = value;
  }

  return out;
}

/** A union with a `null` member (zod's nullable) is Gemini's `nullable` on the rest. */
function geminiUnion(value: JsonValue): JsonObject {
  if (!v.is(JsonListSchema, value)) return { anyOf: value };
  const rest = value.filter((member) => !v.is(v.object({ type: v.literal('null') }), member));

  if (rest.length === value.length) return { anyOf: value };
  const [only] = rest;

  return rest.length === 1 && v.is(JsonObjectSchema, only) && !v.is(JsonListSchema, only)
    ? { ...only, nullable: true }
    : { anyOf: rest, nullable: true };
}

/** `schema` as `gemini` (or any other model) takes it: an object root, its properties always listed. */
export function fitToolSchema(schema: JSONSchema7, gemini: boolean): JSONSchema7 {
  const fitted = gemini ? fittedForGemini : fittedForAny;
  const known = fitted.get(schema);

  if (known !== undefined) return known;
  const root = normalizeNode(flattenRoot(v.parse(JsonObjectSchema, schema)), gemini);
  const fit: JsonObject = { ...root, type: 'object', properties: v.is(JsonObjectSchema, root.properties) ? root.properties : {} };

  fitted.set(schema, fit);

  return fit;
}

export const toolSchemaDialect: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  transformParams: async ({ params, model }) => {
    if (params.tools === undefined) return params;
    const gemini = servesGemini(model);

    return {
      ...params,
      tools: params.tools.map((tool) => (tool.type === 'function' ? { ...tool, inputSchema: fitToolSchema(tool.inputSchema, gemini) } : tool)),
    };
  },
};
