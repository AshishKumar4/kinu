/**
 * A visitor's Cap'n Web batch against a live-shared slate's origin: one call,
 * one settled answer. A refusal arrives as the rejection the guest's binding
 * proxy threw, whose message names the share's own reason. Lives here so the
 * first-run tier drives a share the way a browser does without the root
 * closure carrying the wire library itself.
 */
import { newHttpBatchRpcSession } from 'capnweb';
import * as v from 'valibot';
import { VIEWER_EXCHANGE_PATH, type JsonValue } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';

export type SlateViewerAnswer<Value> = { readonly value: Value } | { readonly error: string };

/**
 * The consent a credentialed share asks of every viewer before anything of
 * the owner's runs: the page's Continue button is a GET the edge answers
 * with a 303 and the consent-minted cookie. This presses it and returns the
 * cookie a viewer then carries, so a probe reaches the slate the way a
 * person who read the page does. A share that reaches nothing credentialed
 * mints one too; it is simply never asked for.
 */
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
