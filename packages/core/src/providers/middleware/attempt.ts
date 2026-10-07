/**
 * One provider attempt's reach below the model stack: its own cancel, which the retry layer fires when the attempt goes
 * silent, and its wire's activity, which a transport reports as bytes arrive. SSE comments are activity no stream part
 * carries (OpenRouter's `: OPENROUTER PROCESSING` while a model thinks). Every transport a model can answer through is
 * decorated where it is chosen: `deps.fetch` in `registry.resolve`, each wire model's fetch (`createWireModel`), and
 * the routes that bypass both (a device relay, an egress, a binding); the first to answer within an attempt reports.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { asFetchFunction } from '../fetch-shim';
import type { JsonObject } from '../../utils/json';

export interface Attempt {
  /** Aborted when the attempt is abandoned or its caller cancels. */
  readonly signal: AbortSignal;
  readonly heard: () => void;
  /** True once per attempt: the innermost decorated transport reports, the ones wrapped around it do not. */
  readonly claim: () => boolean;
}

const current = new AsyncLocalStorage<Attempt>();

export function inAttempt<T>(attempt: Attempt, run: () => T): T {
  return current.run(attempt, run);
}

/** The model under the stack: each call is cancelled by its attempt's signal, which also carries the caller's cancel, so
 *  an abandoned attempt stops upstream. */
export function attemptBound(model: LanguageModelV4): LanguageModelV4 {
  const signalled = (options: LanguageModelV4CallOptions): LanguageModelV4CallOptions => {
    const attempt = current.getStore();

    if (attempt === undefined) return options;

    return { ...options, abortSignal: attempt.signal };
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
    const response = await fetch(input, init);
    const body = heardBody(response.body);

    return body === null ? response : new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  });
}

/** What `Ai.run` answers: a raw response when asked for one, a stream, or a parsed completion. */
type BindingAnswer = Response | ReadableStream<Uint8Array> | JsonObject;

/** The binding's `run`, reporting a streamed answer's chunks as `heardFetch` does; any other answer passes as it is. */
export function heardBinding<Binding extends object>(binding: Binding & { run(...args: never[]): Promise<BindingAnswer> }): Binding {
  const run = binding.run.bind(binding);

  return Object.create(binding, { run: { value: async (...args: Parameters<typeof run>) => heardAnswer(await run(...args)) } });
}

function heardAnswer(answer: BindingAnswer): BindingAnswer {
  if (answer instanceof Response) {
    const body = heardBody(answer.body);

    return body === null ? answer : new Response(body, { status: answer.status, statusText: answer.statusText, headers: answer.headers });
  }

  return answer instanceof ReadableStream ? heardBody(answer) ?? answer : answer;
}

/** The body re-read through the attempt's activity report, or null when no attempt is listening or another reports. */
function heardBody(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  const attempt = current.getStore();

  if (attempt === undefined || body === null || !attempt.claim()) return null;

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      attempt.heard();
      controller.enqueue(chunk);
    },
  }));
}
