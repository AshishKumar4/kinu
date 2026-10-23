/**
 * A `tool-call` needs a `tool-result` before the next message, else `streamText` throws
 * `AI_MissingToolResultsError` on every later turn. Repairs ride the request, never stored history: an interrupted
 * call's, and an `ask_owner` call's, whose result is the owner's answer once they give it.
 */

import type { ModelMessage, ToolModelMessage, ToolResultPart } from 'ai';
import * as v from 'valibot';
import type { LostToolCall } from '../tools/effect-claim';
import { toolPairingParts, visitToolPairingParts } from '../session/tool-pairing';

/** Any part a model message carries, so a pairing scan hands each call and result back as the SDK typed it. */
type ModelPart = Exclude<ModelMessage['content'], string>[number];

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

  if (asking?.role !== 'assistant') return [];
  const parts = toolPairingParts<ModelPart>(history.slice(at));
  const answered = new Set(parts.flatMap(({ role, part }) => role === 'tool' && part.type === 'tool-result' ? [part.toolCallId] : []));

  return parts.flatMap(({ at: index, part }) => index === 0 && part.type === 'tool-call' && part.toolName === toolName && !answered.has(part.toolCallId)
    ? [{ toolCallId: part.toolCallId, input: part.input }] : []);
}

/** Every call in the history that no `tool-result` answers, `providerExecuted` ones skipped as the SDK skips them.
 *  Asked each step of the whole history, so it builds one id per answer and nothing per part: a part list built each
 *  scan was 2.1 of the 191 MB a 150-step turn allocated in its agent's isolate (heap gate, 2026-10-23). */
export function unpairedToolCalls(messages: readonly ModelMessage[]): LostCallQuery[] {
  const answered = new Set<string>();
  const unpaired: LostCallQuery[] = [];

  visitToolPairingParts<ModelPart>(messages, (_at, role, part) => {
    if (role === 'tool' && part.type === 'tool-result') answered.add(part.toolCallId);
  });
  visitToolPairingParts<ModelPart>(messages, (_at, role, part) => {
    if (role === 'assistant' && part.type === 'tool-call' && part.providerExecuted !== true && !answered.has(part.toolCallId)) {
      unpaired.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
    }
  });

  return unpaired;
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
  // Indexed walks, each pending call kept as its own part: an iterator or a copy would allocate per part, every step.
  let settled: ModelMessage[] | undefined;
  const pending = new Map<string, LostCallQuery>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    settled?.push(message);

    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (let at = 0; at < message.content.length; at++) {
        const part = message.content[at];

        if (part.type === 'tool-call' && part.providerExecuted !== true) pending.set(part.toolCallId, part);
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
  pending: ReadonlyMap<string, LostCallQuery>,
  lost: ((call: LostCallQuery) => LostToolCall | null) | undefined,
): ToolModelMessage {
  const content = [...pending.values()].map(({ toolCallId, toolName, input }): ToolResultPart => ({
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
