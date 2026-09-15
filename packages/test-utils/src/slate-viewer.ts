/**
 * A visitor's Cap'n Web batch against a live-shared slate's origin: one call,
 * one settled answer. A refusal arrives as the rejection the guest's binding
 * proxy threw, whose message names the share's own reason. Lives here so the
 * first-run tier drives a share the way a browser does without the root
 * closure carrying the wire library itself.
 */
import { newHttpBatchRpcSession } from 'capnweb';
import * as v from 'valibot';
import type { JsonValue } from '@kinu.run/core';

export type SlateViewerAnswer<Value> = { readonly value: Value } | { readonly error: string };

export async function callSharedSlate<Value>(
  url: string, method: string, schema: v.GenericSchema<JsonValue, Value>,
): Promise<SlateViewerAnswer<Value>> {
  const stub = newHttpBatchRpcSession<Record<string, () => Promise<JsonValue>>>(new URL('/__rpc', url).toString());

  try {
    return { value: v.parse(schema, await stub[method]()) };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}
