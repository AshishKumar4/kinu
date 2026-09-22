// The user's own Cloudflare AI Gateway via their Workers AI OAuth credential (`ai-gateway` is the platform's).
// Wire: POST {account}/ai/v1/chat/completions with `cf-aig-gateway-id`; specs are `my-gateway/{author}/{model}`.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { type ModelProvider, type ModelInfo, type ProviderDeps } from './types';
import { authCacheKey, cloneModelInfos } from './util';
import { listModelsDevProviderModels } from './models-dev';
import { CLOUDFLARE_AI_GATEWAY_CRED_KEY, cloudflareAccountAPIRoot } from './cloudflare-oauth';
import { createCloudflareAIFetch, mapGatewayError } from './cloudflare-ai-fetch';
import { toKinuError } from "../obs/index";
import * as v from 'valibot';

export const MY_GATEWAY_PROVIDER_ID = 'my-gateway';

/** BYOK slugs the OpenAI-compatible REST surface serves, mapped to their models.dev id (also the wire author). */
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

/** Providers Unified Billing pays for without a stored key; listed only when the account holds credits. */
const UNIFIED_BILLING_SLUGS = ['openai', 'anthropic', 'google-ai-studio', 'xai', 'groq'] as const;

const CATALOG_TTL_MS = 60_000;

const catalogCache = new Map<string, { at: number; models: ModelInfo[] }>();

export function createMyGatewayProvider(): ModelProvider {
  return {
    id: MY_GATEWAY_PROVIDER_ID,
    label: 'Your AI Gateway',
    async isAvailable(deps) {
      const auth = await deps.getAuth(CLOUDFLARE_AI_GATEWAY_CRED_KEY);

      return Boolean(auth?.baseURL);
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
        // A 429/5xx said nothing about which providers are served: keep the last catalog shown, else fail loudly.
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
        provider: MY_GATEWAY_PROVIDER_ID,
        modelId,
        onProviderWait: deps.onProviderWait,
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

/** What one discovery pass learned; only an `authoritative` empty menu may be published and cached. */
type GatewayDiscovery =
  | { authoritative: true; slugs: string[] }
  | { authoritative: false; reason: string };

/** One management observation: what it contributed, or why it said nothing. */
type ManagementRead =
  | { kind: 'observed'; body: unknown }
  | { kind: 'denied' }
  | { kind: 'transient'; reason: string };

/** Read one management endpoint: 401/403 narrows the menu; 429 and 5xx are non-answers, not "no providers". */
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

/** Provider slugs this gateway can serve: BYOK keys, plus Unified Billing ones with credits.
 *  Unanswered calls are non-authoritative, so the caller keeps the last catalog shown. */
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
