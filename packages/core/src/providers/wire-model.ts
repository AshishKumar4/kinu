// The one place a wire protocol becomes an SDK model.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import * as v from 'valibot';
import { attemptBound } from './middleware/attempt';
import { retryMiddleware, type RetryPolicy } from './middleware/retry';
import { usageRepairMiddleware } from './middleware/usage-repair';
import { toolImages } from './tool-result-images';
import { statelessResponses } from './util';
import { heardFetch } from './middleware/attempt';
import { asFetchFunction } from './fetch-shim';

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

/** The API an AI SDK package speaks (models.dev and OpenCode name a model's by its npm package); reasoning never picks it. */
export function sdkWire(npm: string | undefined): WireProtocol {
  if (npm === '@ai-sdk/openai') return 'responses';

  return npm === '@ai-sdk/anthropic' ? 'messages' : 'chat-completions';
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

/** The global fetch as it is when called: a caller may replace it after the model is built. */
const globalFetch = asFetchFunction((input, init) => fetch(input, init));

/** The SDK model a wire protocol speaks; the registry wraps it in the one stack. */
export function createWireModel(input: WireModelInput): LanguageModelV4 {
  const { name, modelId, baseURL, headers } = input;
  const fetched = { fetch: heardFetch(input.fetch ?? globalFetch) };

  if (input.protocol === 'messages') return createAnthropic({ name, baseURL, ...anthropicAuth(headers ?? {}), ...fetched })(modelId);

  return input.protocol === 'responses'
    ? wrapLanguageModel({
      model: createOpenAI({ name, baseURL, apiKey: 'placeholder', headers, ...fetched }).responses(modelId),
      middleware: statelessResponses(input.reasoning),
    })
    : createOpenAICompatible({ name, baseURL, headers, ...fetched }).chatModel(modelId);
}

/** The one stack every model is called through, applied where it is resolved (`registry.resolve`). */
export function withModelStack(model: LanguageModel, policy: RetryPolicy): LanguageModel {
  if (v.is(v.string(), model) || model.specificationVersion === 'v2') return model;

  const v4 = model.specificationVersion === 'v4' ? model : wrapLanguageModel({ model, middleware: [] });

  return wrapLanguageModel({ model: attemptBound(v4), middleware: [retryMiddleware(policy), usageRepairMiddleware(), toolImages(undefined)] });
}

/** Anthropic's SDK sends a key as `x-api-key` and a token as a bearer: a given header is moved into its setting, and
 *  without one a transport that injects the login stands behind a placeholder. */
function anthropicAuth(given: Readonly<Record<string, string>>) {
  const headers = Object.fromEntries(Object.entries(given).filter(([key]) => !['x-api-key', 'authorization'].includes(key.toLowerCase())));
  const read = (wanted: string): string | undefined => Object.entries(given).find(([key]) => key.toLowerCase() === wanted)?.[1];
  const apiKey = read('x-api-key');
  const bearer = /^Bearer\s+(.+)$/iu.exec(read('authorization') ?? '')?.[1]?.trim();

  if (apiKey !== undefined && apiKey !== '') return { apiKey, headers };

  return { authToken: bearer === undefined || bearer === '' ? 'placeholder' : bearer, headers };
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
