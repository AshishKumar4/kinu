/**
 * The knock budget every UNAUTHENTICATED rail that chooses a Durable Object by
 * a caller-supplied name spends before it chooses one.
 *
 * Two rails need it and they need the same thing, which is why it is here
 * rather than in either: the device tunnel's ticket exchange (`pc-handler.ts`)
 * and the public webhook delivery path (`server.ts`). Both are reached before
 * any identity is established, both name their object from the URL, and for
 * both the credential that would settle the question lives INSIDE the object
 * they are about to wake. So neither can authenticate first, and an unbudgeted
 * knock is a persistent object and its storage for the price of one request.
 *
 * This is rate limiting, NOT route verification, and the difference matters.
 * A rail that could verify its target from the edge should do that instead;
 * pc-handler.ts records what such a migration would take for the device token.
 * Until then the honest control is a bound on how often one source may knock.
 *
 * Exact residuals of that choice:
 *   1. KV is eventually consistent, so isolates in different PoPs can each read
 *      a stale count during the propagation window (tens of seconds) and
 *      together exceed the nominal per-window budget by roughly their number.
 *   2. A request already admitted cannot be revoked; each admitted knock still
 *      wakes exactly one object.
 *   3. Every source behind one NAT address shares one budget.
 *   4. Counters are fixed-window, so a source can spend a full budget at each
 *      window boundary.
 * A distributed attacker rotating IPs stays under the per-source radar. Closing
 * that needs an edge-checkable identifier, which is a per-rail migration.
 */
import * as v from 'valibot';
import { json } from './http';
import { readKvJson, writeKvJson, type KvStore } from './kv';
import { sha256Hex } from './crypto';

const INGRESS_WINDOW_MS = 60_000;

const INGRESS_WINDOW_SCHEMA = v.object({ count: v.number(), windowStart: v.number() });

/** One admission decision on one rail. Counts the source's knocks in the
 *  current fixed window through AUTH_KV and admits while under budget. The
 *  get-then-put is not atomic across isolates; residual 1 above states exactly
 *  what that costs. */
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
  await writeKvJson(kv, key, { count, windowStart }, windowStart + 2 * INGRESS_WINDOW_MS);
  return true;
}

export function ingressDenied(): Response {
  return json({ error: "too many attempts; retry after a minute" }, { status: 429 });
}

export function peerIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}
