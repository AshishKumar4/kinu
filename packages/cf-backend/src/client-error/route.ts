/**
 * `POST /api/client-errors` — one browser render failure becomes one line in
 * Workers Logs.
 *
 * ## Where the release identity comes from
 *
 * The browser reports the build it LOADED, and this route does not take its word
 * for it. It reads the build stamp out of the deployed asset bundle — the same
 * read `/api/health` answers with, so there is one source for "which commit is
 * live" — and records both shas plus their relation. A tab held open across a
 * deploy is running code the origin no longer serves, and the resulting render
 * failure is unreproducible against `HEAD`; `releaseMatch: 'stale'` is what
 * turns that from a mystery into a fact.
 *
 * The mismatch is LABELLED, not refused. A stale page's failure is the most
 * interesting report this endpoint receives — it is the whole version-skew
 * failure mode arriving with a stack attached — and rejecting it would discard
 * exactly the evidence the endpoint exists to collect. What refusal is for is a
 * body that is not a report: over the bound, or off the schema.
 *
 * ## What is deliberately not here
 *
 * No row, no object, no data point of its own. The report is a diagnostic, and
 * `diagnostics` already fans out to `console` (which is Workers Logs on workerd)
 * and to the fleet dataset; a second, hand-written mirror would be a second
 * thing to keep consistent and a second retention to reason about.
 *
 * No rate gate either, and that is a decision rather than an omission: this
 * endpoint is reachable only behind the session gate and the CSRF gate, so its
 * callers are signed-in browsers, and one report per caught error per boundary
 * instance is already bounded by the client (`components/ErrorBoundary.tsx`).
 */

import * as v from 'valibot';
import { KinuError, diagnostics, tolerate } from '@kinu.run/core/obs';
import type { AuthIdentity } from '../auth/session';
import { err, json, readBounded } from '../lib/http';
import { readBuildStamp } from '../lib/deployed-assets';
import {
  CLIENT_ERROR_ENDPOINT,
  CLIENT_ERROR_MAX_REQUEST_BYTES,
  CLIENT_RENDER_FAILED,
  ClientErrorReportSchema,
  type ReleaseMatch,
} from './contract';

const OVER_REQUEST_LIMIT = `a render-failure report is limited to ${String(CLIENT_ERROR_MAX_REQUEST_BYTES >> 10)} KiB`;

/**
 * How the reported build relates to the one this deployment serves.
 *
 * `undeployed` is checked FIRST: when the bundle carries no stamp there is
 * nothing to compare against, whatever the browser claimed, and saying `stale`
 * there would be a fabricated finding on every `vite dev` session.
 */
function releaseMatch(reported: string | undefined, current: string | undefined): ReleaseMatch {
  if (current === undefined) return 'undeployed';
  if (reported === undefined) return 'unreported';
  return reported === current ? 'match' : 'stale';
}

/**
 * The whole policy. Answers every request that reaches it.
 *
 * `identity` is nullable and refused here even though `server.ts` calls this
 * behind the auth gate. A route whose authorization is performed only by its
 * caller is one refactor away from being unguarded, and this one writes to the
 * operator's log sink: an anonymous writer would be a log-injection endpoint.
 */
async function handleClientErrorReport(
  request: Request,
  env: Env,
  identity: AuthIdentity | null,
): Promise<Response> {
  if (identity === null) return err(401, 'sign in to report a render failure');

  // `readBounded` owns both halves of the bound — the declared-length pre-filter
  // and the count of arriving bytes — so this route states the limit and reads
  // the outcome. The limit is Analytics Engine's per-data-point text budget; see
  // `contract.ts` for why that is the number and not a choice made here.
  const bounded = await readBounded(request, CLIENT_ERROR_MAX_REQUEST_BYTES);
  if (bounded === 'too_large') return err(413, OVER_REQUEST_LIMIT);
  if (bounded instanceof KinuError) {
    diagnostics.failure('client.report_unreadable', bounded);
    return err(400, 'could not read the request body');
  }

  const parsed = v.safeParse(
    ClientErrorReportSchema,
    tolerate(() => JSON.parse(new TextDecoder().decode(bounded)), 'malformed-input'),
  );
  // One refusal for every way a body can fail to be a report, and no detail
  // about which: the sender is our own ErrorBoundary, which has nothing to
  // correct, and a schema-shaped error message is a map of the accepted fields.
  if (!parsed.success) return err(400, 'not a render-failure report');
  const report = parsed.output;

  const build = await readBuildStamp(env, request.url);
  const match = releaseMatch(report.release, build?.sha);

  // Scalars only, and every one either a fixed vocabulary or a coordinate. The
  // authoritative `release` is this deployment's own stamp; `reportedRelease` is
  // what the browser claimed, kept separately so the two can be compared in a
  // query rather than conflated into one field nobody can trust.
  diagnostics.event(CLIENT_RENDER_FAILED, {
    release: build?.sha ?? '',
    version: build?.version ?? '',
    builtAt: build?.builtAt ?? '',
    reportedRelease: report.release ?? '',
    releaseMatch: match,
    route: report.route,
    errorName: report.errorName,
    stack: report.stack,
    componentStack: report.componentStack,
  });

  // The route's verdict, and the only thing it has to say. Accepted rather than
  // created: nothing was stored.
  return json({ releaseMatch: match }, { status: 202 });
}

/** Path and method routing only; the policy is `handleClientErrorReport`. */
export async function handleClientErrorRequest(
  request: Request,
  env: Env,
  identity: AuthIdentity | null,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== CLIENT_ERROR_ENDPOINT) return null;
  return request.method === 'POST'
    ? handleClientErrorReport(request, env, identity)
    : err(405, 'use POST');
}
