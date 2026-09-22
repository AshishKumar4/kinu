/**
 * Every assistant `tool-call` needs a `tool-result` before the next user/system
 * message or prompt end, else `streamText` throws `AI_MissingToolResultsError`
 * client-side on every later turn. Repairs ride the request; stored history is
 * never rewritten.
 */

import type { ModelMessage, ToolModelMessage, ToolResultPart } from 'ai';

/** "Unknown" is the only defensible claim: the interrupt may land before, during,
 * or after execution, and the next turn must not confidently repeat a side effect. */
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
    settled.push(interruptedResults(pending));
    synthesized += pending.size;
    pending.clear();
  }

  return synthesized > 0 ? settled : undefined;
}

function interruptedResults(pending: ReadonlyMap<string, string>): ToolModelMessage {
  const content = [...pending].map(([toolCallId, toolName]): ToolResultPart => ({
    type: 'tool-result',
    toolCallId,
    toolName,
    output: { type: 'error-text', value: INTERRUPTED_TOOL_RESULT },
  }));

  return { role: 'tool', content };
}
