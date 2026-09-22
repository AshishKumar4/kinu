/** A visitor's Cap'n Web batch against a shared slate's origin; a refusal rejects with the share's reason. */
import { newHttpBatchRpcSession } from 'capnweb';
import * as v from 'valibot';
import { VIEWER_EXCHANGE_PATH, type JsonValue } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';

export type SlateViewerAnswer<Value> = { readonly value: Value } | { readonly error: string };

/** Presses a credentialed share's consent Continue (GET → 303 + cookie) and returns the viewer cookie. */
export async function consentToShare(url: string): Promise<string> {
  const response = await fetch(new URL(`${VIEWER_EXCHANGE_PATH}?consent=1`, url), { redirect: 'manual' });

  const cookie = response.headers.get('set-cookie')?.split(';')[0];

  if (response.status !== 303 || cookie === undefined) {
    throw new Error(`the consent exchange at ${url} answered ${String(response.status)} with ${cookie === undefined ? 'no cookie' : 'a cookie'}`);
  }

  return cookie;
}

export async function callSharedSlate<Value>(
  url: string, method: string, schema: v.GenericSchema<JsonValue, Value>, cookie?: string,
): Promise<SlateViewerAnswer<Value>> {
  const target = new URL('/__rpc', url).toString();

  const stub = newHttpBatchRpcSession<Record<string, () => Promise<JsonValue>>>(
    cookie === undefined ? target : new Request(target, { method: 'POST', headers: { cookie } }),
  );

  try {
    return { value: v.parse(schema, await stub[method]()) };
  } catch (cause) {
    return { error: renderThrownChain({ cause }) };
  }
}
