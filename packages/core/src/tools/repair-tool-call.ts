import { InvalidToolInputError, NoSuchToolError, type ToolSet } from 'ai';
import type { ToolCallRepairFunction } from 'ai';
import * as v from 'valibot';
import { tolerate } from '../obs/expected-failure';
import { JsonValueSchema, isJsonObject, type JsonObject } from '../utils/json';

/** A JSON object and not an array, which `JsonObjectSchema`'s record admits. */
const ArgumentObjectSchema = v.pipe(JsonValueSchema, v.check(isJsonObject), v.transform((value) => (isJsonObject(value) ? value : {})));

/**
 * The AI SDK's `experimental_repairToolCall` seam, filled deterministically.
 *
 * The SDK calls this once per tool call it cannot parse or validate, and the
 * contract (`ai/dist/index.mjs`, `parseToolCall`) is exact: a returned call is
 * parsed and validated AGAIN, `null` keeps the original error — the call then
 * lands as `invalid` and the model reads it back through the tool-error
 * feedback projection — and a throw becomes a `ToolCallRepairError`, which is
 * why nothing here throws.
 *
 * No model is consulted. The SDK's documented repairs re-ask the model or run
 * `generateObject` against the schema, which is inference outside every spend
 * ledger this backend keeps; the shapes below are the ones a deterministic
 * rewrite settles, and everything else is left to the model's own retry.
 */
export function repairToolCall<Tools extends ToolSet>(): ToolCallRepairFunction<Tools> {
  return async ({ toolCall, tools, error }) => {
    if (NoSuchToolError.isInstance(error)) {
      const wanted = toolCall.toolName.toLowerCase();
      const matches = Object.keys(tools).filter((name) => name.toLowerCase() === wanted);
      // Two names that differ only by case are two tools; guessing between
      // them is a call the model did not make.
      return matches.length === 1 && matches[0] !== undefined ? { ...toolCall, toolName: matches[0] } : null;
    }
    if (!InvalidToolInputError.isInstance(error)) return null;
    const settled = settledArguments(toolCall.input);
    const input = settled === undefined ? undefined : JSON.stringify(settled);
    return input === undefined || input === toolCall.input ? null : { ...toolCall, input };
  };
}

/** A JSON object encoded once in a JSON string: the arguments encoded twice. */
const DoubleEncodedSchema = v.pipe(
  v.string(),
  v.transform((text) => tolerate<unknown>(() => JSON.parse(text), 'malformed-input')),
  ArgumentObjectSchema,
);
/** `{ input: {…} }` / `{ arguments: {…} }`: the schema's object wrapped in the
 *  wire's own key name, and nothing beside it. */
const WrappedSchema = v.union([
  v.strictObject({ input: ArgumentObjectSchema }),
  v.strictObject({ arguments: ArgumentObjectSchema }),
]);

/** The argument object a rewrite settles, or undefined to leave the call alone. */
function settledArguments(raw: string): JsonObject | undefined {
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  const parsed = tolerate<unknown>(() => JSON.parse(unfenced === '' ? '{}' : unfenced), 'malformed-input');
  const twice = v.safeParse(DoubleEncodedSchema, parsed);
  if (twice.success) return twice.output;
  const wrapped = v.safeParse(WrappedSchema, parsed);
  if (wrapped.success) return 'input' in wrapped.output ? wrapped.output.input : wrapped.output.arguments;
  const object = v.safeParse(ArgumentObjectSchema, parsed);
  return object.success ? object.output : undefined;
}
