// my-gateway — the USER'S own Cloudflare AI Gateway, authenticated with the
// same Cloudflare OAuth credential as workers-ai. One taxonomy, no drift:
//   workers-ai  — the user's Workers AI quota (`@cf/...` models)
//   my-gateway  — the user's own AI Gateway: third-party models paid by the
//                 gateway's stored BYOK provider keys or Unified Billing credits
//   ai-gateway  — the PLATFORM's env-bound gateway (deploy-time fallback)
//
// Wire path (the documented REST API, the recommended successor of the
// deprecated `/compat` endpoint — developers.cloudflare.com/ai-gateway/usage/rest-api/):
//   POST {account}/ai/v1/chat/completions
//   Authorization:     Bearer <user OAuth token>   (aig.run scope)
//   cf-aig-gateway-id: <the user's selected gateway>
//
// Model specs are `my-gateway/{author}/{model}` — the modelId after the first
// slash is exactly the wire `author/model` id (e.g. `openai/gpt-4.1`).
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo, ProviderDeps } from '@proteus/core';
import { authCacheKey, cloneModelInfos, listModelsDevProviderModels } from '@proteus/core';
import { CLOUDFLARE_AI_GATEWAY_CRED_KEY, cloudflareAccountAPIRoot } from '../lib/cloudflare-oauth.js';
import { createCloudflareAIFetch, mapGatewayError } from './cloudflare-ai-fetch.js';

export const MY_GATEWAY_PROVIDER_ID = 'my-gateway';

/** Gateway BYOK `provider_slug` values the OpenAI-compatible REST surface can
 *  serve, mapped to the models.dev catalog id that carries model metadata AND
 *  doubles as the wire author prefix (`author/model`). `google-ai-studio` is
 *  the one slug whose author differs from the slug itself. */
const GATEWAY_SLUG_TO_CATALOG: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  'google-ai-studio': 'google',
  xai: 'xai',
  groq: 'groq',
  mistral: 'mistral',
  deepseek: 'deepseek',
  cerebras: 'cerebras',
  perplexity: 'perplexity',
  cohere: 'cohere',
};

/** Providers Unified Billing can pay for without a stored key
 *  (developers.cloudflare.com/ai-gateway/features/unified-billing/). Listed
 *  only when the account actually holds credits. */
const UNIFIED_BILLING_SLUGS = ['openai', 'anthropic', 'google-ai-studio', 'xai', 'groq'] as const;

const CATALOG_TTL_MS = 60_000;
const catalogCache = new Map<string, { at: number; models: ModelInfo[] }>();

export function createMyGatewayProvider(): ModelProvider {
  return {
    id: MY_GATEWAY_PROVIDER_ID,
    label: 'Your AI Gateway',
    async isAvailable(deps) {
      const auth = await deps.getAuth(CLOUDFLARE_AI_GATEWAY_CRED_KEY);
      return !!auth?.baseURL;
    },
    unavailableReason: () =>
      'Connect Cloudflare and select an AI Gateway in User settings to use your own gateway (BYOK provider keys or Unified Billing credits).',

    async listModels(deps): Promise<ModelInfo[]> {
      const auth = await deps.getAuth(CLOUDFLARE_AI_GATEWAY_CRED_KEY);
      if (!auth?.baseURL) return [];
      const cacheKey = authCacheKey(auth);
      const cached = catalogCache.get(cacheKey);
      if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cloneModelInfos(cached.models);

      const slugs = await servableProviderSlugs(auth.baseURL, auth.headers, deps);
      const models: ModelInfo[] = [];
      for (const slug of slugs) {
        const catalogId = GATEWAY_SLUG_TO_CATALOG[slug];
        if (!catalogId) continue; // slug the OpenAI-compat surface can't serve
        for (const model of await listModelsDevProviderModels(catalogId, deps)) {
          models.push({ ...model, id: `${catalogId}/${model.id}` });
        }
      }
      catalogCache.set(cacheKey, { at: Date.now(), models });
      return cloneModelInfos(models);
    },

    createModel(modelId, deps): LanguageModel {
      const placeholder = 'https://proteus-my-gateway.invalid';
      const customFetch = createCloudflareAIFetch({
        credKey: CLOUDFLARE_AI_GATEWAY_CRED_KEY,
        getAuth: deps.getAuth,
        fetch: deps.fetch,
        placeholder,
        missingCredentialMessage: 'Connect Cloudflare and select an AI Gateway in User settings before using my-gateway models.',
        mapError: (res, resolved) => mapGatewayError(res, modelId, resolved.headers['cf-aig-gateway-id']),
      });

      return createOpenAICompatible({
        name: MY_GATEWAY_PROVIDER_ID,
        baseURL: placeholder,
        fetch: customFetch,
      }).chatModel(modelId);
    },
  };
}

/** Which provider slugs THIS gateway can actually serve: its stored BYOK
 *  provider keys, plus the Unified-Billing set when the account has credits.
 *  Both reads are best-effort — a denied management call (e.g. a credential
 *  predating the aig.write scope) just narrows the menu, never throws. */
async function servableProviderSlugs(
  baseURL: string,
  authHeaders: Record<string, string>,
  deps: ProviderDeps,
): Promise<string[]> {
  const account = cloudflareAccountAPIRoot(baseURL);
  const gatewayId = authHeaders['cf-aig-gateway-id'];
  if (!account || !gatewayId) return [];
  const fetchImpl = deps.fetch ?? fetch;
  const headers = { ...authHeaders, accept: 'application/json' };
  const slugs = new Set<string>();

  try {
    const res = await fetchImpl(
      `${account}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/provider_configs?per_page=100`,
      { headers },
    );
    if (res.ok) {
      const body = await res.json() as { result?: Array<{ provider_slug?: unknown }> };
      for (const row of body.result ?? []) {
        if (typeof row?.provider_slug === 'string') slugs.add(row.provider_slug);
      }
    }
  } catch { /* BYOK listing unavailable — fall through to unified billing */ }

  try {
    const res = await fetchImpl(`${account}/ai-gateway/billing/credit-balance`, { headers });
    if (res.ok) {
      const body = await res.json() as { result?: { balance?: unknown } };
      if (typeof body.result?.balance === 'number' && body.result.balance > 0) {
        for (const slug of UNIFIED_BILLING_SLUGS) slugs.add(slug);
      }
    }
  } catch { /* no credit visibility — BYOK-only menu */ }

  return [...slugs].sort();
}

