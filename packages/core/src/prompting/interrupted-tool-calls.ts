/**
 * A `tool-call` needs a `tool-result` before the next message, else `streamText` throws
 * `AI_MissingToolResultsError` on every later turn. Repairs ride the request, never stored history.
 */

import type { ModelMessage, ToolModelMessage, ToolResultPart } from 'ai';
import * as v from 'valibot';
import type { LostToolCall } from '../tools/effect-claim';

/** For a call nothing claimed: the interrupt may land before, during or after it. */
export const INTERRUPTED_TOOL_RESULT =
  'The turn was interrupted before this tool call returned. Whether it ran is unknown. '
  + 'Check the current state before issuing it again.';

/**
 * Give every unpaired tool call a terminal result, inserted right after the
 * asking assistant message (providers validate position). Returns `undefined`
 * when already valid. `providerExecuted` calls are skipped, as in the SDK.
 */
export function settleUnpairedToolCalls(
  messages: readonly ModelMessage[],
  lost?: (call: { readonly toolCallId: string; readonly toolName: string }) => LostToolCall | null,
): ModelMessage[] | undefined {
  const settled: ModelMessage[] = [];
  const pending = new Map<string, string>();
  let synthesized = 0;

  for (const [index, message] of messages.entries()) {
    settled.push(message);

    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'tool-call' && part.providerExecuted !== true) {
          pending.set(part.toolCallId, part.toolName);
        }
      }
    } else if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result') pending.delete(part.toolCallId);
      }
    }

    if (pending.size === 0 || messages[index + 1]?.role === 'tool') continue;
    settled.push(interruptedResults(pending, lost));
    synthesized += pending.size;
    pending.clear();
  }

  return synthesized > 0 ? settled : undefined;
}

function interruptedResults(
  pending: ReadonlyMap<string, string>,
  lost: ((call: { readonly toolCallId: string; readonly toolName: string }) => LostToolCall | null) | undefined,
): ToolModelMessage {
  const content = [...pending].map(([toolCallId, toolName]): ToolResultPart => ({
    type: 'tool-result',
    toolCallId,
    toolName,
    output: lostOutput(lost?.({ toolCallId, toolName }) ?? null),
  }));

  return { role: 'tool', content };
}

function lostOutput(call: LostToolCall | null): ToolResultPart['output'] {
  if (call === null) return { type: 'error-text', value: INTERRUPTED_TOOL_RESULT };

  if (call.state === 'claimed') return { type: 'error-text', value: call.refusal };

  return v.is(v.string(), call.result) ? { type: 'text', value: call.result } : { type: 'json', value: call.result };
}
