/**
 * Destination-owned replay normalization, request-only: history stays faithful
 * to the source provider. Rewrites replayed tool-call ids to deterministic
 * portable ids (`tool-call-id.ts`) and converts foreign reasoning to text.
 */

import type { AssistantContent, AssistantModelMessage, ModelMessage, ToolModelMessage } from 'ai';
import { toolCallIdFor } from '../providers/tool-call-id';
import { StableCopies } from './stable-copies';
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

const replayed = new StableCopies();

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
      const parts = message.content;

      const rewrite = parts.map((part): string | null => {
        if (part.type === 'reasoning') {
          const crossing = reasoningCrossing(part, destinationIsAnthropic);

          return crossing === 'unchanged' ? null : crossing;
        }

        if (part.type !== 'tool-call') return null;
        const id = ids.get(part.toolCallId) ?? toolCallIdFor({ scope: 'kinu', index: calls++ });
        ids.set(part.toolCallId, id);

        return id === part.toolCallId ? null : id;
      });

      if (rewrite.every((step) => step === null)) return message;
      changed = true;

      return replayed.of(message, JSON.stringify(rewrite), () => {
        const content: Exclude<AssistantContent, string> = [];

        for (const [index, part] of parts.entries()) {
          const step = rewrite[index] ?? null;

          if (step === null) content.push(part);
          else if (part.type === 'reasoning') {
            if (step === 'as-text') content.push({ type: 'text', text: part.text });
          } else if (part.type === 'tool-call') content.push({ ...part, toolCallId: step });
        }

        return { ...message, content } satisfies AssistantModelMessage;
      });
    }

    if (message.role === 'tool') {
      const parts = message.content;

      const rewrite = parts.map((part): string | null => {
        if (part.type !== 'tool-result') return null;
        const id = ids.get(part.toolCallId);

        return id === undefined || id === part.toolCallId ? null : id;
      });

      if (rewrite.every((id) => id === null)) return message;
      changed = true;

      return replayed.of(message, JSON.stringify(rewrite), () => ({ ...message, content: parts.map((part, index) => {
        const id = rewrite[index] ?? null;

        return id === null || part.type !== 'tool-result' ? part : { ...part, toolCallId: id };
      }) } satisfies ToolModelMessage));
    }

    return message;
  });

  return changed ? normalized : undefined;
}
