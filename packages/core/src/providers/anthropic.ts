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
import type { ModelProvider, ModelInfo } from './types.js';
import { createAuthedFetch } from './util.js';
import { listModelsDevProviderModels } from './models-dev.js';

export const ANTHROPIC_CRED_KEY = 'anthropic.bearer';
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-7';

const FALLBACK_MODELS: ModelInfo[] = [
  { id: ANTHROPIC_DEFAULT_MODEL, label: 'Claude Opus 4.7',  capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 1_000_000 },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6',   capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 1_000_000 },
  { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',    capabilities: ['tools', 'streaming', 'vision'], contextWindow: 200_000 },
];

const PREFERRED_MODEL_IDS = [
  ANTHROPIC_DEFAULT_MODEL,
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
];

export function createAnthropicProvider(): ModelProvider {
  return {
    id: 'anthropic',
    label: 'Anthropic (direct API)',
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    async isAvailable(deps) { return deps.hasCredential(ANTHROPIC_CRED_KEY); },
    unavailableReason() { return 'No Anthropic API key (cred key: `anthropic.bearer`).'; },
    listModels: (deps) => listModelsDevProviderModels('anthropic', deps, {
      fallback: FALLBACK_MODELS,
      preferredIds: PREFERRED_MODEL_IDS,
    }),
    createModel(modelId, deps): LanguageModel {
      const customFetch = createAuthedFetch(deps, {
        credKey: ANTHROPIC_CRED_KEY,
        missingCredentialError: 'Anthropic API key not configured',
      });
      const provider = createAnthropic({ apiKey: 'placeholder', fetch: customFetch });
      return provider.languageModel(modelId);
    },
  };
}
