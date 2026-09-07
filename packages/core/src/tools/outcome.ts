import * as v from 'valibot';
import { ERROR_CODES, KinuError, renderThrownChain } from '../obs/index';
import { FileRefusalError, FILE_REFUSAL_REASONS } from './file-edit';
import { McpToolError } from './mcp-error';

export const ToolOutcomeSchema = v.variant('success', [
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    reason: v.nullable(v.picklist([...ERROR_CODES, ...FILE_REFUSAL_REASONS])),
    execution: v.optional(v.object({ exitCode: v.number() })),
  }),
]);

export type ToolOutcome = v.InferOutput<typeof ToolOutcomeSchema>;

/** Read only producer-owned error metadata; output and diagnostic wording are not status. */
export function failedToolOutcome(input: Parameters<typeof renderThrownChain>[0]): Extract<ToolOutcome, { success: false }> {
  const outcome: Extract<ToolOutcome, { success: false }> = { success: false, reason: null };
  const seen = new Set<Error>();
  let error = input.cause;
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (error instanceof KinuError) {
      outcome.reason ??= error instanceof FileRefusalError ? error.verdict : error.code;
      if (error.execution !== undefined) outcome.execution ??= error.execution;
    }
    error = error.cause;
  }
  return outcome;
}

/** A namespace call returns typed operation refusals for authored code to handle. */
export async function branchableToolCall<Result>(call: () => Promise<Result>) {
  try {
    return await call();
  } catch (cause) {
    if (cause instanceof McpToolError) return cause.response;
    const outcome = failedToolOutcome({ cause });
    if (outcome.reason === null) throw cause;
    const refusal = { reason: outcome.reason, error: renderThrownChain({ cause }) };
    return outcome.execution === undefined ? refusal : { ...refusal, execution: outcome.execution };
  }
}
