/** Separate from `model-call.ts` to avoid an import cycle through `mission-budget.ts` → `llm.ts`. */

import { priceCall } from '../mission-budget';
import type { ModelPricing } from '../providers/types';
import type { ModelCallReport } from './model-call';
import type { RunEventInput } from './types';

/**
 * A model call as whoever made it records it: priced at the rate its account's catalog gives the very model it called
 * (the turn's own, or one warmed for it), unpriced when the catalog has none. Every model call is priced here.
 */
export function pricedModelCallEvent(report: ModelCallReport, catalog: { pricing(spec?: string): ModelPricing | null }): Extract<RunEventInput, { type: 'model_call' }> {
  return buildModelCallEvent(report, { effectiveSpec: report.spec ?? null, pricing: report.spec === undefined ? null : catalog.pricing(report.spec) });
}

/** The only place the `model_call` row is built. `usage` is always present (`{}` = unmeasured); `usd` is set only at the
 *  rate of the model the call reached, so a report without `spec` never prices. */
function buildModelCallEvent(report: ModelCallReport, opts: {
  readonly effectiveSpec: string | null;
  /** Null until the catalog lookup lands: unpriced. */
  readonly pricing: ModelPricing | null;
}): Extract<RunEventInput, { type: 'model_call' }> {
  const event: Extract<RunEventInput, { type: 'model_call' }> = {
    type: 'model_call',
    source: report.source,
    usage: report.usage,
  };

  if (report.spec !== undefined) event.spec = report.spec;

  if (report.modelId !== undefined) event.modelId = report.modelId;

  if (report.account !== undefined) event.account = report.account;

  const rate = report.spec !== undefined && report.spec === opts.effectiveSpec
    ? opts.pricing
    : null;

  if (rate) {
    const usd = priceCall(report.usage, rate);

    if (usd !== undefined) event.usd = usd;
  }

  return event;
}
