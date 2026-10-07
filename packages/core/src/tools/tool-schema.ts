import * as v from 'valibot';
import { asSchema, InvalidToolInputError, type ToolSet } from 'ai';
import { z } from 'zod';
import { Effect } from 'effect';
import { KinuError, refusedInput, settle } from '../obs/index';

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
    execute: (input, options) => settle(Effect.gen(function* () {
      const schema = asSchema(entry.inputSchema);
      const validate = schema.validate?.bind(schema);

      if (validate !== undefined) {
        const checked = yield* Effect.promise(async () => validate(input));

        if (!checked.success) return yield* Effect.fail(refusedInput(name, checked.error));

        return yield* Effect.promise(async () => execute(checked.value, options));
      }

      contract ??= inputContract(entry);
      const pending = contract;
      // A record admits an array; no tool takes one as its input.
      const fields = Array.isArray(input) ? undefined : v.safeParse(FieldsSchema, input);

      const problems = fields?.success
        ? fieldProblems(name, yield* Effect.promise(() => pending), fields.output)
        : [`${name} takes one object of named fields`];

      if (problems.length > 0) return yield* new KinuError('bad_input', problems.join('; '));

      return yield* Effect.promise(async () => execute(input, options));
    })),
  };
}

/** A choice whose refusal names the vocabulary and echoes what arrived. */
export function oneOf<const Values extends readonly string[]>(values: Values) {
  return z.enum(values, {
    error: (issue) => `one of ${values.join(', ')}; got ${issue.input === undefined ? 'nothing' : JSON.stringify(issue.input)}`,
  });
}

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
