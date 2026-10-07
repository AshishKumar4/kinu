// Anthropic Messages API (auth: `x-api-key`, not Bearer); the key is resolved per call in customFetch.
import type { LanguageModel } from 'ai';
import type { CountableRequest, InputTokenCount } from './input-tokens';
import type { ModelProvider, ModelInfo, ProviderDeps } from './types';
import { createAuthedFetch } from './util';
import { listModelsDevProviderModels } from './models-dev';
import { countAnthropicInputTokens } from './anthropic-count';
import { warmAnthropicCache } from './anthropic-warm';
import type { JsonObject } from '../utils/json';
import { heardFetch } from './middleware/attempt';
import { lazyModel } from './wire-model';

export const ANTHROPIC_CRED_KEY = 'anthropic.bearer';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-7';

/** Evolution's mechanical-call tier. */
export const ANTHROPIC_FAST_MODEL = 'claude-haiku-4-5';

/** Anthropic rejects more than 4 `cache_control` blocks: tools, system, and two on the tail. */
export const ANTHROPIC_MAX_BREAKPOINTS = 4;

const PREFERRED_MODEL_IDS = [
  ANTHROPIC_DEFAULT_MODEL,
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
];

export function listAnthropicModels(deps: Pick<ProviderDeps, 'fetch'>): Promise<ModelInfo[]> {
  return listModelsDevProviderModels('anthropic', deps, { required: true, preferredIds: PREFERRED_MODEL_IDS });
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
        credKey: ANTHROPIC_CRED_KEY,
        missingCredentialError: 'Anthropic API key not configured',
      });

      return lazyModel('anthropic.messages', modelId, async () => (await import('@ai-sdk/anthropic'))
        .createAnthropic({ apiKey: 'placeholder', fetch: heardFetch(customFetch) }).languageModel(modelId));
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
