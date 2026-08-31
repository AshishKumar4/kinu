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
import type { ModelProvider, ModelInfo, ProviderDeps } from '@kinu.run/core';
import { authCacheKey, cloneModelInfos, listModelsDevProviderModels } from '@kinu.run/core';
import { CLOUDFLARE_AI_GATEWAY_CRED_KEY, cloudflareAccountAPIRoot } from '../lib/cloudflare-oauth';
import { createCloudflareAIFetch, mapGatewayError } from './cloudflare-ai-fetch';
import { toKinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';

export const MY_GATEWAY_PROVIDER_ID = 'my-gateway';

/** Gateway BYOK `provider_slug` values the OpenAI-compatible REST surface can
 *  serve, mapped to the models.dev catalog id that carries model metadata AND
 *  doubles as the wire author prefix (`author/model`). `google-ai-studio` is
 *  the one slug whose author differs from the slug itself. */
const GATEWAY_SLUG_TO_CATALOG = new Map([
  ['openai', 'openai'],
  ['anthropic', 'anthropic'],
  ['google-ai-studio', 'google'],
  ['xai', 'xai'],
  ['groq', 'groq'],
  ['mistral', 'mistral'],
  ['deepseek', 'deepseek'],
  ['cerebras', 'cerebras'],
  ['perplexity', 'perplexity'],
  ['cohere', 'cohere'],
]);
const ProviderConfigsSchema = v.object({
  result: v.optional(v.array(v.object({ provider_slug: v.optional(v.string()) }))),
});
const CreditBalanceSchema = v.object({
  result: v.optional(v.object({ balance: v.optional(v.number()) })),
});

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

      const discovered = await servableProviderSlugs(auth.baseURL, auth.headers, deps);
      if (!discovered.authoritative) {
        // A gateway that answered 429/5xx said nothing about which providers it
        // serves, so neither the menu nor the cache may be narrowed by it. The
        // last catalog this account was actually shown stands until an
        // authoritative observation replaces it; with none, the provider fails
        // loudly rather than advertising "no providers configured".
        if (cached) return cloneModelInfos(cached.models);
        throw toKinuError({
          doing: `reading your AI Gateway's servable providers (${discovered.reason})`,
          cause: new Error(discovered.reason),
          otherwise: 'unavailable',
        });
      }
      const models: ModelInfo[] = [];
      for (const slug of discovered.slugs) {
        const catalogId = GATEWAY_SLUG_TO_CATALOG.get(slug);
        if (!catalogId) continue; // slug the OpenAI-compat surface can't serve
        for (const model of await listModelsDevProviderModels(catalogId, deps)) {
          models.push({ ...model, id: `${catalogId}/${model.id}` });
        }
      }
      catalogCache.set(cacheKey, { at: Date.now(), models });
      return cloneModelInfos(models);
    },

    createModel(modelId, deps): LanguageModel {
      const placeholder = 'https://kinu-my-gateway.invalid';
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

/**
 * What one discovery pass learned about this gateway.
 *
 * `authoritative` is the whole point: a menu narrowed to nothing because the
 * account really has no provider keys, and a menu narrowed to nothing because
 * the management API answered 500, are the same bytes and opposite facts. Only
 * the first may be published and cached as this gateway's catalog.
 */
type GatewayDiscovery =
  | { authoritative: true; slugs: string[] }
  | { authoritative: false; reason: string };

/** One management observation: what it contributed, or why it said nothing. */
type ManagementRead =
  | { kind: 'observed'; body: unknown }
  | { kind: 'denied' }
  | { kind: 'transient'; reason: string };

/**
 * Read one AI Gateway management endpoint and classify the answer.
 *
 * 401/403 is the account speaking: a credential minted before the management
 * scope existed cannot see provider configs, and the honest menu is the
 * narrower one. 429 and 5xx are the platform failing to answer at all, and
 * treating those as "no providers" is what turned a transient upstream blip
 * into a connected provider disappearing for the cache's lifetime.
 */
async function readGatewayManagement(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<ManagementRead> {
  const response = await fetchImpl(url, { headers });
  if (response.ok) return { kind: 'observed', body: await response.json() };
  if (response.status === 401 || response.status === 403) return { kind: 'denied' };
  return { kind: 'transient', reason: `AI Gateway management answered HTTP ${String(response.status)}` };
}

/** Which provider slugs THIS gateway can actually serve: its stored BYOK
 *  provider keys, plus the Unified-Billing set when the account has credits.
 *  A denied management call (e.g. a credential predating the aig.write scope)
 *  just narrows the menu; a call that could not be answered — a transport throw,
 *  a 429, a 5xx — is reported as non-authoritative so the caller keeps the last
 *  catalog the account was shown instead of publishing an empty one that looks
 *  like "no providers configured". */
async function servableProviderSlugs(
  baseURL: string,
  authHeaders: Record<string, string>,
  deps: ProviderDeps,
): Promise<GatewayDiscovery> {
  const account = cloudflareAccountAPIRoot(baseURL);
  const gatewayId = authHeaders['cf-aig-gateway-id'];
  if (!account || !gatewayId) return { authoritative: true, slugs: [] };
  const fetchImpl = deps.fetch ?? fetch;
  const headers = { ...authHeaders, accept: 'application/json' };
  const slugs = new Set<string>();

  const configs = await readGatewayManagement(
    fetchImpl,
    `${account}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/provider_configs?per_page=100`,
    headers,
  );
  if (configs.kind === 'transient') return { authoritative: false, reason: configs.reason };
  if (configs.kind === 'observed') {
    const body = v.parse(ProviderConfigsSchema, configs.body);
    for (const row of body.result ?? []) {
      if (row.provider_slug !== undefined) slugs.add(row.provider_slug);
    }
  }

  const credit = await readGatewayManagement(
    fetchImpl, `${account}/ai-gateway/billing/credit-balance`, headers,
  );
  if (credit.kind === 'transient') return { authoritative: false, reason: credit.reason };
  if (credit.kind === 'observed') {
    const body = v.parse(CreditBalanceSchema, credit.body);
    if (body.result?.balance !== undefined && body.result.balance > 0) {
      for (const slug of UNIFIED_BILLING_SLUGS) slugs.add(slug);
    }
  }

  return { authoritative: true, slugs: [...slugs].sort() };
}
