// Anthropic direct — Messages API.
//   Base: https://api.anthropic.com/v1
//   Auth: x-api-key header (NOT Authorization: Bearer)
//   Header: anthropic-version: <date>
//
// Separate from OpenAI providers because the wire format differs. Uses
// @ai-sdk/anthropic which wraps the Messages API with the standard
// LanguageModel interface. createModel is sync; the API key is resolved
// inside customFetch via the AuthResolver each call.
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo, ProviderDeps } from './types.js';
import { asFetchFunction } from './fetch-shim.js';

export const ANTHROPIC_CRED_KEY = 'anthropic.bearer';

const MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-7',   label: 'Claude Opus 4.7',     capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { id: 'claude-opus-4-6',   label: 'Claude Opus 4.6',     capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6',   capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5',   capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',    capabilities: ['tools', 'streaming', 'vision'] },
];

export function createAnthropicProvider(): ModelProvider {
  return {
    id: 'anthropic',
    label: 'Anthropic (direct API)',
    defaultModel: 'claude-opus-4-7',
    async isAvailable(deps) { return deps.hasCredential(ANTHROPIC_CRED_KEY); },
    unavailableReason() { return 'No Anthropic API key (cred key: `anthropic.bearer`).'; },
    listModels: () => MODELS,
    createModel(modelId, deps): LanguageModel {
      const baseFetch = deps.fetch ?? fetch;
      const customFetch = asFetchFunction(async (input, init) => {
        const auth = await deps.getAuth(ANTHROPIC_CRED_KEY);
        if (!auth) {
          return new Response(
            JSON.stringify({ error: 'Anthropic API key not configured' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const headers = new Headers(init?.headers);
        for (const [k, v] of Object.entries(auth.headers)) headers.set(k, v);
        return baseFetch(input, { ...init, headers });
      });
      const provider = createAnthropic({ apiKey: 'placeholder', fetch: customFetch });
      return provider.languageModel(modelId);
    },
  };
}
