import { APICallError } from 'ai';
import { abortCause } from '../utils/abort';
import { renderThrownChain } from '../obs/index';

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

  async run(callId: string, work: {
    readonly start: (signal: AbortSignal) => Promise<void>;
    readonly fetch: (signal: AbortSignal) => Promise<Response>;
  }): Promise<Response> {
    const controller = new AbortController();
    this.#live.set(callId, controller);
    const end = (): void => { this.#live.delete(callId); };

    try {
      await work.start(controller.signal);
    } catch (cause) {
      end();

      if (controller.signal.aborted) throw abortCause(controller.signal);

      return startRefusal(renderThrownChain({ cause }));
    }

    let response: Response;

    try {
      controller.signal.throwIfAborted();
      response = await work.fetch(controller.signal);
    } catch (cause) {
      end();
      throw cause;
    }

    if (response.body === null) {
      end();

      return response;
    }

    return new Response(response.body.pipeThrough(new TransformStream({ flush: end })), response);
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
