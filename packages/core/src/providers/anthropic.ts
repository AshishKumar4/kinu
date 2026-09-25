// Anthropic Messages API (auth: `x-api-key`, not Bearer); the key is resolved per call in customFetch.
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import type { CountableRequest, InputTokenCount } from './input-tokens';
import type { ModelProvider, ModelInfo, ProviderDeps } from './types';
import { createAuthedFetch } from './util';
import { listModelsDevProviderModels } from './models-dev';
import { countAnthropicInputTokens } from './anthropic-count';
import { warmAnthropicCache } from './anthropic-warm';
import type { JsonObject } from '../utils/json';
import type { ReasoningEffort } from './reasoning-effort';

export const ANTHROPIC_CRED_KEY = 'anthropic.bearer';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-7';

/** Evolution's mechanical-call tier. */
export const ANTHROPIC_FAST_MODEL = 'claude-haiku-4-5';

/** Anthropic rejects more than 4 `cache_control` blocks: tools, system, and two on the tail. */
export const ANTHROPIC_MAX_BREAKPOINTS = 4;

const FIVE: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const FOUR: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'max'];

const FALLBACK_MODELS: ModelInfo[] = [
  { id: ANTHROPIC_DEFAULT_MODEL, label: 'Claude Opus 4.7',  capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 1_000_000, inputModalities: ['text', 'image', 'pdf'], reasoningEfforts: FIVE },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6',   capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 1_000_000, inputModalities: ['text', 'image', 'pdf'], reasoningEfforts: FOUR },
  { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',    capabilities: ['tools', 'streaming', 'vision'], contextWindow: 200_000, inputModalities: ['text', 'image', 'pdf'], reasoningEfforts: [] },
];

const PREFERRED_MODEL_IDS = [
  ANTHROPIC_DEFAULT_MODEL,
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
];

export function listAnthropicModels(deps: Pick<ProviderDeps, 'fetch'>): Promise<ModelInfo[]> {
  return listModelsDevProviderModels('anthropic', deps, { fallback: FALLBACK_MODELS, preferredIds: PREFERRED_MODEL_IDS });
}

export function createAnthropicProvider(): ModelProvider {
  return {
    id: 'anthropic',
    credentialKey: ANTHROPIC_CRED_KEY,
    label: 'Anthropic (direct API)',
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    fastModel: ANTHROPIC_FAST_MODEL,
    async isAvailable(deps) { return deps.hasCredential(ANTHROPIC_CRED_KEY); },
    unavailableReason() { return 'No Anthropic API key (cred key: `anthropic.bearer`).'; },
    listModels: (deps) => listAnthropicModels(deps),
    createModel(modelId, deps): LanguageModel {
      const customFetch = createAuthedFetch(deps, {
        provider: 'anthropic',
        modelId,
        credKey: ANTHROPIC_CRED_KEY,
        missingCredentialError: 'Anthropic API key not configured',
      });

      const provider = createAnthropic({ apiKey: 'placeholder', fetch: customFetch });

      return provider.languageModel(modelId);
    },
    countInputTokens(modelId, deps: ProviderDeps, request: CountableRequest): Promise<InputTokenCount> {
      return countAnthropicInputTokens({
        modelId,
        deps,
        request,
        providerId: 'anthropic',
        baseURL: ANTHROPIC_BASE_URL,
        credKey: ANTHROPIC_CRED_KEY,
        missingCredentialError: 'Anthropic API key not configured',
      });
    },
    warmCache(modelId, deps: ProviderDeps, body: JsonObject) {
      return warmAnthropicCache({
        modelId,
        deps,
        body,
        providerId: 'anthropic',
        baseURL: ANTHROPIC_BASE_URL,
        credKey: ANTHROPIC_CRED_KEY,
        missingCredentialError: 'Anthropic API key not configured',
      });
    },
  };
}
