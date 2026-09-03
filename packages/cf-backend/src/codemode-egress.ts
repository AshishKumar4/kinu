/**
 * Outbound network for programs run by `execute_tools`.
 *
 * `@cloudflare/codemode`'s DynamicWorkerExecutor takes `globalOutbound`: a
 * Fetcher every `fetch()` / `connect()` inside the sandbox rides, or `null` for
 * no network at all. There is no "inherit the parent's network" option, so the
 * Worker exports this entrypoint and hands the sandbox its own loopback stub —
 * workerd's `enable_ctx_exports` (compatibility date ≥ 2025-11-17; this Worker
 * is at 2025-12-01) populates `exports` from the module's exports, the same way
 * Nimbus reaches `NimbusDOStub` and the Sandbox SDK reaches `ContainerProxy`.
 * `env.d.ts` declares this one export in `Cloudflare.GlobalProps`, which is
 * what types `exports.CodemodeEgress` as the loopback stub.
 *
 * A pass-through on purpose: the agent's programs are the owner's own code,
 * run against the owner's own account. What the sandbox may reach is what the
 * Worker may reach.
 */

import { WorkerEntrypoint, exports } from 'cloudflare:workers';
import { renderThrownChain } from '@kinu.run/core/obs';

/** The header a failed egress answers with. An exception thrown inside a
 *  loopback entrypoint reaches the caller as an opaque `internal error`, so the
 *  failure travels as a response the sandbox's `fetch` turns back into the
 *  rejection a Node program expects (codemode-node-shim.ts `createFetch`). */
export const EGRESS_FAILURE_HEADER = 'x-kinu-egress-failure';

export class CodemodeEgress extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    try {
      return await fetch(request);
    } catch (cause) {
      return new Response(renderThrownChain({ cause }), { status: 502, headers: { [EGRESS_FAILURE_HEADER]: '1' } });
    }
  }
}

/**
 * The loopback stub for {@link CodemodeEgress}, or null where the runtime
 * exposes none (a test harness that loads this module outside workerd).
 */
export function codemodeEgress(): Fetcher | null {
  return exports.CodemodeEgress ?? null;
}
