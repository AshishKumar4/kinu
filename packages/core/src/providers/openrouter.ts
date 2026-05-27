// OpenRouter — multi-upstream Chat Completions gateway.
//   Base: https://openrouter.ai/api/v1
//   Auth: Bearer <api-key>
//   Headers: HTTP-Referer + X-Title (attribution / ranking)
//   Catalog: dynamic via GET /api/v1/models
// createModel is sync; customFetch injects bearer + attribution headers at
// request time.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo, ProviderDeps } from './types.js';
import { asFetchFunction } from './fetch-shim.js';

const BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_CRED_KEY = 'openrouter';

async function readKey(deps: ProviderDeps): Promise<string | null> {
  const c = await deps.credentials.get(OPENROUTER_CRED_KEY);
  return c?.kind === 'bearer' ? c.token : null;
}

export interface OpenRouterOptions {
  refererURL?: string;
  appTitle?: string;
  catalogTtlMs?: number;
}

export function createOpenRouterProvider(opts: OpenRouterOptions = {}): ModelProvider {
  const ttl = opts.catalogTtlMs ?? 5 * 60_000;
  let catalogCache: { at: number; models: ModelInfo[] } | null = null;

  return {
    id: 'openrouter',
    label: 'OpenRouter',
    async isAvailable(deps) { return !!(await readKey(deps)); },
    async unavailableReason() { return 'No OpenRouter API key (cred key: `openrouter`).'; },

    async listModels(deps) {
      if (catalogCache && Date.now() - catalogCache.at < ttl) return catalogCache.models;
      const key = await readKey(deps);
      if (!key) return [];
      const fetchFn = deps.fetch ?? fetch;
      try {
        const res = await fetchFn(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${key}` } });
        if (!res.ok) return [];
        const body = await res.json() as { data?: Array<{
          id: string; name?: string; context_length?: number;
          architecture?: { modality?: string };
        }> };
        const models: ModelInfo[] = (body.data ?? []).map(m => ({
          id: m.id,
          label: m.name ?? m.id,
          contextWindow: m.context_length,
          capabilities: m.architecture?.modality?.includes('image')
            ? ['tools', 'streaming', 'vision']
            : ['tools', 'streaming'],
        }));
        catalogCache = { at: Date.now(), models };
        return models;
      } catch { return []; }
    },

    createModel(modelId, deps): LanguageModel {
      const baseFetch = deps.fetch ?? fetch;
      const customFetch = asFetchFunction(async (input, init) => {
        const key = await readKey(deps);
        if (!key) {
          return new Response(
            JSON.stringify({ error: 'OpenRouter API key not configured' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${key}`);
        if (opts.refererURL) headers.set('HTTP-Referer', opts.refererURL);
        if (opts.appTitle) headers.set('X-Title', opts.appTitle);
        return baseFetch(input, { ...init, headers });
      });
      return createOpenAICompatible({
        name: 'openrouter',
        baseURL: BASE_URL,
        fetch: customFetch,
      }).chatModel(modelId);
    },
  };
}
