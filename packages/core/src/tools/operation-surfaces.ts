/**
 * The catalog's surfaces over one served set. A capability's native tool names one operation by `op`; its fields are
 * the union of its operations' fields, and a call is held to its own operation's schema. A program or slate calls
 * the same operation with its required fields positionally and the rest in a trailing options object.
 */
import { jsonSchema, tool, type Tool } from 'ai';
import * as v from 'valibot';
import { jsonSchemaToType } from '@cloudflare/codemode/json-schema';
import type { JsonSchema } from '@valibot/to-json-schema';
import { Effect } from 'effect';
import { KinuError, settle, settleSync } from '../obs/index';
import { currentWorkMode, permitInPlan } from '../execution/work-mode';
import type { CodemodeProvider, MemberDeclaration } from '../types/codemode';
import type { WorkMode } from '../types/turn';
import { JsonObjectSchema, projectJsonValue, type JsonObject, type JsonValue } from '../utils/json';
import { branchableToolCall, programSignal } from './outcome';
import { readCallJob } from './call-job';
import { imageModelOutput } from './image-results';
import type { TracedToolOptions } from '../obs/index';
import {
  allowedInPlan, inputJsonSchema, inputProblem, JSON_VALUE_MARK, jsonOf, operationId, typeJsonSchema,
  type Impact, type Operation, type OperationCall, type OperationResult, type Served,
} from '../operations/operation';

const typeOf = (schema: JsonSchema): string => jsonSchemaToType(schema, 'T').replace(/^type T = /u, '').replaceAll(`"${JSON_VALUE_MARK}"`, 'JsonValue');

const oneLine = (type: string): string => type.replace(/\s+/gu, ' ');

const returnsOf = (op: Operation): string => oneLine(typeOf(typeJsonSchema(op.output)));

const OPTIONAL_TYPES: ReadonlySet<string> = new Set(['optional', 'nullish', 'exact_optional']);

