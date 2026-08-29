/**
 * Destination-owned replay normalization.
 *
 * Durable history names what the SOURCE provider emitted. A replay request is a
 * new request to the DESTINATION provider, so source-native tool-call ids and
 * reasoning envelopes do not belong on that wire. Every currently registered
 * provider adapter accepts the portable id grammar in `tool-call-id.ts`.
 * This module replaces every replayed call id with one destination-neutral
 * deterministic id and applies the same map to every result half. It converts
 * foreign reasoning to assistant text and removes the source metadata.
 *
 * This is request-only: history stays faithful to the source provider, while
 * the destination receives one self-consistent transcript. Re-running the
 * normalization over the same request yields the same ids, and completed calls
 * remain completed — nothing executes during this transformation.
 */

import type { AssistantContent, AssistantModelMessage, ModelMessage, ToolModelMessage } from 'ai';
import { toolCallIdFor } from '../providers/tool-call-id';
import * as v from 'valibot';

const AnthropicReasoningOptionsSchema = v.object({
  signature: v.optional(v.string()),
  redactedData: v.optional(v.string()),
});


/**
 * Normalize persisted tool-call ids and reasoning for the destination.
 *
 * Durable history stays unchanged. The returned request uses only content that
 * the destination can replay.
 */
export function normalizeReplayForDestination(
  messages: readonly ModelMessage[],
  destinationProviderId: string | undefined,
): ModelMessage[] | undefined {
  // A backend that did not resolve a destination must preserve the exact
  // prepare-step no-op contract. It cannot honestly claim this is a replay
  // boundary, and normalizing there would create an override by itself.
  if (!destinationProviderId) return undefined;
  /** Original durable id → destination request id. One map spans every
   * assistant/tool message so the result half cannot drift from its call. */
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
          const anthropic = v.safeParse(
            AnthropicReasoningOptionsSchema,
            part.providerOptions?.anthropic,
          );
          const sourceIsAnthropic = anthropic.success
            && (anthropic.output.signature !== undefined
              || anthropic.output.redactedData !== undefined);
          if (sourceIsAnthropic !== destinationIsAnthropic) {
            contentChanged = true;
            if (part.text) content.push({ type: 'text', text: part.text });
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
