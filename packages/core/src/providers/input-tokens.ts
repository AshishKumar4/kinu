/**
 * Pre-submission input-token counting — what the PROVIDER says an assembled
 * request costs, asked before that request is submitted.
 *
 * Two numbers already existed and neither can admit a request. The context
 * meter's chars/4 scale (context-meter.ts) prices a request for an operator's
 * breakdown and says it is an estimate; `ModelInfo.contextWindow` is metadata
 * about the MODEL and never a measurement of the request. A request admitted on
 * either and refused remotely by the provider is the exact failure admission
 * exists to prevent, so the only number admitted here is one the provider's own
 * tokenizer produced for THIS request — and a provider that publishes no way to
 * ask is reported as such rather than approximated.
 *
 * The capability is a provider method rather than a table here: whether a count
 * can be obtained, how the request converts to the provider's wire shape, and
 * which requests it cannot represent are all facts about one provider's API, and
 * the provider module is where the rest of those facts already live. This module
 * owns the vocabulary and the one thing no provider can answer about itself:
 * what an ABSENT capability means.
 * THE MATRIX, as the vendors' own current documentation states it (researched
 * 2026-08-27; the runtime half is asserted in `unit-turn-admission.test.ts`):
 *
 *   anthropic   SUPPORTED. POST /v1/messages/count_tokens, the same structured
 *               input the Messages API takes, answering `{ input_tokens }`.
 *               Documented for the Claude API and for the Bedrock, Vertex and
 *               Foundry routes, so the same counter serves those if they are
 *               ever registered. Anthropic calls the result an estimate that
 *               "might differ by a small amount", and 4.7+ models tokenize
 *               ~30% higher than earlier ones — which is exactly why the count
 *               is taken against the model being called rather than reused.
 *   openai      NONE. Its own advanced-usage guide answers this question with
 *               post-response `usage` and with tiktoken as a LOCAL library
 *               whose message conversion "may change" and may be approximate.
 *               A local tokenizer over a conversion we do not own is not an
 *               authoritative count of the request, so none is claimed.
 *   codex       NONE. No published count endpoint on the ChatGPT backend, and
 *               parity with api.openai.com cannot be inferred.
 *   openrouter  NONE. Usage accounting is post-response (last SSE frame) or
 *               asynchronous via /generation; no pre-request tokenize route.
 *   workers-ai  NONE, and the near-miss is worth naming: Cloudflare's WAF
 *   + gateways  token counting is documented as an APPROXIMATE general-purpose
 *               tokenizer that "will not exactly match" the provider, and the
 *               AI Gateway REST surface publishes inference routes only, with
 *               no documented pass-through for a provider's own count
 *               endpoint. Neither can admit a request.
 *   openai-     NONE generally, because the endpoint is user-supplied. Concrete
 *   compat      servers do publish one — llama.cpp serves both POST /tokenize
 *               and an Anthropic-compatible POST /v1/messages/count_tokens —
 *               so a counter here would have to feature-detect a specific
 *               implementation, which is a capability probe against an
 *               arbitrary host and is deliberately not done on the turn path.
 *   claude-cli  NONE. The official binary is the auth boundary; it exposes no
 *               count surface.
 *
 * Google's Gemini publishes `:countTokens` (POST
 * v1beta/{model}:countTokens -> `totalTokens`), and it is recorded here rather
 * than implemented because no Gemini provider is registered in this tree — the
 * shape is ready for whoever adds one.
 */

import type { ModelMessage, ToolSet } from 'ai';
import type { ModelProvider, ProviderDeps } from './types';
import { diagnostics, renderThrownChain, toKinuError } from '../obs/index';

/**
 * The assembled request a count is asked about: exactly the planes a provider
 * prices.
 *
 * `tools` is not optional out of convenience — tool DEFINITIONS ride every
 * request of the turn and are a large, otherwise invisible share of it, so a
 * count taken without them under-reports by the whole tool surface. An absent
 * field means the request carries no tools, never that they were skipped.
 */
export interface CountableRequest {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: ToolSet | undefined;
}

/**
 * What asking cost. `counted` is the provider's own tokenizer over this
 * request; `unsupported` is the grounded reason no such number exists, which is
 * a classification and not a failure — the caller proceeds ungated rather than
 * gating on a number nobody measured.
 */
export type InputTokenCount =
  | { readonly kind: 'counted'; readonly tokens: number }
  | { readonly kind: 'unsupported'; readonly provider: string; readonly reason: string };

/** What an absent {@link ModelProvider.countInputTokens} means. */
export const NO_COUNT_ENDPOINT =
  'the provider publishes no pre-request token-count endpoint, so no exact count of this request exists before it is submitted';

/**
 * Ask the provider what the assembled request costs.
 *
 * A counter that FAILS to answer — the endpoint is down, the credential was
 * revoked, the body was refused — is recorded and reported as unsupported for
 * this request. A preflight that a turn's admission consults must never become
 * a new way for the turn itself to fail: the request it was asked about is
 * still exactly as submittable as it was before anyone asked.
 */
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
