import { InvalidToolInputError, NoSuchToolError, type ToolSet } from 'ai';
import type { ToolCallRepairFunction } from 'ai';
import * as v from 'valibot';
import { tolerate } from '../obs/expected-failure';
import { JsonValueSchema, isJsonObject, type JsonObject } from '../utils/json';

/** A JSON object and not an array, which `JsonObjectSchema`'s record admits. */
const ArgumentObjectSchema = v.pipe(JsonValueSchema, v.check(isJsonObject), v.transform((value) => (isJsonObject(value) ? value : {})));

/**
 * The AI SDK's `experimental_repairToolCall` seam, filled deterministically. A returned call is
 * re-validated, `null` keeps the original error, and a throw becomes `ToolCallRepairError`, so nothing
 * here throws. No model is consulted: that would be inference outside every spend ledger.
 */
export function repairToolCall<Tools extends ToolSet>(): ToolCallRepairFunction<Tools> {
  return async ({ toolCall, tools, error }) => {
    if (NoSuchToolError.isInstance(error)) {
      const wanted = toolCall.toolName.toLowerCase();
      const matches = Object.keys(tools).filter((name) => name.toLowerCase() === wanted);

      // Case-only differences name distinct tools; do not guess.
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

/** `{ input: {…} }` / `{ arguments: {…} }` wrapping the schema's object, with nothing beside it. */
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
