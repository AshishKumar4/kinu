/**
 * Destination-owned replay normalization, request-only: history stays faithful
 * to the source provider. Rewrites replayed tool-call ids to deterministic
 * portable ids (`tool-call-id.ts`) and converts foreign reasoning to text.
 */

import type { AssistantContent, AssistantModelMessage, ModelMessage, ToolModelMessage } from 'ai';
import { toolCallIdFor } from '../providers/tool-call-id';
import * as v from 'valibot';

/** Reasoning is provider-signed: replayable only to its signer. Elsewhere its prose
 *  goes as text; a block with no prose is dropped (unsigned reasoning is rejected). */
type ReasoningCrossing = 'unchanged' | 'as-text' | 'dropped';

function reasoningCrossing(
  part: Extract<Exclude<AssistantContent, string>[number], { type: 'reasoning' }>,
  destinationIsAnthropic: boolean,
): ReasoningCrossing {
  const anthropic = v.safeParse(AnthropicReasoningOptionsSchema, part.providerOptions?.anthropic);

  const sourceIsAnthropic = anthropic.success
    && (anthropic.output.signature !== undefined
      || anthropic.output.redactedData !== undefined);

  if (sourceIsAnthropic === destinationIsAnthropic) return 'unchanged';

  return part.text ? 'as-text' : 'dropped';
}

const AnthropicReasoningOptionsSchema = v.object({
  signature: v.optional(v.string()),
  redactedData: v.optional(v.string()),
});


export function normalizeReplayForDestination(
  messages: readonly ModelMessage[],
  destinationProviderId: string | undefined,
): ModelMessage[] | undefined {
  // No resolved destination: preserve the prepare-step no-op contract.
  if (!destinationProviderId) return undefined;
  // One map spans every message so the result half cannot drift from its call.
  const ids = new Map<string, string>();
  let calls = 0;
  let changed = false;
  const destinationIsAnthropic = destinationProviderId === 'anthropic';

  const normalized = messages.map((message): ModelMessage => {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      let contentChanged = false;
      const content: Exclude<AssistantContent, string> = [];

      for (const part of message.content) {
        if (part.type === 'reasoning') {
          const crossing = reasoningCrossing(part, destinationIsAnthropic);

          if (crossing === 'as-text') content.push({ type: 'text', text: part.text });

          if (crossing !== 'unchanged') {
            contentChanged = true;
            continue;
          }
        }

        if (part.type === 'tool-call') {
          const id = ids.get(part.toolCallId) ?? toolCallIdFor({ scope: 'kinu', index: calls++ });
          ids.set(part.toolCallId, id);

          if (id !== part.toolCallId) {
            contentChanged = true;
            content.push({ ...part, toolCallId: id });
            continue;
          }
        }

        content.push(part);
      }

      if (!contentChanged) return message;
      changed = true;

      return { ...message, content } satisfies AssistantModelMessage;
    }

    if (message.role === 'tool') {
      let contentChanged = false;

      const content = message.content.map((part) => {
        if (part.type !== 'tool-result') return part;
        const id = ids.get(part.toolCallId);

        if (id === undefined || id === part.toolCallId) return part;
        contentChanged = true;

        return { ...part, toolCallId: id };
      });

      if (!contentChanged) return message;
      changed = true;

      return { ...message, content } satisfies ToolModelMessage;
    }

    return message;
  });

  return changed ? normalized : undefined;
}
