// The one place a wire protocol becomes an SDK model.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';
import { statelessResponses } from './util';

export type WireProtocol = 'responses' | 'chat-completions';

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

  return input.protocol === 'responses'
    ? wrapLanguageModel({
      model: createOpenAI({ name, baseURL, apiKey: 'placeholder', headers, ...fetched }).responses(modelId),
      middleware: statelessResponses(input.reasoning),
    })
    : createOpenAICompatible({ name, baseURL, headers, ...fetched }).chatModel(modelId);
}

/** `createModel` is synchronous and the wire is read from the catalog, so it resolves at each call. */
export function deferredModel(provider: string, modelId: string, resolve: () => Promise<LanguageModelV4>): LanguageModelV4 {
  return {
    specificationVersion: 'v4', provider, modelId,
    get supportedUrls() { return resolve().then((resolved) => resolved.supportedUrls); },
    async doGenerate(options) { return (await resolve()).doGenerate(options); },
    async doStream(options) { return (await resolve()).doStream(options); },
  };
}
