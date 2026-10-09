/**
 * A `tool-call` needs a `tool-result` before the next message, else `streamText` throws
 * `AI_MissingToolResultsError` on every later turn. Repairs ride the request, never stored history: an interrupted
 * call's, and an `ask_owner` call's, whose result is the owner's answer once they give it.
 */

import type { ModelMessage, ToolModelMessage, ToolResultPart } from 'ai';
import * as v from 'valibot';
import type { LostToolCall } from '../tools/effect-claim';

/** For a call nothing claimed: the interrupt may land before, during or after it. */
export const INTERRUPTED_TOOL_RESULT =
  'The turn was interrupted before this tool call returned. Whether it ran is unknown. '
  + 'Check the current state before issuing it again.';

/** An unpaired call, as its lookup is asked about it: `input` tells two calls a provider gave one id apart. */
export interface LostCallQuery {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

/**
 * The calls named `toolName` in the history's last assistant message that nothing after it answers: a turn that ended
 * on such a call (an `ask_owner`) is waiting on its result. Read from memory, so a turn asks it for free.
 */
export function trailingUnpairedCalls(history: readonly ModelMessage[], toolName: string): Array<{ readonly toolCallId: string; readonly input: unknown }> {
  let at = history.length - 1;

  while (history[at]?.role === 'tool') at--;
  const asking = history[at];

  if (asking?.role !== 'assistant' || !Array.isArray(asking.content)) return [];
  const answered = new Set(history.slice(at + 1).flatMap((message) => message.role === 'tool' ? message.content.map((part) => part.type === 'tool-result' ? part.toolCallId : '') : []));

  return asking.content.flatMap((part) => part.type === 'tool-call' && part.toolName === toolName && !answered.has(part.toolCallId)
    ? [{ toolCallId: part.toolCallId, input: part.input }] : []);
}

/**
 * Give every unpaired tool call a terminal result, inserted right after the
 * asking assistant message (providers validate position). Returns `undefined`
 * when already valid. `providerExecuted` calls are skipped, as in the SDK.
 */
export function settleUnpairedToolCalls(
  messages: readonly ModelMessage[],
  lost?: (call: LostCallQuery) => LostToolCall | null,
): ModelMessage[] | undefined {
  // Copied only once a call needs a result: every step reads the whole history, and almost every history is paired.
  // Indexed walks: an iterator would allocate a result per part of every message, every step.
  let settled: ModelMessage[] | undefined;
  const pending = new Map<string, { readonly toolName: string; readonly input: unknown }>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    settled?.push(message);

    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (let at = 0; at < message.content.length; at++) {
        const part = message.content[at];

        if (part.type === 'tool-call' && part.providerExecuted !== true) {
          pending.set(part.toolCallId, { toolName: part.toolName, input: part.input });
        }
      }
    } else if (message.role === 'tool') {
      for (let at = 0; at < message.content.length; at++) {
        const part = message.content[at];

        if (part.type === 'tool-result') pending.delete(part.toolCallId);
      }
    }

    if (pending.size === 0 || messages[index + 1]?.role === 'tool') continue;
    settled ??= messages.slice(0, index + 1);
    settled.push(interruptedResults(pending, lost));
    pending.clear();
  }

  return settled;
}

function interruptedResults(
  pending: ReadonlyMap<string, { readonly toolName: string; readonly input: unknown }>,
  lost: ((call: LostCallQuery) => LostToolCall | null) | undefined,
): ToolModelMessage {
  const content = [...pending].map(([toolCallId, { toolName, input }]): ToolResultPart => ({
    type: 'tool-result',
    toolCallId,
    toolName,
    output: lostOutput(lost?.({ toolCallId, toolName, input }) ?? null),
  }));

  return { role: 'tool', content };
}

function lostOutput(call: LostToolCall | null): ToolResultPart['output'] {
  if (call === null) return { type: 'error-text', value: INTERRUPTED_TOOL_RESULT };

  if (call.state === 'claimed') return { type: 'error-text', value: call.refusal };

  return v.is(v.string(), call.result) ? { type: 'text', value: call.result } : { type: 'json', value: call.result };
}
