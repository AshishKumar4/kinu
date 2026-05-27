// Anthropic direct — Messages API.
//   Base: https://api.anthropic.com/v1
//   Auth: x-api-key header (NOT Authorization: Bearer)
//   Header: anthropic-version: <date>
//
// Separate from OpenAI providers because the wire format differs. Uses
// @ai-sdk/anthropic which wraps the Messages API with the standard
// LanguageModel interface. createModel is sync; the API key is resolved
// inside customFetch from the per-agent credential store.
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo, ProviderDeps } from './types.js';
import { asFetchFunction } from './fetch-shim.js';

export const ANTHROPIC_CRED_KEY = 'anthropic';

const MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-7',         label: 'Claude Opus 4.7',     capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { id: 'claude-opus-4-6',         label: 'Claude Opus 4.6',     capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { id: 'claude-sonnet-4-6',       label: 'Claude Sonnet 4.6',   capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { id: 'claude-sonnet-4-5',       label: 'Claude Sonnet 4.5',   capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { id: 'claude-haiku-4-5',        label: 'Claude Haiku 4.5',    capabilities: ['tools', 'streaming', 'vision'] },
];

async function readKey(deps: ProviderDeps): Promise<string | null> {
  const c = await deps.credentials.get(ANTHROPIC_CRED_KEY);
  if (c?.kind === 'bearer') return c.token;
  const envKey = (deps.env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY;
  return typeof envKey === 'string' && envKey ? envKey : null;
}

export function createAnthropicProvider(): ModelProvider {
  return {
    id: 'anthropic',
    label: 'Anthropic (direct API)',
    defaultModel: 'claude-opus-4-7',
    async isAvailable(deps) { return !!(await readKey(deps)); },
    async unavailableReason() { return 'No Anthropic API key (cred key: `anthropic`, or ANTHROPIC_API_KEY env var).'; },
    listModels: () => MODELS,
    createModel(modelId, deps): LanguageModel {
      const baseFetch = deps.fetch ?? fetch;
      // The SDK's apiKey option populates x-api-key at request time. We pass
      // a placeholder and overwrite via customFetch each call — that way
      // updating the credential takes effect immediately, no model rebuild.
      const customFetch = asFetchFunction(async (input, init) => {
        const key = await readKey(deps);
        if (!key) {
          return new Response(
            JSON.stringify({ error: 'Anthropic API key not configured' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const headers = new Headers(init?.headers);
        headers.set('x-api-key', key);
        // anthropic-version is set by the SDK; preserve any caller-supplied one.
        if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
        return baseFetch(input, { ...init, headers });
      });
      const provider = createAnthropic({ apiKey: 'placeholder', fetch: customFetch });
      return provider.languageModel(modelId);
    },
  };
}
