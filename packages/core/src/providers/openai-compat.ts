// Generic OpenAI-compatible — BYO base URL + API key. Covers Groq, Together,
// Fireworks, DeepInfra, xAI, etc. (all Chat Completions API). For OpenRouter,
// use the openrouter provider (adds attribution headers + dynamic catalog).
// For Anthropic direct, a separate Messages-API adapter is required.
// createModel is sync; customFetch injects bearer + custom baseURL config
// from the stored credential at request time.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ProviderDeps } from './types.js';
import type { OpenAICompatCredential } from '../credentials/store.js';
import { asFetchFunction } from './fetch-shim.js';

export const OPENAI_COMPAT_CRED_KEY = 'openai-compat';

async function readCred(deps: ProviderDeps): Promise<OpenAICompatCredential | null> {
  const c = await deps.credentials.get(OPENAI_COMPAT_CRED_KEY);
  return c?.kind === 'openai-compat' ? c : null;
}

export function createOpenAICompatProvider(): ModelProvider {
  return {
    id: 'openai-compat',
    label: 'OpenAI-compatible (BYO base URL)',
    async isAvailable(deps) { return !!(await readCred(deps)); },
    async unavailableReason() { return 'No openai-compat credential (set baseURL + apiKey).'; },
    listModels: () => [],   // dynamic — UI prompts user for model id

    createModel(modelId, deps): LanguageModel {
      // baseURL is sourced from the stored credential, but @ai-sdk needs it
      // at construction. We pass a placeholder and rewrite the prefix inside
      // customFetch (which re-reads the credential each call, so a UI-side
      // change to baseURL takes effect without rebuilding the model).
      const baseFetch = deps.fetch ?? fetch;
      const placeholder = 'https://openai-compat.invalid';
      const customFetch = asFetchFunction(async (input, init) => {
        const cred = await readCred(deps);
        if (!cred) {
          return new Response(
            JSON.stringify({ error: 'openai-compat credential not configured' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${cred.apiKey}`);
        for (const [k, v] of Object.entries(cred.extraHeaders ?? {})) headers.set(k, v);
        const originalUrl = typeof input === 'string' ? input
                          : input instanceof URL ? input.toString()
                          : input.url;
        const url = originalUrl.startsWith(placeholder)
          ? cred.baseURL.replace(/\/+$/, '') + originalUrl.slice(placeholder.length)
          : originalUrl;
        return baseFetch(url, { ...init, headers });
      });
      return createOpenAICompatible({
        name: 'openai-compat',
        baseURL: placeholder,
        fetch: customFetch,
      }).chatModel(modelId);
    },
  };
}
