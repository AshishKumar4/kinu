// OpenAI direct via API key; ChatGPT subscription credits use the `codex` provider.
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo } from './types';
import { createAuthedFetch } from './util';
import { listModelsDevProviderModels } from './models-dev';
import type { ReasoningEffort } from './reasoning-effort';

export const OPENAI_CRED_KEY = 'openai.bearer';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export const OPENAI_DEFAULT_MODEL = 'gpt-5.5';

/** The small tier the evolution engine's mechanical calls run on. */
const OPENAI_FAST_MODEL = 'gpt-5.4-mini';

/** Offline levels per model (from https://developers.openai.com/api/docs/models/<id>),
 *  shared with codex.ts; live lists read models.dev. */
export const GPT54_EFFORTS: readonly ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh'];

const FALLBACK_MODELS: ModelInfo[] = [
  { id: OPENAI_DEFAULT_MODEL, label: 'GPT-5.5', capabilities: ['tools', 'streaming', 'reasoning', 'json-mode', 'vision'], contextWindow: 1_050_000, inputModalities: ['text', 'image', 'pdf'], reasoningEfforts: GPT54_EFFORTS },
  { id: 'gpt-5.4',    label: 'GPT-5.4',    capabilities: ['tools', 'streaming', 'reasoning', 'json-mode', 'vision'], contextWindow: 1_050_000, inputModalities: ['text', 'image', 'pdf'], reasoningEfforts: GPT54_EFFORTS },
  { id: 'gpt-5',      label: 'GPT-5',      capabilities: ['tools', 'streaming', 'reasoning', 'json-mode', 'vision'], contextWindow: 400_000, inputModalities: ['text', 'image', 'pdf'], reasoningEfforts: ['minimal', 'low', 'medium', 'high'] },
];

const PREFERRED_MODEL_IDS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.5-pro', 'gpt-5.4-pro', 'gpt-5', 'gpt-5.4-mini'];

export interface OpenAIOptions {
  /** Responses API (default) vs Chat Completions. */
  useResponsesAPI?: boolean;
}

export function createOpenAIProvider(opts: OpenAIOptions = {}): ModelProvider {
  const useResponses = opts.useResponsesAPI ?? true;

  return {
    id: 'openai',
    label: 'OpenAI (direct API)',
    defaultModel: OPENAI_DEFAULT_MODEL,
    fastModel: OPENAI_FAST_MODEL,
    async isAvailable(deps) { return deps.hasCredential(OPENAI_CRED_KEY); },
    unavailableReason() { return 'No OpenAI API key (cred key: `openai.bearer`).'; },
    listModels: (deps) => listModelsDevProviderModels('openai', deps, {
      fallback: FALLBACK_MODELS,
      preferredIds: PREFERRED_MODEL_IDS,
    }),
    createModel(modelId, deps): LanguageModel {
      const customFetch = createAuthedFetch(deps, {
        provider: 'openai',
        modelId,
        credKey: OPENAI_CRED_KEY,
        missingCredentialError: 'OpenAI API key not configured',
      });

      const provider = createOpenAI({ apiKey: 'placeholder', fetch: customFetch });

      return useResponses ? provider.responses(modelId) : provider.chat(modelId);
    },
  };
}
