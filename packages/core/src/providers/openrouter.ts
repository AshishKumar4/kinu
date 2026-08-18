// OpenRouter — multi-upstream Chat Completions gateway.
//   Base: https://openrouter.ai/api/v1
//   Auth: Bearer <api-key>
//   Headers: HTTP-Referer + X-Title (attribution / ranking)
//   Catalog: dynamic via GET /api/v1/models
// createModel is sync; customFetch injects bearer + attribution headers at
// request time via the AuthResolver.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import * as v from 'valibot';
import type { ModelProvider, ModelInfo } from './types';
import { authCacheKey, createAuthedFetch } from './util';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_CRED_KEY = 'openrouter.bearer';

export interface OpenRouterOptions {
  refererURL?: string;
  appTitle?: string;
  catalogTtlMs?: number;
}

const OpenRouterCatalogSchema = v.object({
  data: v.optional(v.array(v.object({
    id: v.string(),
    name: v.optional(v.string()),
    context_length: v.optional(v.number()),
    architecture: v.optional(v.object({ modality: v.optional(v.string()) })),
  }))),
});

export function createOpenRouterProvider(opts: OpenRouterOptions = {}): ModelProvider {
  const ttl = opts.catalogTtlMs ?? 5 * 60_000;
  // Keyed by the resolved credential so swapping/removing the API key
  // invalidates the catalog instead of serving the previous key's models.
  let catalogCache: { at: number; authKey: string; models: ModelInfo[] } | null = null;

  return {
    id: 'openrouter',
    label: 'OpenRouter',
    async isAvailable(deps) { return deps.hasCredential(OPENROUTER_CRED_KEY); },
    unavailableReason() { return 'No OpenRouter API key (cred key: `openrouter.bearer`).'; },

    async listModels(deps) {
      const auth = await deps.getAuth(OPENROUTER_CRED_KEY);
      if (!auth) {
        catalogCache = null;
        return [];
      }
      const authKey = authCacheKey(auth);
      if (catalogCache && catalogCache.authKey === authKey && Date.now() - catalogCache.at < ttl) {
        return catalogCache.models;
      }
      const fetchFn = deps.fetch ?? fetch;
      // No catch: an unreachable OpenRouter is not an OpenRouter with no models.
      const res = await fetchFn(`${OPENROUTER_BASE_URL}/models`, { headers: auth.headers });
      if (!res.ok) return [];
      const body = v.safeParse(OpenRouterCatalogSchema, await res.json());
      if (!body.success) return [];
      const models: ModelInfo[] = (body.output.data ?? []).map(m => ({
        id: m.id,
        label: m.name ?? m.id,
        contextWindow: m.context_length,
        capabilities: m.architecture?.modality?.includes('image')
          ? ['tools', 'streaming', 'vision']
          : ['tools', 'streaming'],
      }));
      catalogCache = { at: Date.now(), authKey, models };
      return models;
    },

    createModel(modelId, deps): LanguageModel {
      const customFetch = createAuthedFetch(deps, {
        credKey: OPENROUTER_CRED_KEY,
        missingCredentialError: 'OpenRouter API key not configured',
        mutate: ({ headers }) => {
          if (opts.refererURL) headers.set('HTTP-Referer', opts.refererURL);
          if (opts.appTitle) headers.set('X-Title', opts.appTitle);
        },
      });
      return createOpenAICompatible({
        name: 'openrouter',
        baseURL: OPENROUTER_BASE_URL,
        fetch: customFetch,
      }).chatModel(modelId);
    },
  };
}
