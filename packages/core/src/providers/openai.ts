// OpenAI direct — API key (separate billing from ChatGPT subscription).
//   Base:  https://api.openai.com/v1
//   Surface: Responses API (default) or Chat Completions
//
// For ChatGPT *subscription* credits, use the `codex` provider instead.
// createModel is sync; customFetch resolves the bearer at request time via
// the AuthResolver.
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo, ProviderDeps } from './types.js';
import { asFetchFunction } from './fetch-shim.js';

export const OPENAI_CRED_KEY = 'openai.bearer';

const MODELS: ModelInfo[] = [
  { id: 'gpt-5.5',    label: 'GPT-5.5',    capabilities: ['tools', 'streaming', 'reasoning', 'json-mode', 'vision'] },
  { id: 'gpt-5',      label: 'GPT-5',      capabilities: ['tools', 'streaming', 'reasoning', 'json-mode', 'vision'] },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', capabilities: ['tools', 'streaming', 'json-mode'] },
  { id: 'gpt-4.1',    label: 'GPT-4.1',    capabilities: ['tools', 'streaming', 'json-mode', 'vision'] },
  { id: 'o4-mini',    label: 'o4-mini',    capabilities: ['streaming', 'reasoning'] },
];

export interface OpenAIOptions {
  /** Use the Responses API (default) vs Chat Completions. */
  useResponsesAPI?: boolean;
}

export function createOpenAIProvider(opts: OpenAIOptions = {}): ModelProvider {
  const useResponses = opts.useResponsesAPI ?? true;
  return {
    id: 'openai',
    label: 'OpenAI (direct API)',
    defaultModel: 'gpt-5.5',
    async isAvailable(deps) { return deps.hasCredential(OPENAI_CRED_KEY); },
    unavailableReason() { return 'No OpenAI API key (cred key: `openai.bearer`).'; },
    listModels: () => MODELS,
    createModel(modelId, deps): LanguageModel {
      const baseFetch = deps.fetch ?? fetch;
      const customFetch = asFetchFunction(async (input, init) => {
        const auth = await deps.getAuth(OPENAI_CRED_KEY);
        if (!auth) {
          return new Response(
            JSON.stringify({ error: 'OpenAI API key not configured' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const headers = new Headers(init?.headers);
        for (const [k, v] of Object.entries(auth.headers)) headers.set(k, v);
        return baseFetch(input, { ...init, headers });
      });
      const provider = createOpenAI({ apiKey: 'placeholder', fetch: customFetch });
      return useResponses ? provider.responses(modelId) : provider.chat(modelId);
    },
  };
}
