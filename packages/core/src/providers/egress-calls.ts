import { APICallError } from 'ai';
import { abortCause } from '../utils/abort';
import { Effect, Result } from 'effect';
import { renderThrownChain, settle } from '../obs/index';

export const EGRESS_REFUSAL_HEADER = 'x-kinu-egress-refusal';

const NO_INSTANCE = 'there is no container instance that can be provided to this durable object';

function startRefusal(reason: string): Response {
  const busy = reason.toLowerCase().includes(NO_INSTANCE);

  return new Response(
    busy
      ? 'Codex is busy for everyone right now: every Codex egress container is in use. Try again in a minute, or pick another model.'
      : `Codex's egress container failed to start: ${reason}`,
    { status: 503, headers: { [EGRESS_REFUSAL_HEADER]: busy ? 'busy' : 'start', 'content-type': 'text/plain' } },
  );
}

export class EgressCalls {
  readonly #live = new Map<string, AbortController>();

  run(callId: string, work: {
    readonly start: (signal: AbortSignal) => Promise<void>;
    readonly fetch: (signal: AbortSignal) => Promise<Response>;
  }): Promise<Response> {
    return settle(Effect.gen({ self: this }, function* () {
      const controller = new AbortController();
      this.#live.set(callId, controller);
      const end = (): void => { this.#live.delete(callId); };

      const started = yield* Effect.result(Effect.tryPromise({ try: () => work.start(controller.signal), catch: (cause) => ({ cause }) }));

      if (Result.isFailure(started)) {
        end();

        if (controller.signal.aborted) return yield* Effect.die(abortCause(controller.signal));

        return startRefusal(renderThrownChain(started.failure));
      }

      const response = yield* Effect.onError(Effect.promise(async () => {
        controller.signal.throwIfAborted();

        return work.fetch(controller.signal);
      }), () => Effect.sync(end));

      if (response.body === null) {
        end();

        return response;
      }

      return new Response(response.body.pipeThrough(new TransformStream({ flush: end })), response);
    }));
  }

  cancel(callId: string): void {
    this.#live.get(callId)?.abort(new DOMException('the caller stopped the request', 'AbortError'));
    this.#live.delete(callId);
  }

  get size(): number {
    return this.#live.size;
  }
}

export function refusalError(input: { readonly url: string; readonly refusal: string; readonly message: string }): APICallError {
  return new APICallError({
    message: input.message,
    url: input.url,
    requestBodyValues: undefined,
    statusCode: 503,
    isRetryable: false,
    responseBody: JSON.stringify({ error: { message: input.message, code: `codex_egress_${input.refusal}` } }),
  });
}
