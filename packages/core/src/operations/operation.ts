/**
 * One model-callable operation, declared once: its native tool, its eval and slate function, its agent-core
 * descriptor and its rendered TypeScript all read this one valibot input and output.
 */
import * as v from 'valibot';
import { toJsonSchema, type JsonSchema } from '@valibot/to-json-schema';
import type { Impact } from '@agent-core/core/facets';
import { JsonObjectSchema, JsonValueSchema, projectJsonValue, type JsonValue } from '../utils/json';
import { currentWorkMode, requireWorkModePermission } from '../execution/work-mode';
import { KinuError, settle, settleSync } from '../obs/index';
import { Effect } from 'effect';
import type { CallJob } from '../types/primitives';
import type { TurnTrace } from '../obs/index';
import type { ToolExecutionOptions } from 'ai';

export type { Impact };

/** Object inputs only: a native composite folds each operation's fields into its own branch. */
export type OperationInput = v.ObjectSchema<v.ObjectEntries, undefined> | v.StrictObjectSchema<v.ObjectEntries, undefined> | v.LooseObjectSchema<v.ObjectEntries, undefined>;

export interface Operation<I extends OperationInput = OperationInput, O extends v.GenericSchema = v.GenericSchema> {
  readonly ns: string;
  readonly name: string;
  /** One line, what it does; the native tool's and the eval function's description. */
  readonly help: string;
  readonly impact: Impact;
  readonly availability: 'native' | 'code' | 'both';
  /** Whether a Plan turn reaches it; by default, an observe operation only. */
  readonly plan?: boolean;
  /** Reachable from a slate. */
  readonly slate: boolean;
  readonly input: I;
  readonly output: O;
  /** How the model reads a result where text reads better than its JSON, a page's Markdown above all; a program gets the value. */
  text?(output: v.InferOutput<O>): string;
}

export type OperationIn<Op extends Operation> = v.InferOutput<Op['input']>;

export type OperationOut<Op extends Operation> = v.InferOutput<Op['output']>;

/** What an operation's implementation is told about the call it serves; the work mode is the invocation's own. */
export interface OperationCall {
  readonly signal?: AbortSignal;
  /** The native tool call's id, or a program's. */
  readonly callId: string;
  /** The background job a native call runs as, once it outlives its window. */
  readonly job?: CallJob;
  /** The turn's trace, for a native call that times what it starts. */
  readonly trace?: TurnTrace;
  /** The native call's own options, for an operation whose engine reads them (a delegation's background job). */
  readonly native?: ToolExecutionOptions<unknown>;
}

export type OperationRun<Op extends Operation> = (input: OperationIn<Op>, call: OperationCall) => Promise<OperationOut<Op>> | Effect.Effect<OperationOut<Op>, KinuError>;

/** A result as JSON, and as text where the operation says it so for the model. */
export interface OperationResult {
  readonly value: JsonValue;
  readonly text?: string;
}

/** An operation with the implementation that serves it on this runtime; `run` holds every caller to the input schema. */
export interface Served {
  readonly op: Operation;
  run(input: JsonValue, call: OperationCall): Promise<OperationResult>;
}

export function defineOperation<const I extends OperationInput, const O extends v.GenericSchema>(op: Operation<I, O>): Operation<I, O> {
  return op;
}

export function serve<Op extends Operation>(op: Op, run: OperationRun<Op>): Served {
  return {
    op,
    run: async (input, call) => {
      requireWorkModePermission(currentWorkMode(), allowedInPlan(op), operationId(op));
      const parsed = v.safeParse(op.input, input);
      const answered = parsed.success ? run(parsed.output, call) : Effect.fail(inputRefusal(op, input, parsed.issues));

      return await settle((Effect.isEffect(answered) ? answered : Effect.promise(() => answered)).pipe(Effect.map((output) => {
        // As JSON carries it: a field set to undefined is absent.
        const value = projectJsonValue({ value: output });

        return op.text === undefined ? { value } : { value, text: op.text(output) };
      })));
    },
  };
}

