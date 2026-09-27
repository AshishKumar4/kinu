/** Host-facing refinement calls, shared by both backends; the lane is refinement-lane.ts. */

import {
  advanceRefinementLane, refinementDebt, refinementDebtRequest, requestRefinement,
  type RefinementLaneStep, type RequestRefinementInput,
} from './refinement-lane';
import {
  createRefinementStore, holdRefinementLane, refinementRequestView, releaseRefinementLane,
  type RefinementDeps, type RefinementRequestView, type RefinementScope,
} from './refinement';
import { renderThrownChain } from '../obs/index';

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

export async function refinementPass(deps: RefinementDeps): Promise<RefinementLaneStep> {
  const { sql, rt } = deps.control;
  releaseRefinementLane(sql, rt.actor.actorId);

  try {
    await refinementDebtRequest(deps);
  } catch (err) {
    holdRefinementLane(sql, rt.actor.actorId, renderThrownChain({ cause: err }));

    return { step: 'idle' };
  }

  return advanceRefinementLane(deps);
}
