/**
 * Destination-owned replay normalization.
 *
 * Durable history names what the SOURCE provider emitted. A replay request is a
 * new request to the DESTINATION provider, so source-native tool-call ids and
 * reasoning envelopes do not belong on that wire. Every currently registered
 * provider adapter accepts the portable id grammar in `tool-call-id.ts`; this
 * module therefore replaces every replayed call id with one destination-neutral
 * deterministic id and applies the same map to every result half.
 *
 * This is request-only: history stays faithful to the source provider, while
 * the destination receives one self-consistent transcript. Re-running the
 * normalization over the same request yields the same ids, and completed calls
 * remain completed — nothing executes during this transformation.
 */

import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from 'ai';
import { toolCallIdFor } from '../providers/tool-call-id';


/**
 * Normalize persisted tool-call ids for the provider about to receive this
 * request. Provider adapters already drop foreign reasoning envelopes; this
 * module owns the paired-id invariant at the final request boundary.
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

  const normalized = messages.map((message): ModelMessage => {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      let contentChanged = false;
      const content = message.content.map((part) => {
        if (part.type === 'tool-call') {
          const id = ids.get(part.toolCallId) ?? toolCallIdFor({ scope: 'kinu', index: calls++ });
          ids.set(part.toolCallId, id);
          if (id === part.toolCallId) return part;
          contentChanged = true;
          return { ...part, toolCallId: id };
        }
        return part;
      });
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
