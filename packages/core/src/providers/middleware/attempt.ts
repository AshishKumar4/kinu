/**
 * One provider attempt's reach below the model stack: its own cancel, which the retry layer fires when the attempt goes
 * silent, and its wire's activity, which a transport reports as bytes arrive. SSE comments are activity no stream part
 * carries (OpenRouter's `: OPENROUTER PROCESSING` while a model thinks).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { asFetchFunction } from '../fetch-shim';

export interface Attempt {
  readonly signal: AbortSignal;
  readonly heard: () => void;
}

const current = new AsyncLocalStorage<Attempt>();

export function inAttempt<T>(attempt: Attempt, run: () => T): T {
  return current.run(attempt, run);
}

/** The model under the stack: each call's cancel joined with its attempt's, so an abandoned attempt stops upstream. */
export function attemptBound(model: LanguageModelV4): LanguageModelV4 {
  const signalled = (options: LanguageModelV4CallOptions): LanguageModelV4CallOptions => {
    const attempt = current.getStore();

    if (attempt === undefined) return options;

    return { ...options, abortSignal: options.abortSignal === undefined ? attempt.signal : AbortSignal.any([options.abortSignal, attempt.signal]) };
  };

  return {
    specificationVersion: 'v4',
    provider: model.provider,
    modelId: model.modelId,
    get supportedUrls() {
      return model.supportedUrls;
    },
    doGenerate: (options) => model.doGenerate(signalled(options)),
    doStream: (options) => model.doStream(signalled(options)),
  };
}

/** A transport whose answers report each arriving chunk to the attempt that sent them. */
export function heardFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return asFetchFunction(async (input, init) => {
    const attempt = current.getStore();
    const response = await fetch(input, init);

    if (attempt === undefined || response.body === null) return response;

    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        attempt.heard();
        controller.enqueue(chunk);
      },
    }));

    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  });
}
