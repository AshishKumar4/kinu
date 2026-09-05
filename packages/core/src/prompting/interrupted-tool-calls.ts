/**
 * The pairing invariant every provider request must satisfy.
 *
 * `streamText` refuses to build a prompt in which an assistant `tool-call` has
 * no `tool-result` before the next user/system message, or before the end of
 * the prompt — `ai/src/prompt/convert-to-language-model-prompt.ts` throws
 * `AI_MissingToolResultsError` ("Tool result is missing for tool call <id>.")
 * CLIENT-side, before a single byte reaches the provider. That is why a session
 * carrying one orphaned call is not merely a failed turn: every later turn
 * assembles the same history, hits the same throw, and fails identically. A
 * retry cannot help, because the failure is a pure function of the history.
 *
 * A turn interrupted between a tool call and its result leaves exactly that
 * shape. The honest record of it is not a dropped call — dropping loses the
 * fact that the agent asked for something — but a terminal result saying the
 * turn was cut. So:
 *
 *   - `runChat` settles the interrupted turn's own calls before it hands the
 *     turn's messages to the caller, so nothing invalid is ever persisted;
 *   - `assembleTurnMessages` settles the assembled request, so a history that
 *     ALREADY holds an orphan — a turn interrupted before this existed, or a
 *     partial assistant message persisted by the cf turn driver — becomes
 *     usable on its next turn without rewriting stored history.
 *
 * Assembly is a read of durable state, so the repair rides the request and
 * never writes back: the same history reassembled is repaired the same way,
 * and the durable transcript keeps saying what actually happened.
 */

import type { ModelMessage, ToolModelMessage, ToolResultPart } from 'ai';

/**
 * What the model reads in place of the result it never got.
 *
 * "Unknown" is the only defensible claim: the interrupt can land before the
 * tool was dispatched, while it was running, or after it returned and before
 * the result was recorded. Saying so is what stops the next turn from
 * confidently repeating a side effect that already happened.
 */
export const INTERRUPTED_TOOL_RESULT =
  'The turn was interrupted before this tool call returned. Whether it ran is unknown. '
  + 'Check the current state before issuing it again.';

/**
 * Give every unpaired tool call a terminal result.
 *
 * Returns `undefined` when the messages already satisfy the invariant, so
 * callers keep the original array (and its object identities) in the common
 * case. Synthetic results are inserted where a real `tool` message would have
 * gone — immediately after the assistant message that asked, ahead of anything
 * that is not itself a `tool` message — because the positional shape is what
 * providers validate, not just the presence of an id.
 *
 * `providerExecuted` calls are skipped, mirroring the SDK's own check: the
 * provider carries their results itself and never expects one from us.
 */
export function settleUnpairedToolCalls(
  messages: readonly ModelMessage[],
): ModelMessage[] | undefined {
  const settled: ModelMessage[] = [];
  /** Unpaired call id → tool name, in call order. */
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
