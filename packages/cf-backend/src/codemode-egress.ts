/**
 * Outbound network policy for eval and resident slate code, exported via
 * workerd `enable_ctx_exports` as the WorkerLoader `globalOutbound`.
 * Applies `refusedHostname` like `egress/outbound.ts` and `web/url-safety.ts`.
 * redirect:manual so no unjudged destination is followed. Unmeasured residual:
 * public names resolving to private addresses are not caught here.
 */

import { WorkerEntrypoint, exports } from 'cloudflare:workers';
import { refusedHostname } from '@kinu.run/core';
import { diagnostics, renderThrownChain, KinuError } from '@kinu.run/core/obs';

/** Loopback throws reach the caller as opaque `internal error`, so failures
 *  travel as responses (codemode-node-shim.ts `createFetch` rethrows). */
export const EGRESS_FAILURE_HEADER = 'x-kinu-egress-failure';

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

/** Null outside workerd (test harnesses). */
export function codemodeEgress(): Fetcher | null {
  return exports.CodemodeEgress ?? null;
}
