/** Separate from `model-call.ts` to avoid an import cycle through `mission-budget.ts` → `llm.ts`. */

import { priceCall } from '../mission-budget';
import type { ModelPricing } from '../providers/types';
import type { ModelCallReport } from './model-call';
import type { RunEventInput } from './types';

/**
 * The only place the `model_call` row is built. `usage` is always present (`{}` = unmeasured).
 * `usd` is set only when `report.spec === effectiveSpec`; a report without `spec` never prices.
 */
export function buildModelCallEvent(report: ModelCallReport, opts: {
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
    const price = priceCall(report.usage, rate);

    if (price !== undefined) {
      event.usd = price.usd;

      // The workspace total counts these to mark its dollar figure a floor.
      if (price.floorTokens !== undefined) event.usdFloorTokens = price.floorTokens;
    }
  }

  return event;
}
