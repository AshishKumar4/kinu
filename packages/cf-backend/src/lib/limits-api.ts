/** The account's limits (core limits/), as the page reads them and recognises their refusals. */
import { LimitsReportSchema, refusedFor, type LimitsReport, type RefusedFor } from '@kinu.run/core';
import { renderThrownChain, settle } from '@kinu.run/core/obs';
import { request } from './http';

/** The account's class and each limit read now (`GET /api/user/limits`). */
export function getLimits(): Promise<LimitsReport> {
  return settle(request(LimitsReportSchema, '/api/user/limits'));
}

/** Spends an invite link for the signed-in account; its limits as they stand after. */
export function redeemInvite(token: string): Promise<LimitsReport> {
  return settle(request(LimitsReportSchema, `/api/user/invite/${encodeURIComponent(token)}`, { method: 'POST' }));
}

/** A refusal one of the account's limits made, and its words; null for any other failure. */
export interface LimitRefusal {
  readonly limit: RefusedFor;
  readonly text: string;
}

/** The limit a failure says refused the ask, from its words (core's `refusedFor`): a thrown refusal, or a turn's text. */
export function limitRefusalOf(failed: { readonly cause: unknown }): LimitRefusal | null {
  const text = renderThrownChain(failed);
  const limit = refusedFor(text);

  return limit === null ? null : { limit, text };
}
