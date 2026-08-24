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
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import type { ModelOperationEvent, ModelOperationSink } from '@kinu.run/core';

/** The one RPC these frames travel over. Declared narrow, not as the
 *  orchestrator stub, so the forwarding below is drivable without a Durable
 *  Object — its only interesting behaviour is what it does when the hand-off
 *  does not happen. */
export interface FacetOperationTarget {
  reportFacetModelOperation(event: ModelOperationEvent): Promise<void>;
}

/**
 * Forward a facet's model-operation frames to the root workspace.
 *
 * `parentOf` is a THUNK because a facet's parent is seeded by the async
 * `_cf_initAsFacet`, after every field initializer has run: a value captured at
 * construction is the null it started as, forever.
 *
 * THE FAILURE ARM IS THE POINT. `ModelOperationSink` returns `void`, so the RPC
 * cannot be awaited here and must not be: this is instrumentation wrapped around
 * a model call, and a ledger fault must not become the reason the call the
 * ledger was watching never happened. What it must not do is DISCARD the
 * rejection. `void parent.reportFacetModelOperation(event)` did, and on workerd
 * an unhandled rejection is a line in a log stream with no request attached to
 * it — so a root that had stopped accepting frames read exactly like one
 * receiving every frame, while a whole search's spend went unexplained.
 *
 * Both ways the hand-off can fail are reported through the one classified event
 * core's shared projection uses for a ledger fault, and a rejected `Promise` for
 * the absent parent is what lets them share a single report site rather than two
 * copies of the same log call drifting apart.
 */
export function forwardFacetModelOperations(
  parentOf: () => FacetOperationTarget | null,
): ModelOperationSink {
  return (event) => {
    const parent = parentOf();
    const delivered = parent === null
      ? Promise.reject(new Error('this facet has no parent workspace to forward to'))
      : parent.reportFacetModelOperation(event);
    void delivered.catch((cause) => {
      diagnostics.failure('event.model_operation_emit_failed', toKinuError({
        doing: 'forwarding a model_operation frame to the root workspace',
        cause,
        otherwise: 'io',
      }), { operationId: event.operationId, phase: event.phase, source: event.source });
    });
  };
}
