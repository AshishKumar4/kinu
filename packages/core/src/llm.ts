/** Endpoint-configured chat models over the Vercel AI SDK; callers supply URL, auth and model. */

import type { LanguageModel } from 'ai';
import { createWireModel } from './providers/wire-model';

export interface LLMProviderConfig {
  name: string;
  baseURL: string;
  headers: Record<string, string>;
  model: string;
}

/** Chat-model factory for the CLI's endpoint-configured models, called through the registry's stack. */
export type ChatModelConfig =
  | {
      kind: 'openai-compat';
      name?: string;
      baseURL: string;
      headers: Record<string, string>;
      modelId: string;
      fetch?: typeof fetch;
      /** The endpoint takes a `json_schema` response format (`WireModelInput.structuredOutputs`). */
      structuredOutputs?: boolean;
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
    ...(config.structuredOutputs === true && { structuredOutputs: true }),
  });
}

function createAnthropicModel(config: Pick<LLMProviderConfig, 'name' | 'baseURL' | 'headers' | 'model'> & { fetch?: typeof fetch }): LanguageModel {
  return createWireModel({
    name: config.name, modelId: config.model, baseURL: config.baseURL, headers: config.headers, protocol: 'messages', reasoning: false,
    ...(config.fetch !== undefined && { fetch: config.fetch }),
  });
}