/** A call's input as JSON, or the caller's bad input: a value with no JSON form, a cycle or a function, never crashes the turn. */
export function jsonOf(call: string, input: { readonly value: unknown }): JsonValue | KinuError {
  return settleSync(Effect.try({
    try: (): JsonValue | KinuError => projectJsonValue(input),
    catch: (cause) => new KinuError('bad_input', `${call}: the input is not JSON`, { cause }),
  }).pipe(Effect.catch((refused) => Effect.succeed(refused))));
}

/** What is wrong with a call's input, or null when its operation takes it. */
export function inputProblem(op: Operation, input: JsonValue): KinuError | null {
  const parsed = v.safeParse(op.input, input);

  return parsed.success ? null : inputRefusal(op, input, parsed.issues);
}

/** What is wrong with a call, by field, every unknown one named, and the fields the operation takes. */
function inputRefusal(op: Operation, input: JsonValue, issues: readonly v.BaseIssue<unknown>[]): KinuError {
  const sent = v.safeParse(JsonObjectSchema, input);
  const unknown = sent.success ? Object.keys(sent.output).filter((field) => !Object.hasOwn(op.input.entries, field)) : [];

  const said = [...unknown.map((field) => `unknown field "${field}"`), ...issues.flatMap((issue) => {
    const field = v.getDotPath(issue) ?? '';

    if (issue.type === 'strict_object' && issue.expected === 'never') return [];

    return issue.received === 'undefined' ? [`"${field}" is required`] : [`"${field}": ${issue.message}`];
  })];

  return new KinuError('bad_input', `${operationId(op)}: ${said.join('; ')}. It takes: ${Object.keys(op.input.entries).join(', ') || 'nothing'}.`);
}

export function operationId(op: Pick<Operation, 'ns' | 'name'>): string {
  return `${op.ns}.${op.name}`;
}

export function allowedInPlan(op: Pick<Operation, 'impact' | 'plan'>): boolean {
  return op.plan ?? op.impact === 'observe';
}

/** A JSON value in the d.ts, by the one name the eval prelude declares it under. */
export const JSON_VALUE_MARK = '__JsonValue__';

/** Schemas a field's description states better than their full JSON Schema would. */
const OPAQUE = new WeakMap<v.GenericSchema, JsonSchema>();

/**
 * An input its implementation validates itself (a tool's own schema, an MCP server's): every field passes through,
 * and the model, a program's d.ts and `listOperations` are given `stated`.
 */
export function statedInput(stated: JsonSchema): v.LooseObjectSchema<v.ObjectEntries, undefined> {
  const input = v.looseObject({});

  OPAQUE.set(input, stated);

  return input;
}

/**
 * Checked in full on every call and passed on as it was sent, for an engine that reads its own wire form; the model is
 * given `stated` and the field's own description.
 */
export function opaque(schema: v.GenericSchema, stated: JsonSchema) {
  const root = v.custom<JsonValue>((value) => v.is(JsonValueSchema, value));

  OPAQUE.set(root, stated);

  return v.pipe(root, v.rawCheck(({ dataset, addIssue }) => {
    if (!dataset.typed) return;
    const parsed = v.safeParse(schema, dataset.value);

    if (parsed.success) return;

    for (const issue of parsed.issues) addIssue({ message: `${v.getDotPath(issue) ?? 'value'}: ${issue.message}` });
  }));
}

function jsonSchemaOf(schema: v.GenericSchema, forTypes: boolean): JsonSchema {
  const { $schema: _dialect, ...document } = toJsonSchema(schema, {
    errorMode: 'throw',
    // Checked on every call, or (readonly) a type alone; a schema has no words for them.
    ignoreActions: ['trim', 'check', 'raw_check', 'guard', 'finite', 'raw_transform', 'transform', 'readonly'],
    overrideSchema: ({ valibotSchema }) => {
      if (valibotSchema === JsonValueSchema) return forTypes ? { enum: [JSON_VALUE_MARK] } : { description: 'Any JSON value.' };

      return OPAQUE.get(valibotSchema);
    },
  });

  return document;
}

/** The JSON Schema a provider and agent-core are given. */
export function inputJsonSchema(op: Operation): JsonSchema {
  return jsonSchemaOf(op.input, false);
}

/** The JSON Schema a d.ts is rendered from: a JSON value is marked, to be named `JsonValue` there. */
export function typeJsonSchema(schema: v.GenericSchema): JsonSchema {
  return jsonSchemaOf(schema, true);
}
