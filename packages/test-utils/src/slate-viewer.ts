/** A visitor's Cap'n Web batch against a shared slate's origin; a refusal rejects with the share's reason. */
import { Cause, Effect } from 'effect';
import { newHttpBatchRpcSession } from 'capnweb';
import * as v from 'valibot';
import { VIEWER_EXCHANGE_PATH, type JsonValue } from '@kinu.run/core';
import { renderThrownChain, settle } from '@kinu.run/core/obs';

export type SlateViewerAnswer<Value> = { readonly value: Value } | { readonly error: string };

/**
 * Enters a share as a visitor with no account, as Kinu's share page does (a post into its frame from Kinu's own origin):
 * accepting what its grant reaches with the open answer's `binding`, or, reaching nothing, saying no account. The viewer
 * cookie.
 */
export function consentToShare(entry: { readonly url: string; readonly origin: string; readonly binding: string | null }): Promise<string> {
  return settle(Effect.gen(function* () {
    const { url, origin, binding } = entry;

    const response = yield* Effect.promise(async () => fetch(new URL(VIEWER_EXCHANGE_PATH, url), {
      method: 'POST', redirect: 'manual', body: new URLSearchParams(binding === null ? { out: '1' } : { consent: binding }),
      headers: { origin: new URL(origin).origin, 'content-type': 'application/x-www-form-urlencoded' },
    }));

    const cookie = response.headers.get('set-cookie')?.split(';')[0];

    if (response.status !== 303 || cookie === undefined) {
      return yield* Effect.die(new Error(`the consent exchange at ${url} answered ${String(response.status)} with ${cookie === undefined ? 'no cookie' : 'a cookie'}`));
    }

    return cookie;
  }));
}

export function callSharedSlate<Value>(
  url: string, method: string, schema: v.GenericSchema<JsonValue, Value>, cookie?: string,
): Promise<SlateViewerAnswer<Value>> {
  const target = new URL('/__rpc', url).toString();

  // A viewer's cookie acts only from its share's own page, as a browser sends it there (slate-share-route.ts).
  const stub = newHttpBatchRpcSession<Record<string, () => Promise<JsonValue>>>(
    cookie === undefined ? target : new Request(target, { method: 'POST', headers: { cookie, origin: new URL(url).origin } }),
  );

  return settle(Effect.matchCause(Effect.promise(async () => v.parse(schema, await stub[method]())), {
    onSuccess: (value) => ({ value }),
    onFailure: (failed) => ({ error: renderThrownChain({ cause: Cause.squash(failed) }) }),
  }));
}
