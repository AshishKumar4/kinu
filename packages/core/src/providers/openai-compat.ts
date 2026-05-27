// Generic OpenAI-compatible — BYO base URL + API key. Covers Groq, Together,
// Fireworks, DeepInfra, xAI, etc. (all Chat Completions API). For OpenRouter,
// use the openrouter provider (adds attribution headers + dynamic catalog).
// For Anthropic direct, a separate Messages-API adapter is required.
//
// One openai-compat endpoint per credential key — the user can register
// multiple keyed `openai-compat.<name>` credentials (e.g. `openai-compat.groq`,
// `openai-compat.together`) and pick the model spec as
// `openai-compat:<name>/<modelId>`.
//
// createModel is sync; customFetch resolves the apiKey + baseURL at request
// time via the AuthResolver.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ProviderDeps } from './types.js';
import { asFetchFunction } from './fetch-shim.js';

export const OPENAI_COMPAT_KEY_PREFIX = 'openai-compat.';

/** Extract the credential key for an openai-compat provider id.
 *  `openai-compat:groq` → `openai-compat.groq` */
function credKeyFor(providerId: string): string {
  if (providerId === 'openai-compat') return 'openai-compat.default';
  if (providerId.startsWith('openai-compat:')) {
    return `openai-compat.${providerId.slice('openai-compat:'.length)}`;
  }
  return providerId;
}

export function createOpenAICompatProvider(providerId: string = 'openai-compat'): ModelProvider {
  const credKey = credKeyFor(providerId);
  return {
    id: providerId,
    label: providerId === 'openai-compat'
      ? 'OpenAI-compatible (BYO base URL)'
      : `OpenAI-compatible (${providerId.slice('openai-compat:'.length)})`,
    async isAvailable(deps) { return deps.hasCredential(credKey); },
    unavailableReason() { return `No openai-compat credential at key \`${credKey}\` (set baseURL + apiKey).`; },
    listModels: () => [],   // dynamic — UI prompts user for model id

    createModel(modelId, deps): LanguageModel {
      const baseFetch = deps.fetch ?? fetch;
      // baseURL is sourced from the credential, but @ai-sdk needs it at
      // construction. We pass a placeholder and rewrite the prefix inside
      // customFetch (which re-reads the credential each call, so a UI-side
      // change to baseURL takes effect without rebuilding the model).
      const placeholder = 'https://openai-compat.invalid';
      const customFetch = asFetchFunction(async (input, init) => {
        const auth = await deps.getAuth(credKey);
        if (!auth || !auth.baseURL) {
          return new Response(
            JSON.stringify({ error: `openai-compat credential ${credKey} not configured (baseURL required)` }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const headers = new Headers(init?.headers);
        for (const [k, v] of Object.entries(auth.headers)) headers.set(k, v);
        const originalUrl = typeof input === 'string' ? input
                          : input instanceof URL ? input.toString()
                          : input.url;
        const url = originalUrl.startsWith(placeholder)
          ? auth.baseURL.replace(/\/+$/, '') + originalUrl.slice(placeholder.length)
          : originalUrl;
        return baseFetch(url, { ...init, headers });
      });
      return createOpenAICompatible({
        name: providerId,
        baseURL: placeholder,
        fetch: customFetch,
      }).chatModel(modelId);
    },
  };
}
