/**
 * The durable `model_call` row, built once.
 *
 * A sibling of `model-call.ts` rather than part of it, for a mechanical reason:
 * pricing lives in `mission-budget.ts`, which reaches `llm.ts`, which imports
 * `model-call.ts` for its operation lifecycle. So the module that declares the
 * producer vocabulary cannot also be the module that prices a call without
 * closing a cycle. This one imports both and is imported by neither.
 */

import { priceCall } from '../mission-budget';
import type { ModelPricing } from '../providers/types';
import type { ModelCallReport } from './model-call';
import type { RunEventInput } from './types';

/**
 * One producer's report, as the durable `model_call` row.
 *
 * Written here because it was written twice, and the two copies disagreed about
 * the one field that decides whether a spend reader can be trusted.
 *
 * USAGE IS ALWAYS PRESENT. `{}` when the provider reported nothing. A silent
 * call is unmeasured spend, never free spend, and the workspace total's coverage
 * fraction is built out of exactly these rows — so `{}` and "no row" have to
 * stay distinguishable, and a backend that omitted the field collapsed them.
 * {@link ModelCallReport.usage} is already non-optional for this reason; this is
 * the same rule applied at the row.
 *
 * PRICING IS GUARDED. `usd` is set only when the rate on offer belongs to the
 * model that actually served the call — `report.spec === effectiveSpec`. A judge
 * deliberately runs on a DIFFERENT model from the actor, so pricing it at the
 * actor's rate would invent a number; an absent `usd` says "not priced here",
 * which the workspace total reads as such. A report with no `spec` at all never
 * prices: the seams that never had one cannot be shown to have run on the model
 * whose rate is in hand.
 *
 * The guard lives here and only here. It was spelled three times — once per
 * backend for the durable row, then a third time for one backend's analytics row
 * — which is three chances for the fabricated number this rule exists to
 * prevent. A caller needing the same verdict for a second sink reads `usd` off
 * the returned event rather than re-deciding it.
 */
export function buildModelCallEvent(report: ModelCallReport, opts: {
  /** The model the caller's catalog session has actually resolved, or null when
   *  it has resolved none. Compared against the report's own `spec`. */
  readonly effectiveSpec: string | null;
  /** That session's rate, already looked up. Null until the catalog lookup
   *  lands, which is a normal state and simply means unpriced. */
  readonly pricing: ModelPricing | null;
}): Extract<RunEventInput, { type: 'model_call' }> {
  const event: Extract<RunEventInput, { type: 'model_call' }> = {
    type: 'model_call',
    source: report.source,
    usage: report.usage,
  };
  if (report.spec !== undefined) event.spec = report.spec;
  if (report.modelId !== undefined) event.modelId = report.modelId;
  // Narrowed by the guard rather than asserted after it: the rate is only a rate
  // for THIS call when the spec matches, so the match is what produces the
  // non-null value.
  const rate = report.spec !== undefined && report.spec === opts.effectiveSpec
    ? opts.pricing
    : null;
  if (rate) {
    const usd = priceCall(report.usage, rate);
    if (usd !== undefined) event.usd = usd;
  }
  return event;
}
