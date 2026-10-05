import type { ModelMessage, StepResult, ToolResultPart, ToolSet } from 'ai';
import { toolErrorOutput } from '../tools/outcome';
import { invalidToolCallRefusal } from '../tools/tool-schema';

export type ToolErrorStep = Pick<StepResult<ToolSet>, 'content' | 'response'>;

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
      ? undefined : toolErrorOutput({ cause: error }));
  }

  return errors;
}

/** The step's own messages with the feedback the next request uses; the seal keeps them. */
export function modelStepMessages(step: ToolErrorStep): ModelMessage[] {
  const messages = step.response.messages;
  let projected: ModelMessage[] | undefined;
  const errors = stepErrors(step);

  if (errors === undefined) return messages;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];

    if (message?.role !== 'tool') continue;
    let content: typeof message.content | undefined;

    for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
      const part = message.content[partIndex];

      if (part?.type !== 'tool-result' || (part.output.type !== 'error-text' && part.output.type !== 'error-json')) continue;
      const output = errors.get(part.toolCallId);

      if (output === undefined) continue;
      content ??= [...message.content];
      content[partIndex] = { ...part, output };
    }

    if (content !== undefined) {
      projected ??= [...messages];
      projected[index] = { ...message, content };
    }
  }

  return projected ?? messages;
}
