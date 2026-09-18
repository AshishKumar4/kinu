/**
 * One prompt-cache warm on Anthropic's Messages endpoint.
 *
 * The RAW POST, not the SDK, and for one reason: a warm must re-send the
 * previous request's own body ("Do not change a byte of the prefix",
 * docs/research/harness/anthropic-sources.md §2, read 2026-09-13), and that
 * body is exactly what ai v6 hands back as `StepResult.request.body`. Passing
 * it through a second SDK assembly would re-serialize tools, system and
 * messages from re-derived values and could only ever match by luck. The
 * credential and the retry policy still come from the provider's own authed
 * fetch, so the request carries the headers the turn's requests carry —
 * "Re-send the request's headers as well as its body."
 *
 * Shaped by {@link warmRequestBody}: `max_tokens: 0`, non-streaming. The
 * answer is read ONLY for its usage block; its content is discarded, which is
 * the point of a request that is allowed to generate nothing.
 */

import * as v from 'valibot';
import { ANTHROPIC_VERSION } from './anthropic-count';
import { warmUsage } from './cache-warming';
import { createAuthedFetch } from './util';
import { KinuError } from '../obs/index';
import type { ProviderDeps } from './types';
import type { Usage } from '../usage';
import { JsonObjectSchema, type JsonObject } from '../utils/json';

/** The one field a warm reads back. `looseObject` because the answer carries a
 *  whole message beside it and a warm has no business narrowing the vendor's
 *  reply; the usage block itself is loose for the same reason `Usage`'s
 *  normalizer is — a field the vendor adds tomorrow must not fail the parse. */
const WarmResponseSchema = v.looseObject({ usage: v.optional(JsonObjectSchema) });

export async function warmAnthropicCache(input: {
  modelId: string;
  deps: ProviderDeps;
  body: JsonObject;
  providerId: string;
  baseURL: string;
  credKey: string;
  missingCredentialError: string;
}): Promise<Usage> {
  const authedFetch = createAuthedFetch(input.deps, {
    provider: input.providerId,
    modelId: input.modelId,
    credKey: input.credKey,
    missingCredentialError: input.missingCredentialError,
  });

  const response = await authedFetch(`${input.baseURL}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify(input.body),
  });

  if (!response.ok) {
    // The STATUS and the vendor's own words, carried as values: the refusal is
    // a fact about this request, not a code to guess at. The caller retires the
    // chain on it rather than retrying — a warm that failed costs one cache
    // write on the next real turn, and a retry loop costs one request a second.
    throw new KinuError(
      'unavailable',
      `the cache warm answered ${response.status}: ${(await response.text()).slice(0, 400)}`,
    );
  }

  const parsed = v.parse(WarmResponseSchema, await response.json());

  return parsed.usage === undefined ? {} : warmUsage(parsed.usage);
}
