// The one place a wire protocol becomes an SDK model.
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import * as v from 'valibot';
import { attemptBound } from './middleware/attempt';
import { retryMiddleware, type RetryPolicy } from './middleware/retry';
import { toolSchemaDialect } from './middleware/tool-schema-dialect';
import { usageRepairMiddleware } from './middleware/usage-repair';
import { toolImages } from './tool-result-images';
import { statelessResponses } from './util';
import { heardFetch } from './middleware/attempt';
import { asFetchFunction } from './fetch-shim';

/** `openai-chat`: OpenAI's own Chat Completions, through OpenAI's client, which knows its token field and its reasoning
 *  models; `chat-completions` is any compatible endpoint's. */
export type WireProtocol = 'responses' | 'messages' | 'chat-completions' | 'openai-chat';

/** The API an AI SDK package speaks (models.dev and OpenCode name a model's by its npm package); reasoning never picks it. */
export function sdkWire(npm: string | undefined): WireProtocol {
  if (npm === '@ai-sdk/openai') return 'responses';

  return npm === '@ai-sdk/anthropic' ? 'messages' : 'chat-completions';
}

export interface WireModelInput {
  readonly name: string;
  readonly modelId: string;
  readonly baseURL: string;
  readonly protocol: WireProtocol;
  readonly reasoning: boolean;
  readonly fetch?: typeof fetch;
  readonly headers?: Record<string, string>;
  /** The chat endpoint takes a `json_schema` response format (Workers AI does); elsewhere a structured call is sent
   *  `json_object` and its answer read through the schema. */
  readonly structuredOutputs?: boolean;
}

/** The global fetch as it is when called: a caller may replace it after the model is built. */
const globalFetch = asFetchFunction((input, init) => fetch(input, init));

/** The SDK model a wire protocol speaks; the registry wraps it in the one stack. */
export function createWireModel(input: WireModelInput): LanguageModelV4 {
  const { name, modelId, baseURL, headers } = input;
  const fetched = { fetch: heardFetch(input.fetch ?? globalFetch) };

  if (input.protocol === 'messages') {
    return lazyModel(name, modelId, async () => (await MODEL_SDKS.anthropic()).createAnthropic({ name, baseURL, ...anthropicAuth(headers ?? {}), ...fetched })(modelId));
  }

  if (input.protocol === 'openai-chat') {
    return lazyModel(`${name}.chat`, modelId, async () => (await MODEL_SDKS.openai()).createOpenAI({ name, baseURL, apiKey: 'placeholder', headers, ...fetched }).chat(modelId));
  }

  return input.protocol === 'responses'
    ? wrapLanguageModel({
      model: lazyModel(`${name}.responses`, modelId, async () => (await MODEL_SDKS.openai()).createOpenAI({ name, baseURL, apiKey: 'placeholder', headers, ...fetched }).responses(modelId)),
      middleware: statelessResponses(input.reasoning),
    })
    : lazyModel(`${name}.chat`, modelId, async () => (await MODEL_SDKS.openaiCompatible()).createOpenAICompatible({
      name, baseURL, headers, ...fetched, ...(input.structuredOutputs === true && { supportsStructuredOutputs: true }),
    }).chatModel(modelId));
}

/** The one stack every model is called through, applied where it is resolved (`registry.resolve`). */
export function withModelStack(model: LanguageModel, policy: RetryPolicy): LanguageModel {
  if (v.is(v.string(), model) || model.specificationVersion === 'v2') return model;

  const v4 = model.specificationVersion === 'v4' ? model : wrapLanguageModel({ model, middleware: [] });

  return wrapLanguageModel({ model: attemptBound(v4), middleware: [retryMiddleware(policy), usageRepairMiddleware(), toolSchemaDialect, toolImages(undefined)] });
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

/** Each model SDK, imported by the first model that speaks it: used heap after setup 26.4 to 25.6 MB in the workspace,
 *  13.9 to 13.1 MB live in a hosted agent's isolate at its first call (armada 20261007182018-643fa40c). */
export const MODEL_SDKS = {
  anthropic: () => import('@ai-sdk/anthropic'),
  openai: () => import('@ai-sdk/openai'),
  openaiCompatible: () => import('@ai-sdk/openai-compatible'),
  workersAi: () => import('workers-ai-provider'),
};

/** A model whose SDK is imported when it is first used: an SDK no turn speaks is never compiled, and its schemas are never
 *  built. Middleware reads `provider` before the SDK loads, so it is the id that SDK names the model with. */
export function lazyModel(provider: string, modelId: string, load: () => Promise<LanguageModelV4>): LanguageModelV4 {
  let loaded: Promise<LanguageModelV4> | undefined;

  return deferredModel(provider, modelId, () => (loaded ??= load()));
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
