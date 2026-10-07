/** LLM wrapper over the Vercel AI SDK, shared by the CF and CLI backends; callers supply URL, auth and model. */

import type { LanguageModel } from 'ai';
import type { LLM } from './types/primitives';
import type { ModelCallSpend } from './events/model-call';
import { generateReported, streamTextReported } from './providers/model-invocation';
import { createWireModel, withModelStack } from './providers/wire-model';

export interface LLMProviderConfig {
  name: string;
  baseURL: string;
  headers: Record<string, string>;
  model: string;
}

/** `spend` is where this LLM's calls are reported, and as whose; one argument so the sink cannot be wired without
 *  the label. */
export function createVercelAILLM(config: LLMProviderConfig, spend: ModelCallSpend): LLM {
  const model = withModelStack(createModelFromLLMConfig(config), { provider: config.name, modelId: config.model, lane: config.name });
  // No output cap: a reasoning model spends its budget thinking first, so a cap truncates or starves the answer.

  return {
    stream: (opts) => streamTextReported({
      model,
      instructions: opts.system,
      messages: opts.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
    }, { spend }),

    // No `spec`: this factory has no catalog spec to price.
    complete: async (prompt) => (await generateReported({ model, prompt }, { spend })).text.trim(),
  };
}

/** Chat-model factory for the CLI's endpoint-configured models, called through the registry's stack; for an `LLM`
 *  (`.stream`/`.complete`), use createVercelAILLM. */
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

  return createWireModel({
    name: config.name ?? 'openai-compat', modelId: config.modelId, baseURL: config.baseURL, headers: config.headers,
    protocol: 'chat-completions', reasoning: false, ...(config.fetch !== undefined && { fetch: config.fetch }),
  });
}

function createModelFromLLMConfig(config: LLMProviderConfig): LanguageModel {
  if (config.name === 'anthropic') return createAnthropicModel(config);

  return createWireModel({ name: config.name, modelId: config.model, baseURL: config.baseURL, headers: config.headers, protocol: 'chat-completions', reasoning: false });
}

function createAnthropicModel(config: Pick<LLMProviderConfig, 'name' | 'baseURL' | 'headers' | 'model'> & { fetch?: typeof fetch }): LanguageModel {
  return createWireModel({
    name: config.name, modelId: config.model, baseURL: config.baseURL, headers: config.headers, protocol: 'messages', reasoning: false,
    ...(config.fetch !== undefined && { fetch: config.fetch }),
  });
}
