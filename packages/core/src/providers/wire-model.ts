// The one place a wire protocol becomes an SDK model.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';
import { statelessResponses } from './util';

export type WireProtocol = 'responses' | 'messages' | 'chat-completions';

export const OPENAI_AUTHOR = 'openai/';

const ANTHROPIC_AUTHOR = 'anthropic/';

/** The API a gateway model is spoken to in, and the id its SDK is built with. */
export interface GatewayWire {
  readonly protocol: WireProtocol;
  readonly modelId: string;
}

/** Each author's own API where the gateway serves one (`/responses`, `/messages`), else its unified chat API. */
export function gatewayWire(modelId: string): GatewayWire {
  // The Anthropic SDK reads Claude's limits by Anthropic's own id.
  if (modelId.startsWith(ANTHROPIC_AUTHOR)) return { protocol: 'messages', modelId: modelId.slice(ANTHROPIC_AUTHOR.length).replaceAll('.', '-') };

  if (modelId.startsWith(OPENAI_AUTHOR)) return { protocol: 'responses', modelId: modelId.slice(OPENAI_AUTHOR.length) };

  return { protocol: 'chat-completions', modelId };
}

/** The API a route's provider fixes for its model, null where the catalog decides per model. */
export function routeProtocol(providerId: string | undefined, modelId: string | undefined): WireProtocol | null {
  if (providerId === 'anthropic' || providerId === 'claude') return 'messages';

  return providerId === 'my-gateway' && modelId !== undefined ? gatewayWire(modelId).protocol : null;
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
