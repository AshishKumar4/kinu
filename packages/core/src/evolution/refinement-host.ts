/**
 * The refinement lane as a host drives it: the owner's `/refine`, the owner's
 * view of the lane, and one cadence pass. The same three calls on both
 * backends; the lane itself is refinement-lane.ts.
 */

import {
  advanceRefinementLane, refinementDebt, refinementDebtRequest, requestRefinement,
  type RefinementLaneStep, type RequestRefinementInput,
} from './refinement-lane';
import {
  createRefinementStore, refinementRequestView,
  type RefinementDeps, type RefinementRequestView, type RefinementScope,
} from './refinement';

/** The owner's `/refine`: an explicit request over the named turns (by default
 *  the unresolved outcomes), at workspace scope unless the owner names one. */
export function requestOwnerRefinement(
  deps: RefinementDeps,
  opts: { readonly turnIds?: readonly string[]; readonly scope?: RefinementScope } = {},
): Promise<RefinementRequestView> {
  const request: RequestRefinementInput = { trigger: 'explicit', scope: opts.scope ?? 'workspace' };

  return requestRefinement(deps, opts.turnIds === undefined ? request : { ...request, turnIds: opts.turnIds });
}

/** The owner's view of the lane: the newest requests, and the debt that would
 *  open the next one. */
export function listRefinements(deps: RefinementDeps, limit = 20) {
  return {
    requests: createRefinementStore(deps.control.sql, deps.control.rt.actor).list(limit).map(refinementRequestView),
    debt: refinementDebt(deps),
  };
}

/**
 * One pass of the lane: what the debt owes is opened first, so a workspace
 * that has just crossed the threshold is looked at on this pass rather than a
 * whole cadence later; then one request advances.
 */
export async function refinementPass(deps: RefinementDeps): Promise<RefinementLaneStep> {
  await refinementDebtRequest(deps);

  return advanceRefinementLane(deps);
}
