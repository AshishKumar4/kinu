/**
 * `POST /api/client-errors`: one browser render failure becomes one Workers Logs line via `diagnostics`.
 * The release is read from the deployed bundle, not trusted from the browser; a mismatch is labelled `stale`, never refused.
 * No rate gate: callers are session+CSRF-gated browsers and `components/ErrorBoundary.tsx` bounds reports client-side.
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import { KinuError, diagnostics, tolerate } from '@kinu.run/core/obs';
import type { AuthIdentity } from '../auth/session';
import type { FamilyEnv } from '../api/context';
import { err, json, readBounded } from '@kinu.run/core';
import { readBuildStamp } from '@kinu.run/core';
import {
  CLIENT_ERROR_ENDPOINT,
  CLIENT_ERROR_MAX_REQUEST_BYTES,
  CLIENT_RENDER_FAILED,
  ClientErrorReportSchema,
  type ReleaseMatch,
} from '@kinu.run/core';

const OVER_REQUEST_LIMIT = `a render-failure report is limited to ${String(CLIENT_ERROR_MAX_REQUEST_BYTES >> 10)} KiB`;

/** `undeployed` is checked first: with no bundle stamp, `stale` would be a false finding on every `vite dev` session. */
function releaseMatch(reported: string | undefined, current: string | undefined): ReleaseMatch {
  if (current === undefined) return 'undeployed';

  if (reported === undefined) return 'unreported';

  return reported === current ? 'match' : 'stale';
}

/** Refuses a null `identity` itself: an anonymous writer would be a log-injection endpoint. */
async function handleClientErrorReport(
  request: Request,
  env: ClientErrorEnv,
  identity: AuthIdentity | null,
): Promise<Response> {
  if (identity === null) return err(401, 'sign in to report a render failure');

  // The limit is Analytics Engine's per-data-point text budget; see `contract.ts`.
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

  // One opaque refusal: a schema-shaped error message would map the accepted fields.
  if (!parsed.success) return err(400, 'not a render-failure report');
  const report = parsed.output;

  const build = await readBuildStamp(env, request.url);
  const match = releaseMatch(report.release, build?.sha);

  // Scalars only. `release` is this deployment's stamp; `reportedRelease` is the browser's claim, kept apart for comparison.
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

  return json({ body: { releaseMatch: match } }, { status: 202 });
}

export type ClientErrorEnv = Parameters<typeof readBuildStamp>[0];

/** Optional so the route's own 401 holds wherever it is mounted. */
export const clientErrorRoutes = new Hono<FamilyEnv<ClientErrorEnv, { identity?: AuthIdentity }>>();

clientErrorRoutes.all(CLIENT_ERROR_ENDPOINT, async (c) => (c.req.method === 'POST'
  ? handleClientErrorReport(c.req.raw, c.env, c.get('identity') ?? null)
  : err(405, 'use POST')));
