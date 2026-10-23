/** Host-facing refinement calls, shared by both backends; the lane is refinement-lane.ts. */

import { replayPendingScaffold } from '../scaffold/replay-gate';
import { watchChanges } from './watch';
import {
  advanceRefinementLane, dreamRequest, requestRefinement,
  type RefinementLaneStep, type RequestRefinementInput,
} from './refinement-lane';
import * as v from 'valibot';
import {
  createRefinementStore, evolutionDebt, EvolutionDebtSchema, refinementRequestView,
  RefinementRequestViewSchema, type EvolutionDebt, type RefinementDeps, type RefinementRequestView,
  type RefinementScope,
} from './refinement';
import { attempt, settle, settleLogged } from '../obs/index';
import { unratedReason } from '../profiles/tier-refusals';

/** Explicit request; defaults to the unresolved outcomes at workspace scope. */
export function requestOwnerRefinement(
  deps: RefinementDeps,
  opts: { readonly turnIds?: readonly string[]; readonly scope?: RefinementScope } = {},
): Promise<RefinementRequestView> {
  const request: RequestRefinementInput = { trigger: 'explicit', scope: opts.scope ?? 'workspace' };

  return requestRefinement(deps, opts.turnIds === undefined ? request : { ...request, turnIds: opts.turnIds });
}

/** Newest requests plus the debt that would open the next one: one shape, so a debt count never renders against a
 *  stale list. */
export interface RefinementListing {
  readonly requests: readonly RefinementRequestView[];
  readonly debt: EvolutionDebt;
  /** Why no turn is being rated, so no dream opens (`unratedReason`); null while turns can be rated. */
  readonly unrated: string | null;
}

export const RefinementListingSchema: v.GenericSchema<RefinementListing> = v.object({
  requests: v.array(RefinementRequestViewSchema),
  debt: EvolutionDebtSchema,
  unrated: v.nullable(v.string()),
});

export function listRefinements(deps: RefinementDeps, limit = 20, settings = 'your model settings'): RefinementListing {
  return {
    requests: createRefinementStore(deps.control.sql, deps.control.rt.actor).list(limit).map(refinementRequestView),
    debt: evolutionDebt(deps.control.sql, deps.control.rt.actor),
    unrated: unratedReason(deps.control.rt.actor.config, settings),
  };
}

export async function refinementPass(deps: RefinementDeps, trigger: 'cadence' | 'idle' = 'cadence'): Promise<RefinementLaneStep> {
  return settle(attempt({ doing: 'running the refinement lane', otherwise: 'unavailable' }, async () => {
    await watchChanges(deps);
    await replayPendingScaffold(deps.control, deps.recordedTurns);
    await dreamRequest(deps, trigger);

    return advanceRefinementLane(deps);
  }));
}

/** An idle agent's dream, over any new rated turn: the sleep-time wake's first work. Never while learning is off; never rejects. */
export function idleDream(deps: RefinementDeps, learns: boolean): Promise<void> {
  if (!learns) return Promise.resolve();

  return settleLogged('evolution.idle_dream_failed', { doing: 'dreaming while the agent is idle', otherwise: 'unavailable' }, async () => {
    await refinementPass(deps, 'idle');
  });
}
