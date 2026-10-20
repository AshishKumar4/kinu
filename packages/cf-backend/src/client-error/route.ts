/**
 * `POST /api/client-errors`: one browser render or chat-stream failure becomes one Workers Logs line via `diagnostics`.
 * The release is read from the deployed bundle, not trusted from the browser; a mismatch is labelled `stale`, never refused.
 * Anyone may report, signed in or not: the pages anyone may open crash too. A report is budgeted per minute by the session
 * behind it, else by its address; past it the answer is 429, and the drop is logged once per window.
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import { KinuError, diagnostics, tolerate } from '@kinu.run/core/obs';
import type { AuthIdentity } from '../auth/session';
import type { FamilyEnv } from '../api/context';
import { err, ingressAdmission, ingressDenied, json, peerIp, readBounded } from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import { readSessionToken } from '../auth/session';
import { readBuildStamp } from '@kinu.run/core';
import {
  CLIENT_ERROR_ENDPOINT,
  CLIENT_CHAT_STREAM_FAILED,
  CLIENT_ERROR_MAX_REQUEST_BYTES,
  CLIENT_RENDER_FAILED,
  ClientReportSchema,
  type ReleaseMatch,
} from '@kinu.run/core';

const CLIENT_ERROR_REPORTS_PER_MINUTE = 20;

const OVER_REQUEST_LIMIT = `a render-failure report is limited to ${String(CLIENT_ERROR_MAX_REQUEST_BYTES >> 10)} KiB`;

/** `undeployed` is checked first: with no bundle stamp, `stale` would be a false finding on every `vite dev` session. */
function releaseMatch(reported: string | undefined, current: string | undefined): ReleaseMatch {
  if (current === undefined) return 'undeployed';

  if (reported === undefined) return 'unreported';

  return reported === current ? 'match' : 'stale';
}

/** A frame's script address without its query or fragment: Kinu's own scripts carry none, and a page's address may. */
const FRAME_URL_QUERY = /(\bhttps?:\/\/[^\s?#)]+)[?#][^\s)]*?(?=:\d+:\d+\)?$)/gmu;

function withoutQueries(frames: string): string {
  return frames.replace(FRAME_URL_QUERY, '$1');
}

/**
 * A report needs no sign-in: the landing and the other public pages crash too, and refusing anonymous reports hid every
 * crash they had (production walkthrough, 2026-10-20). What a report can write is bounded by its schema (an error's
 * class and never its message, a route template, stack frames and no prose), by Analytics Engine's per-point blob budget
 * (`CLIENT_ERROR_MAX_REQUEST_BYTES`), and by the budget below; `reporter` says whether a session stood behind it.
 */
async function handleClientErrorReport(
  request: Request,
  env: ClientErrorEnv,
  identity: AuthIdentity | null,
): Promise<Response> {
  if (env.AUTH_KV !== undefined) {
    // The session behind a report, else its address, which the budget keeps only as a hash under a key that lives two
    // windows (`ingressAdmission`); one per minute's count, so a burst writes that key once a report.
    const source = identity === null ? `peer:${peerIp(request)}` : readSessionToken(request) ?? identity.userId;
    const admission = await ingressAdmission(env.AUTH_KV, 'client-errors', source, CLIENT_ERROR_REPORTS_PER_MINUTE);

    if (admission === 'first-refusal') diagnostics.event('client.reports_dropped', { perMinute: CLIENT_ERROR_REPORTS_PER_MINUTE });

    if (admission !== 'admitted') return ingressDenied();
  }

  // The limit is Analytics Engine's per-data-point text budget; see `contract.ts`.
  const bounded = await readBounded(request, CLIENT_ERROR_MAX_REQUEST_BYTES);

  if (bounded === 'too_large') return err(413, OVER_REQUEST_LIMIT);

  if (bounded instanceof KinuError) {
    diagnostics.failure('client.report_unreadable', bounded);

    return err(400, 'could not read the request body');
  }

  const parsed = v.safeParse(
    ClientReportSchema,
    tolerate(() => JSON.parse(new TextDecoder().decode(bounded)), 'malformed-input'),
  );

  // One opaque refusal: a schema-shaped error message would map the accepted fields.
  if (!parsed.success) return err(400, 'not a render-failure report');
  const report = parsed.output;

  const build = await readBuildStamp(env, request.url);
  const match = releaseMatch(report.release, build?.sha);

  // Scalars only. `release` is this deployment's stamp; `reportedRelease` is the browser's claim, kept apart for comparison.
  const common = {
    reporter: identity === null ? 'anonymous' : 'signed-in',
    release: build?.sha ?? '',
    version: build?.version ?? '',
    builtAt: build?.builtAt ?? '',
    reportedRelease: report.release ?? '',
    releaseMatch: match,
    route: report.route,
    errorName: report.errorName,
    stack: withoutQueries(report.stack),
  };

  if (report.event === CLIENT_RENDER_FAILED) {
    diagnostics.event(CLIENT_RENDER_FAILED, { ...common, componentStack: withoutQueries(report.componentStack) });
  } else {
    diagnostics.event(CLIENT_CHAT_STREAM_FAILED, {
      ...common, pane: report.pane, partType: report.part?.type ?? '', partId: report.part?.id ?? '',
    });
  }

  return json({ body: { releaseMatch: match } }, { status: 202 });
}

export type ClientErrorEnv = Parameters<typeof readBuildStamp>[0] & { AUTH_KV?: KvStore };

/** The person behind a report, when the app read a live session for it; none is no refusal. */
export const clientErrorRoutes = new Hono<FamilyEnv<ClientErrorEnv, { identity?: AuthIdentity }>>();

clientErrorRoutes.all(CLIENT_ERROR_ENDPOINT, async (c) => (c.req.method === 'POST'
  ? handleClientErrorReport(c.req.raw, c.env, c.get('identity') ?? null)
  : err(405, 'use POST')));