interface OperationFields {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

/** An operation's fields in declaration order, split by whether a call must give them. */
function fieldsOf(op: Operation): OperationFields {
  const entries = Object.entries(op.input.entries);

  return {
    required: entries.filter(([, schema]) => !OPTIONAL_TYPES.has(schema.type)).map(([key]) => key),
    optional: entries.filter(([, schema]) => OPTIONAL_TYPES.has(schema.type)).map(([key]) => key),
  };
}

/** A schema's properties, each as JSON Schema. */
function propertiesOf(schema: JsonSchema): ReadonlyMap<string, JsonSchema> {
  return new Map(Object.entries(schema.properties ?? {}).filter((entry): entry is [string, JsonSchema] => typeof entry[1] === 'object'));
}

/** The served operation a native call names, and its fields; a call naming none of them is refused, with the ones there are. */
interface NativeCall {
  readonly served: Served;
  readonly fields: JsonObject;
}

const NamedOp = v.looseObject({ op: v.string() });

/** A native tool over `resolve`, which finds the operation a call names. */
function nativeCall(resolve: (input: JsonObject) => NativeCall | KinuError, said: { readonly description: string; readonly parameters: JsonSchema }, members: readonly Served[]): Tool {
  const callOf = (sent: { readonly value: unknown }): NativeCall | KinuError => {
    const json = jsonOf('a tool call', sent);

    if (json instanceof KinuError) return json;
    const input = v.safeParse(JsonObjectSchema, json);

    return input.success ? resolve(input.output) : new KinuError('bad_input', 'a tool call takes one object of named fields');
  };

  const built = tool({
    description: said.description,
    inputSchema: jsonSchema(said.parameters, {
      validate: (value) => {
        const call = callOf({ value });
        const problem = call instanceof KinuError ? call : inputProblem(call.served.op, call.fields);

        return problem === null ? { success: true, value } : { success: false, error: problem };
      },
    }),
    execute: async (input, options: TracedToolOptions) => {
      const call = callOf({ value: input });

      if (call instanceof KinuError) return await settle(Effect.fail(call));
      const job = readCallJob(options);

      const { value, text } = await call.served.run(call.fields, {
        callId: options.toolCallId, ...(options.abortSignal !== undefined && { signal: options.abortSignal }), ...(job !== undefined && { job }),
        ...(options.trace !== undefined && { trace: options.trace }), native: options,
      });

      return text ?? value;
    },
    toModelOutput: imageModelOutput,
  });

  return members.some(({ op }) => allowedInPlan(op)) ? permitInPlan(built) : built;
}

/** An operation's input as the AI SDK takes a tool's: its JSON Schema, held to the operation's own check. */
export function operationInputSchema<Op extends Operation>(op: Op) {
  return jsonSchema<v.InferOutput<Op['input']>>(inputJsonSchema(op), {
    validate: (value) => {
      const problem = inputProblem(op, projectJsonValue({ value }));

      return problem === null ? { success: true, value: v.parse(op.input, value) } : { success: false, error: problem };
    },
  });
}

/**
 * A capability's native tool. `op` is its one required field and names the operation; every other field is any of
 * its operations' fields, described with the operations that take it. A call is held to its own operation's schema,
 * so a missing field is refused by name. Each operation's result is said here once, for a program calling it too.
 * An operation the wiring has but `withheld` names is not offered, and a call to it is refused with the reason.
 */
export function nativeTool(description: string, members: readonly Served[], withheld: ReadonlyMap<string, string> = new Map()): Tool {
  const ops = members.map(({ op }) => op.name).join(', ');

  return nativeCall((input) => {
    const named = v.safeParse(NamedOp, input);

    if (!named.success) return new KinuError('bad_input', `\`op\` is required; the ops are: ${ops}`);
    const served = members.find((member) => member.op.name === named.output.op);

    const reason = withheld.get(named.output.op);

    if (reason !== undefined) return new KinuError('denied', reason);

    if (served === undefined) return new KinuError('bad_input', `unknown op "${named.output.op}"; the ops are: ${ops}`);
    const { op: _op, ...fields } = input;

    return { served, fields };
  }, {
    description: `${description} ${members.map(({ op }) => `${op.name}: ${op.help} Returns ${returnsOf(op)}.`).join(' ')}`,
    parameters: nativeToolSchema(members.map(({ op }) => op)),
  }, members);
}

/** One operation as its own native tool, its fields at the top level. */
export function operationTool(description: string, served: Served): Tool {
  return nativeCall((fields) => ({ served, fields }), { description: `${description} Returns ${returnsOf(served.op)}.`, parameters: inputJsonSchema(served.op) }, [served]);
}

/** One field across the operations that take it: its schemas, and the operations by what each says of it. */
interface SharedField {
  readonly schemas: Map<string, JsonSchema>;
  readonly uses: Map<string, string[]>;
}

/**
 * The union of the operations' fields; only `op` is required. A field is described with the operations that take it,
 * and its schema is theirs, or a union of theirs where they differ.
 */
export function nativeToolSchema(ops: readonly Operation[]): JsonSchema {
  const fields = new Map<string, SharedField>();

  for (const op of ops) {
    const { required } = fieldsOf(op);

    for (const [key, schema] of propertiesOf(inputJsonSchema(op))) {
      const { description, ...accepted } = schema;
      const field = fields.get(key) ?? { schemas: new Map(), uses: new Map() };
      const use = required.includes(key) ? op.name : `${op.name} (optional)`;
      const said = description ?? '';

      field.schemas.set(JSON.stringify(accepted), accepted);
      field.uses.set(said, [...field.uses.get(said) ?? [], use]);
      fields.set(key, field);
    }
  }

  const fieldSchema = ({ schemas, uses }: SharedField): JsonSchema => {
    const [only] = schemas.values();

    return {
      ...(schemas.size === 1 && only !== undefined ? only : { anyOf: [...schemas.values()] }),
      description: [...uses].map(([said, users]) => `For ${users.join(', ')}.${said === '' ? '' : ` ${said}`}`).join(' '),
    };
  };

  return {
    type: 'object',
    properties: { op: { enum: ops.map((op) => op.name) }, ...Object.fromEntries([...fields].map(([key, field]) => [key, fieldSchema(field)])) },
    required: ['op'],
    additionalProperties: false,
  };
}

/** How a program calls an operation: its required fields in order, then an options object. */
function callForm(op: Operation): string {
  const { required, optional } = fieldsOf(op);

  return `${op.name}(${[...required, ...(optional.length > 0 ? [`{ ${optional.join(', ')} }`] : [])].join(', ')})`;
}

/** What a call's arguments get wrong in their arrangement, or null; its fields are the operation's schema's to check. */
function arrangementProblem(op: Operation, args: readonly JsonValue[], options: JsonObject | null): string | null {
  const { required, optional } = fieldsOf(op);

  if (options === null) return 'its options as one object';
  const stray = Object.keys(options).filter((key) => !optional.includes(key));

  if (stray.length > 0) return `no option ${stray.join(', ')}`;

  return args.length > required.length + 1 ? `at most ${String(required.length + 1)} arguments` : null;
}

/** One mapping from a program's or a slate's arguments to an operation's input: required fields in order, then options. */
function callInput(op: Operation, args: readonly JsonValue[]): JsonObject {
  const { required } = fieldsOf(op);
  const options = v.safeParse(v.optional(JsonObjectSchema, {}), args[required.length]);
  const problem = arrangementProblem(op, args, options.success ? options.output : null);

  if (problem !== null || !options.success) return settleSync(Effect.fail(new KinuError('bad_input', `${op.ns}.${callForm(op)} takes ${problem ?? 'its options as one object'}`)));

  return { ...Object.fromEntries(required.flatMap((key, index) => {
    const arg = args[index];

    return arg === undefined ? [] : [[key, arg]];
  })), ...options.output };
}

/** An operation's input as the positional arguments it is called with: the inverse of {@link callInput}. */
export function callArgs(op: Operation, input: JsonObject): JsonValue[] {
  const { required, optional } = fieldsOf(op);
  const options = Object.fromEntries(optional.flatMap((key) => (input[key] === undefined ? [] : [[key, input[key]]])));

  return [...required.map((key) => input[key] ?? null), ...(Object.keys(options).length === 0 ? [] : [options])];
}

/** `name(required…, options?): Promise<output | Refusal>`, each type rendered by codemode from the field's own schema. */
function operationDeclaration(op: Operation): string {
  const { required, optional } = fieldsOf(op);
  const properties = propertiesOf(typeJsonSchema(op.input));
  const typed = (key: string): string => oneLine(typeOf(properties.get(key) ?? {}));

  const docs = required.flatMap((key) => {
    const said = properties.get(key)?.description;

    return said === undefined ? [] : [` * @param ${key} ${said}`];
  });

  const params = required.map((key) => `${key}: ${typed(key)}`);

  if (optional.length > 0) {
    const options = Object.fromEntries(optional.map((key) => [key, properties.get(key) ?? {}]));

    params.push(`options?: ${oneLine(typeOf({ type: 'object', properties: options, additionalProperties: false }))}`);
  }

  const doc = docs.length === 0 ? `/** ${op.help} */` : ['/**', ` * ${op.help}`, ...docs, ' */'].join('\n');

  return `${doc}\n${op.name}(${params.join(', ')}): Promise<${returnsOf(op)} | Refusal>;`;
}

/** A namespace for programs and slates, over the same served operations; `summary` says what it is for. */
export function codemodeNamespace(ns: string, summary: string, members: readonly Served[]): CodemodeProvider {
  return {
    name: ns,
    summary,
    positionalArgs: true,
    operations: members,
    declarations: Object.fromEntries(members.map(({ op }) => [op.name, { full: operationDeclaration(op), call: callForm(op) }])),
    tools: Object.fromEntries(members.map((served) => [served.op.name, {
      description: served.op.help,
      ...(allowedInPlan(served.op) && { planAllowed: true }),
      // A refusal is the call's value, for the program to branch on.
      execute: async (...args: unknown[]) => await branchableToolCall(async () => {
        const signal = programSignal();

        const input = callInput(served.op, args.map((arg) => {
          const json = jsonOf(operationId(served.op), { value: arg });

          if (json instanceof KinuError) return settleSync(Effect.fail(json));

          return json;
        }));

        return (await served.run(input, { callId: `codemode-${crypto.randomUUID()}`, ...(signal !== undefined && { signal }) })).value;
      }),
    }])),
  };
}

/** A namespace's full declaration, as `describe(ns)` answers it in a program. */
export function namespaceDeclaration(ns: string, declarations: Readonly<Record<string, MemberDeclaration>>): string {
  return [`declare const ${ns}: {`, ...Object.values(declarations).map((declared) => declared.full.replace(/^/gmu, '  ')), '};'].join('\n');
}

/** Who calls an operation from outside eval: an actor, in the work mode it asks for, in a turn when one is open. */
export interface OperationCaller {
  readonly actorId: string;
  readonly turnId: string | null;
  readonly mode: WorkMode;
}

/** An operation a caller reaches, as `listOperations` names it. */
export interface OperationListing {
  readonly id: string;
  readonly help: string;
  readonly impact: Impact;
  readonly inputSchema: JsonSchema;
}

/** Each served operation whose member the narrowing and the work mode left in its namespace. */
function reachedOperations(providers: readonly CodemodeProvider[]): readonly Served[] {
  return providers.flatMap((provider) => (provider.operations ?? []).filter((served) => Object.hasOwn(provider.tools, served.op.name)));
}

/**
 * The operations `providers` reach in the current work mode, for a caller outside eval: each id, what it does, and its
 * input's schema. One Plan refuses is not listed.
 */
export function listOperations(providers: readonly CodemodeProvider[]): readonly OperationListing[] {
  return reachedOperations(providers)
    .filter(({ op }) => currentWorkMode() !== 'plan' || allowedInPlan(op))
    .map(({ op }) => ({ id: operationId(op), help: op.help, impact: op.impact, inputSchema: inputJsonSchema(op) }));
}

/**
 * The one dispatch outside eval: `ns.op` among the operations `providers` reach, run on its JSON input exactly as a
 * program's call runs it. An id they do not reach is refused, never resolved some other way.
 */
export async function callOperation(providers: readonly CodemodeProvider[], id: string, input: JsonValue, call: OperationCall): Promise<OperationResult> {
  const served = reachedOperations(providers).find(({ op }) => operationId(op) === id);

  if (served === undefined) return settleSync(Effect.fail(new KinuError('missing', `${id} is not an operation this caller reaches now`)));

  return await served.run(input, call);
}
