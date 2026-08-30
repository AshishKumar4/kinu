/**
 * How an exploration facet's model-operation frames reach the root workspace.
 *
 * WHERE THEY GO AND WHY. A facet has no durable log of its own, so an operation
 * row written locally would strand one Durable Object away from the spend row it
 * explains. They travel over the same root RPC the merge's cost report uses
 * (`reportFacetModelOperation`), for the reason that twin exists.
 *
 * ITS OWN MODULE, for the reason `control-plane/stub.ts` is: `exploration.ts`
 * imports `cloudflare:workers` through its tracer, so a caller that only wanted
 * to know what this does with a rejection would drag a Durable Object's whole
 * graph in to find out — and could not, under the runner the rest of these
 * suites use. Nothing in this file's runtime graph reaches a Durable Object.
 *
 * PLATFORM-ONLY. Cloud exploration facets cross a Durable Object RPC boundary.
 * Local nodes report into their owning process and have no parent facet RPC.
 */
import type { ModelOperationEvent } from '@kinu.run/core';

/** The one RPC these frames travel over. Declared narrow, not as the
 *  orchestrator stub, so the forwarding below is drivable without a Durable
 *  Object — its only interesting behaviour is what it does when the hand-off
 *  does not happen. */
export interface FacetOperationTarget {
  reportFacetModelOperation(event: ModelOperationEvent): Promise<void>;
}

/**
 * Deliver one outbox row to the current parent. The caller owns durability,
 * retry, and deletion; this boundary either transfers the complete frame or
 * rejects with its original cause.
 */

export async function forwardFacetModelOperation(
  parentOf: () => FacetOperationTarget | null,
  event: ModelOperationEvent,
): Promise<void> {
  const parent = parentOf();
  if (parent === null) throw new Error('this facet has no parent workspace to forward to');
  await parent.reportFacetModelOperation(event);
}
