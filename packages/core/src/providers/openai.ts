// OpenAI direct via API key; ChatGPT subscription credits use the `codex` provider.
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ModelProvider } from './types';
import { createAuthedFetch } from './util';
import { listModelsDevProviderModels } from './models-dev';
import { heardFetch } from './middleware/attempt';

export const OPENAI_CRED_KEY = 'openai.bearer';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export const OPENAI_DEFAULT_MODEL = 'gpt-5.5';

/** Evolution's mechanical-call tier. */
const OPENAI_FAST_MODEL = 'gpt-5.4-mini';

const PREFERRED_MODEL_IDS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.5-pro', 'gpt-5.4-pro', 'gpt-5', 'gpt-5.4-mini'];

export interface OpenAIOptions {
  /** Responses API (default) vs Chat Completions. */
  useResponsesAPI?: boolean;
}

export function createOpenAIProvider(opts: OpenAIOptions = {}): ModelProvider {
  const useResponses = opts.useResponsesAPI ?? true;

  return {
    id: 'openai',
    credentialKey: OPENAI_CRED_KEY,
    label: 'OpenAI (direct API)',
    defaultModel: OPENAI_DEFAULT_MODEL,
    fastModel: OPENAI_FAST_MODEL,
    async isAvailable(deps) { return deps.hasCredential(OPENAI_CRED_KEY); },
    unavailableReason() { return 'No OpenAI API key (cred key: `openai.bearer`).'; },
    listModels: (deps) => listModelsDevProviderModels('openai', deps, { required: true, preferredIds: PREFERRED_MODEL_IDS }),
    createModel(modelId, deps): LanguageModel {
      const customFetch = createAuthedFetch(deps, {
        provider: 'openai',
        credKey: OPENAI_CRED_KEY,
        missingCredentialError: 'OpenAI API key not configured',
      });

      const provider = createOpenAI({ apiKey: 'placeholder', fetch: heardFetch(customFetch) });

      return useResponses ? provider.responses(modelId) : provider.chat(modelId);
    },
  };
}
