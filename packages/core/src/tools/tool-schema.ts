import * as v from 'valibot';
import { asSchema, InvalidToolInputError, jsonSchema, type ToolSet } from 'ai';
import { z } from 'zod';
import { KinuError, refusedInput } from '../obs/index';
import { JsonObjectSchema, type JsonObject, type JsonValue } from '../utils/json';
import { isMcpToolKey } from './mcp-naming';

export type ToolSchemaDialect = 'openai' | 'anthropic' | 'gemini';

const GeminiSchemaKeySchema = v.picklist([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'maxItems', 'minItems', 'properties', 'required',
  'minProperties', 'maxProperties', 'minLength', 'maxLength', 'pattern', 'example', 'anyOf', 'propertyOrdering',
  'default', 'items', 'minimum', 'maximum',
]);

const MetaKeySchema = v.picklist(['$schema', '$id', '$comment']);

const SubschemaKeySchema = v.picklist([
  'items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames',
  'unevaluatedProperties', 'unevaluatedItems', 'additionalItems',
]);

const SubschemaListKeySchema = v.picklist(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

const SubschemaMapKeySchema = v.picklist(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

const JsonListSchema = v.array(v.unknown());

const COMBINERS = ['anyOf', 'oneOf', 'allOf'] as const;

const StringListSchema = v.array(v.string());

export function toolSchemaDialect(spec: string): ToolSchemaDialect {
  const [provider = '', ...rest] = spec.toLowerCase().split('/');
  const model = rest.join('/');

  if (provider === 'anthropic' || provider === 'claude' || model.startsWith('anthropic/') || model.includes('claude')) return 'anthropic';

  if (provider === 'google' || provider.startsWith('google-') || model.includes('gemini')) return 'gemini';

  return 'openai';
}

function normalizeToolInputSchema(schema: JsonObject, dialect: ToolSchemaDialect): JsonObject {
  const root = normalizeNode(flattenRoot(schema), dialect);

  return { ...root, type: 'object', properties: v.is(JsonObjectSchema, root.properties) ? root.properties : {} };
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

function normalizeNode(node: JsonObject, dialect: ToolSchemaDialect): JsonObject {
  const out: JsonObject = {};

  for (const [key, value] of Object.entries(node)) {
    if (v.is(MetaKeySchema, key)) continue;
    out[key] = normalizeKeyword(key, value, dialect);
  }

  if (v.is(JsonObjectSchema, node.properties) && v.is(StringListSchema, node.required)) {
    const kept = v.parse(JsonObjectSchema, out.properties);
    out.required = node.required.filter((name) => name in kept);
  }

  return dialect === 'gemini' ? geminiNode(out) : out;
}

function normalizeKeyword(key: string, value: JsonValue, dialect: ToolSchemaDialect): JsonValue {
  const list = v.is(JsonListSchema, value);

  if (v.is(SubschemaMapKeySchema, key) && !list && v.is(JsonObjectSchema, value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, subschema]) => key !== 'properties' || subschema !== false)
      .map(([name, subschema]) => [name, normalizeSchema(subschema, dialect)]));
  }

  if ((v.is(SubschemaListKeySchema, key) || v.is(SubschemaKeySchema, key)) && list) {
    return value.map((subschema) => normalizeSchema(subschema, dialect));
  }

  return v.is(SubschemaKeySchema, key) ? normalizeSchema(value, dialect) : value;
}

function normalizeSchema(value: JsonValue, dialect: ToolSchemaDialect): JsonValue {
  if (value === true) return {};

  return v.is(JsonObjectSchema, value) && !v.is(JsonListSchema, value) ? normalizeNode(value, dialect) : value;
}

function geminiNode(node: JsonObject): JsonObject {
  const out: JsonObject = {};

  for (const [key, value] of Object.entries(node)) {
    if (key === 'const') {
      if (v.is(v.string(), value)) out.enum = [value];
      continue;
    }

    if (key === 'oneOf') {
      out.anyOf = value;
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

const normalizedTools = new WeakMap<ToolSet[string], Map<ToolSchemaDialect, ToolSet[string]>>();

export function withToolSchemaDialect(tools: ToolSet, dialect: ToolSchemaDialect): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, entry]) => {
    if (!isMcpToolKey(name)) return [name, entry];
    const byDialect = normalizedTools.get(entry) ?? new Map<ToolSchemaDialect, ToolSet[string]>();
    const known = byDialect.get(dialect);

    if (known !== undefined) return [name, known];
    const raw = v.parse(JsonObjectSchema, asSchema(entry.inputSchema).jsonSchema);
    const normalized = { ...entry, inputSchema: jsonSchema<JsonObject>(normalizeToolInputSchema(raw, dialect)) };
    byDialect.set(dialect, normalized);
    normalizedTools.set(entry, byDialect);

    return [name, normalized];
  }));
}

const FieldsSchema = v.record(v.string(), v.unknown());

