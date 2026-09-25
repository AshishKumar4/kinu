import { asFetchFunction, abortCause, EGRESS_REFUSAL_HEADER, refusalError } from '@kinu.run/core';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import type { CodexEgress } from './codex-egress';

export interface CodexEgressNamespace<Id = DurableObjectId> {
  idFromName(name: string): Id;
  get(id: Id): {
    forward(...args: Parameters<CodexEgress['forward']>): Promise<Response>;
    cancel(...args: Parameters<CodexEgress['cancel']>): Promise<void>;
  };
}

export function codexEgressFetch<Id>(namespace: CodexEgressNamespace<Id>, ownerUserId: string): typeof fetch {
  const stub = namespace.get(namespace.idFromName(ownerUserId));

  return asFetchFunction(async (input, init) => {
    const signal = init?.signal ?? undefined;

    if (signal?.aborted) throw abortCause(signal);
    const callId = crypto.randomUUID();
    const request = new Request(input, { ...init, signal: null });
    const stopped = Promise.withResolvers<never>();

    signal?.addEventListener('abort', () => {
      stopped.reject(abortCause(signal));
      stub.cancel(callId).catch((...rejection: [unknown]) => diagnostics.failure('codex_egress.cancel_failed', toKinuError({
        doing: 'cancelling a Codex egress call', cause: rejection[0], otherwise: 'unavailable',
      })));
    }, { once: true });

    const response = await Promise.race([stub.forward(ownerUserId, callId, request), stopped.promise]);
    const refusal = response.headers.get(EGRESS_REFUSAL_HEADER);

    if (refusal !== null) throw refusalError({ url: request.url, refusal, message: await response.text() });

    return response;
  });
}
