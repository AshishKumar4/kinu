/**
 * Pre-submission input-token counts from the provider's own tokenizer. A provider with no count endpoint
 * (only Anthropic publishes one among registered providers) reports `unsupported`, never an approximation.
 */

import type { ModelMessage, ToolSet } from 'ai';
import type { ModelProvider, ProviderDeps } from './types';
import { diagnostics, renderThrownChain, toKinuError } from '../obs/index';

/** The assembled request a count is about. `tools` is required: tool definitions are a large share of every request. */
export interface CountableRequest {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: ToolSet | undefined;
}

/** `counted` is the provider's tokenizer over this request; `unsupported` is a classification, not a failure. */
export type InputTokenCount =
  | { readonly kind: 'counted'; readonly tokens: number }
  | { readonly kind: 'unsupported'; readonly provider: string; readonly reason: string };

/** What an absent {@link ModelProvider.countInputTokens} means. */
export const NO_COUNT_ENDPOINT =
  'the provider publishes no pre-request token-count endpoint, so no exact count of this request exists before it is submitted';

/** Ask the provider what the assembled request costs. A failing counter reports unsupported, never failing the turn. */
export async function countRequestInputTokens(
  provider: Pick<ModelProvider, 'id' | 'countInputTokens'> | undefined,
  modelId: string,
  deps: ProviderDeps,
  request: CountableRequest,
): Promise<InputTokenCount> {
  if (!provider) {
    return { kind: 'unsupported', provider: 'unknown', reason: 'the model resolved through no registered provider' };
  }

  const count = provider.countInputTokens;

  if (!count) return { kind: 'unsupported', provider: provider.id, reason: NO_COUNT_ENDPOINT };

  try {
    return await count(modelId, deps, request);
  } catch (error) {
    diagnostics.failure(
      'admission.count_failed',
      toKinuError({ doing: 'count the assembled request before submitting it', cause: error, otherwise: 'io' }),
      { provider: provider.id, model: modelId },
    );

    return { kind: 'unsupported', provider: provider.id, reason: renderThrownChain({ cause: error }) };
  }
}