/**
 * JSON Schema's type names with the words a message uses for each, the narrowest first: a whole number is an
 * `integer`, which `number` also admits, and an array is also a record.
 */
const JSON_TYPES = [
  { name: 'null', words: 'null', schema: v.null() },
  { name: 'integer', words: 'an integer', schema: v.pipe(v.number(), v.integer()) },
  { name: 'number', words: 'a number', schema: v.number() },
  { name: 'string', words: 'a string', schema: v.string() },
  { name: 'boolean', words: 'a boolean', schema: v.boolean() },
  { name: 'array', words: 'an array', schema: v.array(v.unknown()) },
  { name: 'object', words: 'an object', schema: FieldsSchema },
] as const;

/** The fields a schema requires, and the type it declares for each field; its other rules are the tool's own. */
const InputContractSchema = v.object({
  required: v.optional(v.array(v.string()), []),
  properties: v.optional(FieldsSchema, {}),
});

const DeclaredTypeSchema = v.object({ type: v.union([v.string(), v.array(v.string())]) });

interface InputContract {
  readonly required: readonly string[];
  readonly types: ReadonlyMap<string, readonly string[]>;
}

function typeWords(names: readonly string[]): string {
  return names.map((name) => JSON_TYPES.find((type) => type.name === name)?.words ?? name).join(' or ');
}

async function inputContract(entry: ToolSet[string]): Promise<InputContract> {
  const declared = v.parse(InputContractSchema, await asSchema(entry.inputSchema).jsonSchema);
  const types = new Map<string, readonly string[]>();

  for (const [field, schema] of Object.entries(declared.properties)) {
    const declaredType = v.safeParse(DeclaredTypeSchema, schema);

    if (declaredType.success) types.set(field, [declaredType.output.type].flat());
  }

  return { required: declared.required, types };
}

/** What a call lacks or mistypes, each in the words its caller fixes it by. Shallow: a value is only typed. */
function fieldProblems(name: string, contract: InputContract, fields: v.InferOutput<typeof FieldsSchema>): string[] {
  const problems: string[] = [];

  for (const field of contract.required) {
    const types = contract.types.get(field);

    if (fields[field] !== undefined) continue;
    problems.push(`${name} requires \`${field}\`${types === undefined ? '' : `, ${typeWords(types)}`}`);
  }

  for (const [field, types] of contract.types) {
    const value = fields[field];

    if (value === undefined) continue;
    const actual = JSON_TYPES.find((type) => v.is(type.schema, value))?.name ?? 'a value JSON cannot carry';

    if (!types.includes(actual) && !(actual === 'integer' && types.includes('number'))) {
      problems.push(`${name}: \`${field}\` must be ${typeWords(types)}, not ${typeWords([actual])}`);
    }
  }

  return problems;
}

/**
 * `entry`, refusing a call its schema refuses as `bad_input`: programs call `execute` without the SDK's check. A raw
 * JSON Schema (MCP) gets the shallow check; its enum stays advisory (a device goes by nickname).
 */
export function withCheckedInput(name: string, entry: ToolSet[string]): ToolSet[string] {
  const execute = entry.execute;

  if (execute === undefined) return entry;
  let contract: Promise<InputContract> | undefined;

  return {
    ...entry,
    execute: async (input, options) => {
      const schema = asSchema(entry.inputSchema);
      const validate = schema.validate?.bind(schema);

      if (validate !== undefined) {
        const checked = await validate(input);

        if (!checked.success) throw refusedInput(name, checked.error);

        return execute(checked.value, options);
      }

      contract ??= inputContract(entry);
      // A record admits an array; no tool takes one as its input.
      const fields = Array.isArray(input) ? undefined : v.safeParse(FieldsSchema, input);

      const problems = fields?.success
        ? fieldProblems(name, await contract, fields.output)
        : [`${name} takes one object of named fields`];

      if (problems.length > 0) throw new KinuError('bad_input', problems.join('; '));

      return execute(input, options);
    },
  };
}

/** A choice whose refusal names the vocabulary and echoes what arrived. */
export function oneOf<const Values extends readonly string[]>(values: Values) {
  return z.enum(values, {
    error: (issue) => `one of ${values.join(', ')}; got ${issue.input === undefined ? 'nothing' : JSON.stringify(issue.input)}`,
  });
}

/** Every entry of `tools` behind {@link withCheckedInput}. */
export function withCheckedInputs(tools: ToolSet): ToolSet {
  const checked: ToolSet = {};

  for (const [name, entry] of Object.entries(tools)) checked[name] = withCheckedInput(name, entry);

  return checked;
}

/** The SDK's schema refusal of a model's call, as a program gets it. Only the tool-call part holds the error. */
export function invalidToolCallRefusal(part: { readonly toolName: string; readonly invalid?: boolean; readonly error?: unknown }): KinuError | undefined {
  if (part.invalid !== true || !InvalidToolInputError.isInstance(part.error)) return undefined;

  return refusedInput(part.toolName, part.error);
}
