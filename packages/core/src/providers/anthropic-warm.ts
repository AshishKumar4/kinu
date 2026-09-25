/**
 * One prompt-cache warm: a raw POST re-sending the previous request's exact body with `max_tokens: 0`,
 * through the provider's authed fetch so the headers match too.
 */

import * as v from 'valibot';
import { ANTHROPIC_VERSION } from './anthropic-count';
import { warmUsage } from './cache-warming';
import { createAuthedFetch } from './util';
import { KinuError } from '../obs/index';
import type { ProviderDeps } from './types';
import type { Usage } from '../usage';
import { callAccountOf, type CallAccount } from './quota';
import { JsonObjectSchema, type JsonObject } from '../utils/json';

/** The usage block a warm reads; loose so a field the vendor adds cannot fail the parse. */
const WarmResponseSchema = v.looseObject({ usage: v.optional(JsonObjectSchema) });

export async function warmAnthropicCache(input: {
  modelId: string;
  deps: ProviderDeps;
  body: JsonObject;
  providerId: string;
  baseURL: string;
  credKey: string;
  missingCredentialError: string;
}): Promise<{ usage: Usage; account?: CallAccount | undefined }> {
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
    // Status and vendor text are carried as values; the caller retires the chain rather than retrying.
    throw new KinuError(
      'unavailable',
      `the cache warm answered ${response.status}: ${(await response.text()).slice(0, 400)}`,
    );
  }

  const parsed = v.parse(WarmResponseSchema, await response.json());
  const account = callAccountOf({ headers: Object.fromEntries(response.headers) });

  return { usage: parsed.usage === undefined ? {} : warmUsage(parsed.usage), account };
}
