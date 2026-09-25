/** LLM wrapper over the Vercel AI SDK, shared by the CF and CLI backends; callers supply URL, auth and model. */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { synthesizeToolFallback } from './utils/evidence-window';
import type { LLM } from './types/primitives';
import type { ModelCallSpend } from './events/model-call';
import { generateReported, streamTextReported } from './providers/model-invocation';
import { parseModelSpec, type ProviderWaitInfo } from './providers/types';
import { withRateLimitRetry } from './providers/rate-limit-retry';
import {
  reasoningEffortOptions, REASONING_EFFORT_FOR_STAGE, type InferenceStage,
} from './providers/effort';

export interface LLMProviderConfig {
  name: string;
  baseURL: string;
  headers: Record<string, string>;
  model: string;
}

/** `spend` is where this LLM's calls are reported, and as whose; one argument so the sink cannot be wired without
 *  the label. */
export function createVercelAILLM(config: LLMProviderConfig, spend: ModelCallSpend): LLM {
  const model = createModelFromLLMConfig(config);
  // No output cap: a reasoning model spends its budget thinking first, so a cap truncates or starves the answer.

  return {
    stream: (opts) => streamTextReported({
      model,
      system: opts.system,
      messages: opts.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
    }, { spend }),

    // No `spec`: this factory has no catalog spec to price.
    complete: async (prompt) => (await generateReported({ model, prompt }, { spend })).text.trim(),
  };
}

/**
 * A completion-only `LLM` over one resolved model, for offline raters (judges, classifiers); the reasoning knob
 * follows the spec's provider. `stream` throws so a wrong-seam caller fails loudly rather than getting empty text.
 */
export function createCompletionLLM(opts: {
  model: LanguageModel;
  spec: string;
  stage: InferenceStage;
  /** Where this model's calls are reported, and as whose spend; only the caller knows the label. */
  spend: ModelCallSpend;
}): LLM {
  const providerOptions = reasoningEffortOptions(
    REASONING_EFFORT_FOR_STAGE[opts.stage],
    parseModelSpec(opts.spec).provider,
  );

  return {
    stream() {
      throw new Error(`createCompletionLLM(${opts.spec}) has no streaming path`);
    },
    // `spec` is what the catalog prices; the row keeps the `modelId` the provider says served it beside it.
    complete: async (prompt) => (await generateReported(
      { model: opts.model, prompt, providerOptions },
      { spend: opts.spend, spec: opts.spec },
    )).text.trim(),
  };
}

/** Counted in characters because the `LLM` interface returns text, not usage. */
export interface LLMUsage {
  calls: number;
  promptChars: number;
  responseChars: number;
}

export interface MeteredLLM {
  llm: LLM;
  usage: LLMUsage;
}

/** A blunt chars-per-token average, used only to estimate. */
export const CHARS_PER_TOKEN = 4;

/** Conservative blended fallback (~$3 / 1M tokens) for the character seam and unpriced models;
 *  `ModelInfo.cost` is the real rate. */
export const BLENDED_USD_PER_1K_TOKENS = 0.003;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** The byte ceiling a token allocation implies; one derivation for every prompt-budget file admission. */
export function admissionBytes(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}

export function estimateUsdCost(tokens: number): number {
  return (tokens / 1000) * BLENDED_USD_PER_1K_TOKENS;
}

/** An `LLM` that counts what goes through it; `usage` is the live counter, read after the pass. */
export function meterLLM(llm: LLM): MeteredLLM {
  const usage: LLMUsage = { calls: 0, promptChars: 0, responseChars: 0 };

  return {
    usage,
    llm: {
      stream: (opts) => llm.stream(opts),
      async complete(prompt) {
        usage.calls++;
        usage.promptChars += prompt.length;
        const text = await llm.complete(prompt);
        usage.responseChars += text.length;

        return text;
      },
    },
  };
}

/**
 * Collect text from a generateText result. Some models (e.g. Kimi K2.5) end on a tool-call step with no trailing
 * text, and AI SDK v6 puts only the final step's text in `result.text`.
 */
