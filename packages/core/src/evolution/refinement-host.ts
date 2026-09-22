/** Host-facing refinement calls, shared by both backends; the lane is refinement-lane.ts. */

import {
  advanceRefinementLane, refinementDebt, refinementDebtRequest, requestRefinement,
  type RefinementLaneStep, type RequestRefinementInput,
} from './refinement-lane';
import {
  createRefinementStore, refinementRequestView,
  type RefinementDeps, type RefinementRequestView, type RefinementScope,
} from './refinement';

/** Explicit request; defaults to the unresolved outcomes at workspace scope. */
export function requestOwnerRefinement(
  deps: RefinementDeps,
  opts: { readonly turnIds?: readonly string[]; readonly scope?: RefinementScope } = {},
): Promise<RefinementRequestView> {
  const request: RequestRefinementInput = { trigger: 'explicit', scope: opts.scope ?? 'workspace' };

  return requestRefinement(deps, opts.turnIds === undefined ? request : { ...request, turnIds: opts.turnIds });
}

/** Newest requests plus the debt that would open the next one. */
export function listRefinements(deps: RefinementDeps, limit = 20) {
  return {
    requests: createRefinementStore(deps.control.sql, deps.control.rt.actor).list(limit).map(refinementRequestView),
    debt: refinementDebt(deps),
  };
}

/** Open owed debt first so a newly crossed threshold is handled this pass. */
export async function refinementPass(deps: RefinementDeps): Promise<RefinementLaneStep> {
  await refinementDebtRequest(deps);

  return advanceRefinementLane(deps);
}
