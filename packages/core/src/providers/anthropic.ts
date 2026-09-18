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
import type { CountableRequest, InputTokenCount } from './input-tokens';
import type { ModelProvider, ModelInfo, ProviderDeps } from './types';
import { createAuthedFetch } from './util';
import { listModelsDevProviderModels } from './models-dev';
import { countAnthropicInputTokens } from './anthropic-count';
import { warmAnthropicCache } from './anthropic-warm';
import type { JsonObject } from '../utils/json';
import type { Usage } from '../usage';
import type { ReasoningEffort } from './reasoning-effort';

export const ANTHROPIC_CRED_KEY = 'anthropic.bearer';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-7';

/** The small tier the evolution engine's mechanical calls run on. */
export const ANTHROPIC_FAST_MODEL = 'claude-haiku-4-5';

/** The `effort` parameter per model, from the effort guide's supported-models
 *  list and its per-level availability (read 2026-09-11):
 *  https://platform.claude.com/docs/en/build-with-claude/effort. Keyed by
 *  model name; a dated snapshot resolves through `modelFamilyId`. A model off
 *  the supported list takes no effort. */
const FIVE: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const FOUR: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'max'];

const ANTHROPIC_REASONING_EFFORTS = {
  'claude-fable-5-1':     FIVE,
  'claude-mythos-5-1':    FIVE,
  'claude-fable-5':       FIVE,
  'claude-mythos-5':      FIVE,
  'claude-mythos-preview': FOUR,
  'claude-opus-5':        FIVE,
  'claude-opus-4-8':      FIVE,
  'claude-opus-4-7':      FIVE,
  'claude-opus-4-6':      FOUR,
  'claude-opus-4-5':      ['low', 'medium', 'high'],
  'claude-sonnet-5':      FIVE,
  'claude-sonnet-4-6':    FOUR,
  'claude-sonnet-4-5':    [],
  'claude-haiku-4-5':     [],
} satisfies Record<string, readonly ReasoningEffort[]>;

const FALLBACK_MODELS: ModelInfo[] = [
  { id: ANTHROPIC_DEFAULT_MODEL, label: 'Claude Opus 4.7',  capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 1_000_000, inputModalities: ['text', 'image', 'pdf'], reasoningEfforts: ANTHROPIC_REASONING_EFFORTS['claude-opus-4-7'] },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6',   capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 1_000_000, inputModalities: ['text', 'image', 'pdf'], reasoningEfforts: ANTHROPIC_REASONING_EFFORTS['claude-sonnet-4-6'] },
  { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',    capabilities: ['tools', 'streaming', 'vision'], contextWindow: 200_000, inputModalities: ['text', 'image', 'pdf'], reasoningEfforts: ANTHROPIC_REASONING_EFFORTS['claude-haiku-4-5'] },
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
    fastModel: ANTHROPIC_FAST_MODEL,
    async isAvailable(deps) { return deps.hasCredential(ANTHROPIC_CRED_KEY); },
    unavailableReason() { return 'No Anthropic API key (cred key: `anthropic.bearer`).'; },
    listModels: (deps) => listModelsDevProviderModels('anthropic', deps, {
      fallback: FALLBACK_MODELS,
      preferredIds: PREFERRED_MODEL_IDS,
      reasoningEfforts: ANTHROPIC_REASONING_EFFORTS,
    }),
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
    warmCache(modelId, deps: ProviderDeps, body: JsonObject): Promise<Usage> {
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
