/** Separate from `model-call.ts` to avoid an import cycle through `mission-budget.ts` → `llm.ts`. */

import { priceCall } from '../mission-budget';
import type { ModelPricing } from '../providers/types';
import { WORKSPACE_RUN_ID, type ModelCallReport, type ModelCallSink } from './model-call';
import type { RunEventRecorder } from './recorder';
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
    const usd = priceCall(report.usage, rate);

    if (usd !== undefined) event.usd = usd;
  }

  return event;
}

/** An actor's ledger outside any run, unpriced: for a seam no session prices. */
export function unpricedLedgerSink(events: Pick<RunEventRecorder, 'emit'>): ModelCallSink {
  return (report) => { events.emit(WORKSPACE_RUN_ID, buildModelCallEvent(report, { effectiveSpec: null, pricing: null })); };
}
