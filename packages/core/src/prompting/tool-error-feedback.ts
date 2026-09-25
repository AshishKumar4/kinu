import type { ModelMessage, StepResult, ToolResultPart, ToolSet } from 'ai';
import { renderThrownChain } from '../obs/index';
import type { JsonObject } from '../utils/json';
import { McpToolError } from '../tools/mcp-error';
import { failedToolOutcome } from '../tools/outcome';
import { invalidToolCallRefusal } from '../tools/tool-schema';

export type ToolErrorStep = Pick<StepResult<ToolSet>, 'content' | 'response'>;

function modelError(error: Error): ToolResultPart['output'] | undefined {
  if (error instanceof McpToolError) return { type: 'error-json', value: error.response };
  const outcome = failedToolOutcome({ cause: error });

  if (outcome.reason === null) return undefined;
  const value: JsonObject = { reason: outcome.reason, error: renderThrownChain({ cause: error }) };

  if (outcome.execution !== undefined) value.execution = outcome.execution;

  return { type: 'error-json', value };
}

/** Each failed call's feedback, by id; a schema refusal is read off its tool-call part, the only one holding the error. */
function stepErrors(step: ToolErrorStep): Map<string, ToolResultPart['output'] | undefined> | undefined {
  let errors: Map<string, ToolResultPart['output'] | undefined> | undefined;
  const refused = new Map<string, Error>();

  for (const part of step.content) {
    if (part.type !== 'tool-call') continue;
    const refusal = invalidToolCallRefusal(part);

    if (refusal !== undefined) refused.set(part.toolCallId, refusal);
  }

  for (const part of step.content) {
    if (part.type !== 'tool-error') continue;
    const error = refused.get(part.toolCallId) ?? part.error;
    // A duplicate id within one step is ambiguous, not permission to guess.
    errors ??= new Map();
    errors.set(part.toolCallId, errors.has(part.toolCallId) || part.providerExecuted || !(error instanceof Error)
      ? undefined : modelError(error));
  }

  return errors;
}

/** Project only this SDK call's failures; its cumulative response messages
 * delimit the active suffix, so reused ids cannot reclassify history. Inputs are not mutated. */
export function projectToolErrorFeedback(messages: ModelMessage[], steps: readonly ToolErrorStep[]): ModelMessage[] | undefined {
  const generated = steps.at(-1)?.response.messages;

  if (generated === undefined || generated.length > messages.length) return undefined;
  const prefixLength = messages.length - generated.length;
  let previousLength = 0;
  let projected: ModelMessage[] | undefined;

  for (const step of steps) {
    const errors = stepErrors(step);

    const response = step.response.messages;

    if (errors === undefined) { previousLength = response.length; continue; }

    for (let index = previousLength; index < response.length; index++) {
      const source = response[index];
      const messageIndex = prefixLength + index;
      const target = messages[messageIndex];

      if (source?.role !== 'tool' || target?.role !== 'tool') continue;
      let content: typeof target.content | undefined;

      for (let partIndex = 0; partIndex < target.content.length; partIndex++) {
        const part = target.content[partIndex];
        const original = source.content[partIndex];

        if (part?.type !== 'tool-result' || original?.type !== 'tool-result'
          || part.toolCallId !== original.toolCallId || part.toolName !== original.toolName
          || (part.output.type !== 'error-text' && part.output.type !== 'error-json')
          || (original.output.type !== 'error-text' && original.output.type !== 'error-json')) continue;
        const output = errors.get(part.toolCallId);

        if (output === undefined) continue;
        content ??= [...target.content];
        content[partIndex] = { ...part, output };
      }

      if (content !== undefined) {
        projected ??= [...messages];
        projected[messageIndex] = { ...target, content };
      }
    }

    previousLength = response.length;
  }

  return projected;
}
