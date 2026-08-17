/**
 * LLM wrapper using Vercel AI SDK — shared between CF and CLI backends.
 *
 * Both backends use createOpenAICompatible from @ai-sdk/openai-compatible.
 * The caller provides the base URL, auth headers, and model name.
 * No hardcoded credentials anywhere.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, streamText } from 'ai';
import type { LanguageModel, StepResult, ToolSet } from 'ai';
import * as v from 'valibot';
import type { LLM } from './types/primitives.js';
import type { ModelCallSpend } from './events/model-call.js';
import { normalizeUsage } from './usage.js';
import { parseModelSpec } from './providers/types.js';
import { withRateLimitRetry } from './providers/rate-limit-retry.js';
import {
  reasoningEffortOptions, REASONING_EFFORT_FOR_STAGE, type InferenceStage,
} from './strategy/effort.js';

export interface LLMProviderConfig {
  /** Display name for the provider (e.g., 'workers-ai', 'anthropic') */
  name: string;
  /** Base URL for the OpenAI-compatible API */
  baseURL: string;
  /** Auth headers (e.g., { 'Authorization': 'Bearer ...' }) */
  headers: Record<string, string>;
  /** Model identifier (e.g., '@cf/deepseek-ai/deepseek-v4-pro-0813') */
  model: string;
  /** Max tokens for completions (default: 2048) */
  maxTokens?: number;
  /**
   * Where the calls this LLM makes are reported, and as whose spend.
   *
   * Both halves in one field because the source is the CALLER's to state: this
   * factory builds the chat model on one line and a cross-family judge on the
   * next (`identity/open.ts:102`, `:105`), so no literal belongs here, and two
   * independent optional fields would let a caller wire the sink without the
   * label and lose the attribution silently.
   *
   * Absent means this LLM's spend is attributed to nothing, which the coverage
   * fraction states rather than hides.
   */
  spend?: ModelCallSpend;
}

/**
 * Create an LLM backed by the Vercel AI SDK.
 * Works with any OpenAI-compatible endpoint:
 * - Cloudflare Workers AI (via AI Gateway)
 * - OpenAI direct
 * - Anthropic (via proxy)
 * - Any OpenAI-compatible provider
 */
export function createVercelAILLM(config: LLMProviderConfig): LLM {
  const model = createModelFromLLMConfig(config);
  // No default output cap: a reasoning model spends its budget thinking before
  // it emits anything, so a cap truncates the answer (or starves it entirely).
  // Cost is controlled by reasoning effort. A cap applies only when the caller
  // explicitly configured one.
  const cap = config.maxTokens !== undefined ? { maxOutputTokens: config.maxTokens } : {};
  const spend = config.spend;

  return {
    async *stream(opts) {
      const result = streamText({
        model,
        system: opts.system,
        messages: opts.messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
        ...cap,
      });
      for await (const chunk of result.textStream) {
        yield chunk;
      }
      // Usage is only knowable once the stream has finished, so the report goes
      // here. A consumer that abandons the generator mid-way never reaches this
      // line and reports nothing — honest, because the cost of a stream nobody
      // drained is not something this seam ever learns. `totalUsage` rather than
      // `usage`: the latter is the LAST step only.
      if (spend) {
        spend.report({
          source: spend.source,
          usage: normalizeUsage(await result.totalUsage),
          modelId: (await result.response).modelId,
        });
      }
    },

    async complete(prompt) {
      const result = await generateText({
        model,
        prompt,
        ...cap,
      });
      // Reported even when the provider said nothing: `normalizeUsage` returns
      // `{}` and the CALL still lands, which is what keeps a silent provider
      // distinguishable from a free one. No `spec`: this factory is configured
      // with a base URL and a model name rather than a catalog spec, and
      // synthesizing one would name a route the catalog cannot price.
      spend?.report({
        source: spend.source,
        usage: normalizeUsage(result.totalUsage),
        modelId: result.response.modelId,
      });
      return result.text.trim();
    },
  };
}

/**
 * A completion-only `LLM` over one already-resolved model — the shape the
 * offline raters use (judges, classifiers), where a spec names the model and
 * both backends have their own way of turning that spec into a `LanguageModel`.
 * The reasoning knob follows the stage policy, expressed in whichever provider
 * the spec belongs to rather than always Workers AI's.
 *
 * `stream` throws: these callers do not stream, and an empty generator would
 * turn "wrong seam" into a silently empty answer.
 */
export function createCompletionLLM(opts: {
  model: LanguageModel;
  /** `<provider>/<modelId>` — decides which provider's reasoning knob applies. */
  spec: string;
  stage: InferenceStage;
  /** Where this model's calls are reported, and as whose spend. One field, both
   *  halves: these callers are the outcome-ensemble judges AND the calibration
   *  classifiers, so the same completion shape is `judge` in one and `fast` in
   *  the other and only the caller knows which. Absent means this rater's spend
   *  is attributed to nothing. */
  spend?: ModelCallSpend;
}): LLM {
  const providerOptions = reasoningEffortOptions(
    REASONING_EFFORT_FOR_STAGE[opts.stage],
    parseModelSpec(opts.spec).provider,
  );
  const spend = opts.spend;
  return {
    stream() {
      throw new Error(`createCompletionLLM(${opts.spec}) has no streaming path`);
    },
    async complete(prompt) {
      const result = await generateText({
        model: opts.model,
        prompt,
        providerOptions,
      });
      // `spec` is what the caller resolved and therefore what the catalog
      // prices; `modelId` is what the provider says served it.
      spend?.report({
        source: spend.source,
        usage: normalizeUsage(result.totalUsage),
        spec: opts.spec,
        modelId: result.response.modelId,
      });
      return result.text.trim();
    },
  };
}

