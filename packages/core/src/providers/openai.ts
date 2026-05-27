// OpenAI direct — API key (separate billing from ChatGPT subscription).
//   Base:  https://api.openai.com/v1
//   Surface: Responses API (default) or Chat Completions
//
// For ChatGPT *subscription* credits, use the `codex` provider instead.
// createModel is sync; customFetch resolves the bearer at request time.
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo, ProviderDeps } from './types.js';
import { asFetchFunction } from './fetch-shim.js';

export const OPENAI_CRED_KEY = 'openai';

const MODELS: ModelInfo[] = [
  { id: 'gpt-5.5',    label: 'GPT-5.5',    capabilities: ['tools', 'streaming', 'reasoning', 'json-mode', 'vision'] },
  { id: 'gpt-5',      label: 'GPT-5',      capabilities: ['tools', 'streaming', 'reasoning', 'json-mode', 'vision'] },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', capabilities: ['tools', 'streaming', 'json-mode'] },
  { id: 'gpt-4.1',    label: 'GPT-4.1',    capabilities: ['tools', 'streaming', 'json-mode', 'vision'] },
  { id: 'o4-mini',    label: 'o4-mini',    capabilities: ['streaming', 'reasoning'] },
];

async function readKey(deps: ProviderDeps): Promise<string | null> {
  const c = await deps.credentials.get(OPENAI_CRED_KEY);
  if (c?.kind === 'bearer') return c.token;
  const envKey = deps.env.OPENAI_API_KEY;
  return typeof envKey === 'string' && envKey ? envKey : null;
}

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
    async isAvailable(deps) { return !!(await readKey(deps)); },
    async unavailableReason() { return 'No OpenAI API key (cred key: `openai`, or OPENAI_API_KEY env var).'; },
    listModels: () => MODELS,
    createModel(modelId, deps): LanguageModel {
      const baseFetch = deps.fetch ?? fetch;
      const customFetch = asFetchFunction(async (input, init) => {
        const key = await readKey(deps);
        if (!key) {
          return new Response(
            JSON.stringify({ error: 'OpenAI API key not configured' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${key}`);
        return baseFetch(input, { ...init, headers });
      });
      const provider = createOpenAI({ apiKey: 'placeholder', fetch: customFetch });
      return useResponses ? provider.responses(modelId) : provider.chat(modelId);
    },
  };
}
