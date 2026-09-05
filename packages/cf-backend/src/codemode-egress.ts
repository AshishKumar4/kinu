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
 * ── One destination judgment, at every seam that has one ──────────
 * The program is LLM-authored, so where it may reach is not the program's
 * decision. `refusedHostname` (packages/core/src/safety/egress-destination.ts)
 * is the project's one classifier, and this is its third enforcement point: the
 * container's egress hop judges with it (`egress/outbound.ts`), the agent's own
 * `web.fetch` judges with it (`core/src/web/url-safety.ts`), and the same
 * request as `fetch()` inside an `execute_tools` program used to be judged by
 * nothing at all — while the identical URL was DENIED as a shell command by the
 * approval gate. One judgment for the whole project means this seam asks it
 * too.
 *
 * A REDIRECT IS A DESTINATION. `redirect: 'manual'` for the same reason
 * `egress/outbound.ts` forces it: a hop the runtime follows never re-enters
 * this handler, so a public host that answers 302 to 169.254.169.254 would
 * reach it unjudged. The 3xx is handed back to the program, which is a real
 * behaviour difference — a program that wants the redirect target reads
 * `Location` and fetches it, and that fetch is judged like the first.
 *
 * What this is NOT: a policy about what a program MAY do with a public
 * destination. The programs are the owner's own code, run against the owner's
 * own account, so what the sandbox may reach is what the Worker may reach,
 * minus the addresses no untrusted code may reach.
 *
 * ── The residual, and it is NOT measured ─────────────────────────
 * The classifier judges LITERALS and reserved names. A hostname that is public
 * in spelling and RESOLVES to a private address is not caught here, because
 * this seam has no resolution to inspect — the same residual
 * `safety/egress-destination.ts` states for the other two. What bounds it is a
 * platform property nothing in this repository measures: that Workers `fetch`
 * egress does not reach RFC1918 or link-local addresses. Settling that needs a
 * deployed run, not a reading: on a STAGING deployment, one `execute_tools`
 * program that fetches a name whose A record points at 169.254.169.254 and one
 * that fetches a public control, with both outcomes recorded. Source cannot
 * answer it: no line here decides what the runtime's resolver and egress path
 * do with an address they were handed.
 */

import { WorkerEntrypoint, exports } from 'cloudflare:workers';
import { refusedHostname } from '@kinu.run/core';
import { diagnostics, renderThrownChain, KinuError } from '@kinu.run/core/obs';

/** The header a failed egress answers with. An exception thrown inside a
 *  loopback entrypoint reaches the caller as an opaque `internal error`, so the
 *  failure travels as a response the sandbox's `fetch` turns back into the
 *  rejection a Node program expects (codemode-node-shim.ts `createFetch`). */
export const EGRESS_FAILURE_HEADER = 'x-kinu-egress-failure';

/**
 * Judge, then forward.
 */
async function forwardCodemodeEgress(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const refusal = refusedHostname(url.hostname);
  if (refusal !== null) {
    diagnostics.failure(
      'egress.private_destination',
      new KinuError('denied', refusal.error),
      { host: url.hostname, seam: 'codemode' },
    );
    return Response.json(refusal, {
      status: 403,
      headers: { [EGRESS_FAILURE_HEADER]: '1' },
    });
  }
  try {
    return await fetch(new Request(request, {
      redirect: request.redirect === 'error' ? 'error' : 'manual',
    }));
  } catch (cause) {
    return new Response(renderThrownChain({ cause }), {
      status: 502,
      headers: { [EGRESS_FAILURE_HEADER]: '1' },
    });
  }
}

export class CodemodeEgress extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    return await forwardCodemodeEgress(request);
  }
}

/**
 * The loopback stub for {@link CodemodeEgress}, or null where the runtime
 * exposes none (a test harness that loads this module outside workerd).
 */
export function codemodeEgress(): Fetcher | null {
  return exports.CodemodeEgress ?? null;
}
