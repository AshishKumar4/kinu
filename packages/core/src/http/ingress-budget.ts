/**
 * Knock budget for unauthenticated rails that pick a Durable Object by caller-supplied name before any identity
 * exists (`pc-handler.ts` ticket exchange, webhook deliveries). Rate limiting, not route verification.
 */
import * as v from 'valibot';
import { json } from './http';
import { readKvJson, writeKvJson, type KvStore } from '@kinu.run/agent-utils';
import { sha256Hex } from '../safety/argument-digest';

const INGRESS_WINDOW_MS = 60_000;

const INGRESS_WINDOW_SCHEMA = v.object({ count: v.number(), windowStart: v.number() });

/** Fixed-window per-source counter in AUTH_KV. Get-then-put is not atomic across isolates, so PoPs can overshoot. */
export async function ingressAdmitted(
  kv: KvStore,
  rail: string,
  ip: string,
  limit: number,
): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - (now % INGRESS_WINDOW_MS);
  const source = await sha256Hex(`${rail}\u0000${ip}`);
  const key = `ingress:${String(windowStart)}:${source}`;
  const current = await readKvJson(kv, key, INGRESS_WINDOW_SCHEMA);
  const count = (current !== null && current.windowStart === windowStart ? current.count : 0) + 1;

  if (count > limit) return false;
  await writeKvJson(kv, key, { count, windowStart }, windowStart + 2 * INGRESS_WINDOW_MS - now);

  return true;
}

export function ingressDenied(): Response {
  return json({ body: { error: "too many attempts; retry after a minute" } }, { status: 429 });
}

export function peerIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}
