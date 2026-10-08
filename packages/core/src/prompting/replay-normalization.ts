/**
 * Destination-owned replay normalization, request-only: history stays faithful
 * to the source provider. Rewrites replayed tool-call ids to deterministic
 * portable ids (`tool-call-id.ts`) and converts foreign reasoning to text.
 */

import type { AssistantContent, AssistantModelMessage, ModelMessage, ToolModelMessage } from 'ai';
import { toolCallIdFor } from '../providers/tool-call-id';
import { routeProtocol } from '../providers/wire-model';
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

/** The provider and model a request goes to; the model decides the wire where the provider serves several. */
export interface ReplayDestination {
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
}

/**
 * What one turn's passes have normalized for a destination: its assistant and tool messages in order, each as sent,
 * and the call ids handed out. A step that only added messages resumes here; any other change starts over.
 */
export class ReplayProgress {
  private destination = '';
  readonly sources: ModelMessage[] = [];
  readonly results: ModelMessage[] = [];
  readonly ids = new Map<string, string>();
  calls = 0;

  /** Starts over unless the same destination's passes read `messages`' assistant and tool messages as their prefix. */
  resume(destination: string, messages: readonly ModelMessage[]): void {
    let matched = 0;

    for (const message of messages) {
      if (message.role !== 'assistant' && message.role !== 'tool') continue;

      if (matched === this.sources.length || this.sources[matched] !== message) break;
      matched += 1;
    }

    if (destination === this.destination && matched === this.sources.length) return;
    this.destination = destination;
    this.sources.length = 0;
    this.results.length = 0;
    this.ids.clear();
    this.calls = 0;
  }
}

export function normalizeReplayForDestination(
  messages: readonly ModelMessage[],
  destination: ReplayDestination | undefined,
  progress: ReplayProgress = new ReplayProgress(),
): ModelMessage[] | undefined {
  // No resolved destination: preserve the prepare-step no-op contract.
  if (!destination?.providerId) return undefined;
  // Signed reasoning goes back only over Anthropic's own Messages API, whoever relays it.
  const destinationIsAnthropic = routeProtocol(destination.providerId, destination.modelId) === 'messages';
  progress.resume(`${destination.providerId}\n${destination.modelId ?? ''}`, messages);
  let read = 0;
  let changed = false;

  const normalized = messages.map((message): ModelMessage => {
    if (message.role !== 'assistant' && message.role !== 'tool') return message;

    if (read === progress.sources.length) {
      progress.sources.push(message);
      progress.results.push(normalizedMessage(message, progress, destinationIsAnthropic));
    }

    const result = progress.results[read];
    read += 1;

    if (result !== message) changed = true;

    return result;
  });

  return changed ? normalized : undefined;
}

/** One message as the destination takes it; `progress` maps each call's id, so a result follows its call. */
function normalizedMessage(message: AssistantModelMessage | ToolModelMessage, progress: ReplayProgress, destinationIsAnthropic: boolean): ModelMessage {
  const { ids } = progress;

  const rekeyed = (callId: string): string | null => {
    const id = ids.get(callId);

    return id === undefined || id === callId ? null : id;
  };

  if (message.role === 'assistant' && Array.isArray(message.content)) {
    const parts = message.content;

    const rewrite = parts.map((part): string | null => {
      if (part.type === 'reasoning') {
        const crossing = reasoningCrossing(part, destinationIsAnthropic);

        return crossing === 'unchanged' ? null : crossing;
      }

      // A provider-run result rides beside its call.
      if (part.type === 'tool-result') return rekeyed(part.toolCallId);

      if (part.type !== 'tool-call') return null;
      const id = ids.get(part.toolCallId) ?? toolCallIdFor({ scope: 'kinu', index: progress.calls++ });
      ids.set(part.toolCallId, id);

      return id === part.toolCallId ? null : id;
    });

    if (rewrite.every((step) => step === null)) return message;

    return replayed.of(message, JSON.stringify(rewrite), () => {
      const content: Exclude<AssistantContent, string> = [];

      for (const [index, part] of parts.entries()) {
        const step = rewrite[index] ?? null;

        if (step === null) content.push(part);
        else if (part.type === 'reasoning') {
          if (step === 'as-text') content.push({ type: 'text', text: part.text });
        } else if (part.type === 'tool-call' || part.type === 'tool-result') content.push({ ...part, toolCallId: step });
      }

      return { ...message, content } satisfies AssistantModelMessage;
    });
  }

  if (message.role === 'tool') {
    const parts = message.content;

    const rewrite = parts.map((part): string | null => (part.type === 'tool-result' ? rekeyed(part.toolCallId) : null));

    if (rewrite.every((id) => id === null)) return message;

    return replayed.of(message, JSON.stringify(rewrite), () => ({ ...message, content: parts.map((part, index) => {
      const id = rewrite[index] ?? null;

      return id === null || part.type !== 'tool-result' ? part : { ...part, toolCallId: id };
    }) } satisfies ToolModelMessage));
  }

  return message;
}