export function collectStepText(result: {
  text: string;
  steps: ReadonlyArray<{
    text: string;
    toolResults: ReadonlyArray<{ toolName: string; output: unknown }>;
  }>;
}): string {
  if (result.text) return result.text;

  const textParts: string[] = [];

  for (const step of result.steps) {
    if (step.text) textParts.push(step.text);
  }

  if (textParts.length > 0) return textParts.join('\n\n');

  // No text in any step — synthesize from tool results
  const fallback = synthesizeToolFallback(result.steps);

  return fallback ? fallback : '(no response)';
}

/** Chat-model factory for the CLI's endpoint-configured models; for an `LLM` (`.stream`/`.complete`), use
 *  createVercelAILLM. */
// The CLI is the only caller (`openai-compat`, `anthropic`); live Workers AI is cf-backend's
// `createWorkersAIProvider`, which types sessionAffinity as a string.
export type ChatModelConfig =
  | {
      kind: 'openai-compat';
      name?: string;
      baseURL: string;
      headers: Record<string, string>;
      modelId: string;
      fetch?: typeof fetch;
      /** Listener for the rate-limit waits this model's requests take —
       *  what a surface reads to say the turn is waiting, not thinking. */
      onWait?: (info: ProviderWaitInfo) => void;
    }
  | {
      kind: 'anthropic';
      baseURL?: string;
      headers: Record<string, string>;
      modelId: string;
      fetch?: typeof fetch;
      onWait?: (info: ProviderWaitInfo) => void;
    };

export function createChatModel(config: ChatModelConfig): LanguageModel {
  if (config.kind === 'anthropic') {
    return createAnthropicModel({
      name: 'anthropic',
      baseURL: config.baseURL ?? 'https://api.anthropic.com/v1',
      headers: config.headers,
      model: config.modelId,
      fetch: config.fetch,
      onWait: config.onWait,
    });
  }

  return createOpenAICompatible({
    name: config.name ?? 'openai-compat',
    baseURL: config.baseURL,
    headers: config.headers,
    fetch: withRateLimitRetry(config.fetch ?? fetch, {
      provider: config.name ?? 'openai-compat',
      modelId: config.modelId,
      ...(config.onWait !== undefined && { onWait: config.onWait }),
    }),
  }).chatModel(config.modelId);
}

function createModelFromLLMConfig(config: LLMProviderConfig): LanguageModel {
  if (config.name === 'anthropic') return createAnthropicModel(config);

  return createOpenAICompatible({
    name: config.name,
    baseURL: config.baseURL,
    headers: config.headers,
    fetch: withRateLimitRetry(fetch),
  }).chatModel(config.model);
}

function createAnthropicModel(
  config: Pick<LLMProviderConfig, 'name' | 'baseURL' | 'headers' | 'model'> & {
    fetch?: typeof fetch;
    onWait?: (info: ProviderWaitInfo) => void;
  },
): LanguageModel {
  const headers = { ...config.headers };
  const apiKey = headers['x-api-key'] ?? headers['X-Api-Key'];
  delete headers['x-api-key'];
  delete headers['X-Api-Key'];

  const authorization = headers.Authorization ?? headers.authorization;
  const authToken = apiKey ? undefined : bearerToken(authorization);

  if (authToken) {
    delete headers.Authorization;
    delete headers.authorization;
  }

  const provider = createAnthropic({
    name: config.name,
    baseURL: config.baseURL,
    apiKey: apiKey || undefined,
    authToken,
    headers,
    fetch: withRateLimitRetry(config.fetch ?? fetch, {
      provider: config.name,
      modelId: config.model,
      ...(config.onWait !== undefined && { onWait: config.onWait }),
    }),
  });

  return provider.languageModel(config.model);
}

function bearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/iu.exec(value ?? '');
  const token = match?.[1]?.trim();

  return token === '' ? undefined : token;
}
