// OpenAI direct — API key (separate billing from ChatGPT subscription).
//   Base:  https://api.openai.com/v1
//   Surface: Responses API (default) or Chat Completions
//
// For ChatGPT *subscription* credits, use the `codex` provider instead.
// createModel is sync; customFetch resolves the bearer at request time via
// the AuthResolver.
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo } from './types.js';
import { createAuthedFetch } from './util.js';
import { listModelsDevProviderModels } from './models-dev.js';

export const OPENAI_CRED_KEY = 'openai.bearer';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL = 'gpt-5.5';

const FALLBACK_MODELS: ModelInfo[] = [
  { id: OPENAI_DEFAULT_MODEL, label: 'GPT-5.5', capabilities: ['tools', 'streaming', 'reasoning', 'json-mode', 'vision'], contextWindow: 1_050_000, inputModalities: ['text', 'image', 'pdf'] },
  { id: 'gpt-5.4',    label: 'GPT-5.4',    capabilities: ['tools', 'streaming', 'reasoning', 'json-mode', 'vision'], contextWindow: 1_050_000, inputModalities: ['text', 'image', 'pdf'] },
  { id: 'gpt-5',      label: 'GPT-5',      capabilities: ['tools', 'streaming', 'reasoning', 'json-mode', 'vision'], contextWindow: 400_000, inputModalities: ['text', 'image', 'pdf'] },
];

const PREFERRED_MODEL_IDS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.5-pro', 'gpt-5.4-pro', 'gpt-5', 'gpt-5.4-mini'];

export interface OpenAIOptions {
  /** Use the Responses API (default) vs Chat Completions. */
  useResponsesAPI?: boolean;
}

export function createOpenAIProvider(opts: OpenAIOptions = {}): ModelProvider {
  const useResponses = opts.useResponsesAPI ?? true;
  return {
    id: 'openai',
    label: 'OpenAI (direct API)',
    defaultModel: OPENAI_DEFAULT_MODEL,
    async isAvailable(deps) { return deps.hasCredential(OPENAI_CRED_KEY); },
    unavailableReason() { return 'No OpenAI API key (cred key: `openai.bearer`).'; },
    listModels: (deps) => listModelsDevProviderModels('openai', deps, {
      fallback: FALLBACK_MODELS,
      preferredIds: PREFERRED_MODEL_IDS,
    }),
    createModel(modelId, deps): LanguageModel {
      const customFetch = createAuthedFetch(deps, {
        credKey: OPENAI_CRED_KEY,
        missingCredentialError: 'OpenAI API key not configured',
      });
      const provider = createOpenAI({ apiKey: 'placeholder', fetch: customFetch });
      return useResponses ? provider.responses(modelId) : provider.chat(modelId);
    },
  };
}