// ── Metering the seam ────────────────────────────────────────────

/** What passed through one metered `LLM`, counted at the seam. Characters
 *  rather than tokens because that is what the seam actually sees — the
 *  `LLM` interface returns text, not usage. */
export interface LLMUsage {
  calls: number;
  promptChars: number;
  responseChars: number;
}

export interface MeteredLLM {
  llm: LLM;
  usage: LLMUsage;
}

/** Characters per token, for sizing a run before paying for it. A blunt
 *  average over English prose and code; the true ratio is model-specific and
 *  the seam cannot see it. Only ever used to ESTIMATE, and every caller says
 *  so where it prints. */
export const CHARS_PER_TOKEN = 4;

/** Rough blended USD per 1k tokens. A deliberately conservative mid-range
 *  blend (≈ $3 / 1M tokens) so anything sized with it errs toward
 *  over-estimating spend.
 *
 *  The FALLBACK, not the rate: `ModelInfo.cost` now carries models.dev's real
 *  per-model prices, and the mission-budget ledger prices every call it can
 *  attribute to the actor's model from them (recording the tokens it could
 *  not). This stays for the seams that see characters rather than usage — the
 *  `LLM` primitive here, and MCTS's pre-run size estimate. */
export const BLENDED_USD_PER_1K_TOKENS = 0.003;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateUsdCost(tokens: number): number {
  return (tokens / 1000) * BLENDED_USD_PER_1K_TOKENS;
}

/**
 * An `LLM` that counts what goes through it.
 *
 * The returned `usage` is the live counter — read it after the pass, not
 * before. Wrapping rather than threading a counter through every caller keeps
 * the seam itself unchanged, which is what lets a test script an `LLM` and
 * still get telemetry out of the harness that used it.
 */
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
 * Collect text from a generateText result.
 *
 * Some models (e.g. Kimi K2.5) end on a tool-call step with no trailing text.
 * AI SDK v6 only puts text from the final step into result.text, so it's empty.
 *
 * Strategy:
 * 1. Use result.text if non-empty (happy path)
 * 2. Gather text fragments from all steps
 * 3. If still empty, synthesize a summary from tool call results
 */
export function collectStepText(result: { text: string; steps: StepResult<ToolSet>[] }): string {
  if (result.text) return result.text;

  const textParts: string[] = [];
  for (const step of result.steps) {
    if (step.text) textParts.push(step.text);
  }
  if (textParts.length > 0) return textParts.join('\n\n');

  // No text in any step — synthesize from tool results
  const toolSummaries: string[] = [];
  for (const step of result.steps) {
    for (const tr of step.toolResults) {
      const output = tr.output;
      const parsedText = v.safeParse(v.string(), output);
      const text = parsedText.success ? parsedText.output : JSON.stringify(output ?? '');
      toolSummaries.push(`[${tr.toolName}] ${text.slice(0, 500)}`);
    }
  }
  return toolSummaries.length > 0
    ? toolSummaries.join('\n')
    : '(no response)';
}

/**
 * Unified chat-model factory for the CLI's endpoint-configured models.
 * Returns a Vercel AI SDK LanguageModel suitable for passing to generateText /
 * streamText / Think. For an LLM primitive (with .stream/.complete), use
 * createVercelAILLM.
 */
// NOTE: the live Workers AI path is `createWorkersAIProvider` (cf-backend),
// which correctly types sessionAffinity as a string. The CLI is the only
// `createChatModel` caller and uses `openai-compat` / `anthropic`.
export type ChatModelConfig =
  | {
      kind: 'openai-compat';
      name?: string;
      baseURL: string;
      headers: Record<string, string>;
      modelId: string;
      fetch?: typeof fetch;
    }
  | {
      kind: 'anthropic';
      baseURL?: string;
      headers: Record<string, string>;
      modelId: string;
      fetch?: typeof fetch;
    };

export function createChatModel(config: ChatModelConfig): LanguageModel {
  if (config.kind === 'anthropic') {
    return createAnthropicModel({
      name: 'anthropic',
      baseURL: config.baseURL ?? 'https://api.anthropic.com/v1',
      headers: config.headers,
      model: config.modelId,
      fetch: config.fetch,
    });
  }
  return createOpenAICompatible({
    name: config.name ?? 'openai-compat',
    baseURL: config.baseURL,
    headers: config.headers,
    fetch: withRateLimitRetry(config.fetch ?? fetch),
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
  config: Pick<LLMProviderConfig, 'name' | 'baseURL' | 'headers' | 'model'> & { fetch?: typeof fetch },
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
    authToken: authToken || undefined,
    headers,
    fetch: withRateLimitRetry(config.fetch ?? fetch),
  });
  return provider.languageModel(config.model);
}

function bearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(value ?? '');
  return match?.[1]?.trim() || undefined;
}
