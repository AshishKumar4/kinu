// The one place a wire protocol becomes an SDK model.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';
import { statelessResponses } from './util';

export type WireProtocol = 'responses' | 'messages' | 'chat-completions';

export const OPENAI_AUTHOR = 'openai/';

export const ANTHROPIC_AUTHOR = 'anthropic/';

/** The bare id of a gateway `openai/` model, else null. */
export function gatewayOpenAIModel(modelId: string | undefined): string | null {
  return modelId?.startsWith(OPENAI_AUTHOR) === true ? modelId.slice(OPENAI_AUTHOR.length) : null;
}

export interface WireModelInput {
  readonly name: string;
  readonly modelId: string;
  readonly baseURL: string;
  readonly protocol: WireProtocol;
  readonly reasoning: boolean;
  readonly fetch?: typeof fetch;
  readonly headers?: Record<string, string>;
}

export function createWireModel(input: WireModelInput): LanguageModelV4 {
  const { name, modelId, baseURL, headers } = input;
  const fetched = input.fetch === undefined ? {} : { fetch: input.fetch };

  if (input.protocol === 'messages') return createAnthropic({ name, baseURL, authToken: 'placeholder', headers, ...fetched })(modelId);

  return input.protocol === 'responses'
    ? wrapLanguageModel({
      model: createOpenAI({ name, baseURL, apiKey: 'placeholder', headers, ...fetched }).responses(modelId),
      middleware: statelessResponses(input.reasoning),
    })
    : createOpenAICompatible({ name, baseURL, headers, ...fetched }).chatModel(modelId);
}

/** `createModel` is synchronous and the wire is read from the catalog: resolved per call. */
export function deferredModel(provider: string, modelId: string, resolve: () => Promise<LanguageModelV4>): LanguageModelV4 {
  return {
    specificationVersion: 'v4', provider, modelId,
    get supportedUrls() { return resolve().then((resolved) => resolved.supportedUrls); },
    async doGenerate(options) { return (await resolve()).doGenerate(options); },
    async doStream(options) { return (await resolve()).doStream(options); },
  };
}
