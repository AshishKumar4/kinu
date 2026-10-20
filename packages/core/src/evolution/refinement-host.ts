/** Host-facing refinement calls, shared by both backends; the lane is refinement-lane.ts. */

import { revertRejectedChanges } from './watch';
import {
  advanceRefinementLane, dreamRequest, requestRefinement,
  type RefinementLaneStep, type RequestRefinementInput,
} from './refinement-lane';
import * as v from 'valibot';
import {
  createRefinementStore, evolutionDebt, EvolutionDebtSchema, holdRefinementLane, nextEvolutionAnswerAt, refinementRequestView,
  RefinementRequestViewSchema, releaseRefinementLane, type EvolutionDebt, type RefinementDeps, type RefinementRequestView,
  type RefinementScope,
} from './refinement';
import { Effect } from 'effect';
import { attempt, settle, settleLogged, type KinuError } from '../obs/index';

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
}

export const RefinementListingSchema: v.GenericSchema<RefinementListing> = v.object({
  requests: v.array(RefinementRequestViewSchema),
  debt: EvolutionDebtSchema,
});

export function listRefinements(deps: RefinementDeps, limit = 20): RefinementListing {
  return {
    requests: createRefinementStore(deps.control.sql, deps.control.rt.actor).list(limit).map(refinementRequestView),
    debt: evolutionDebt(deps.control.sql, deps.control.rt.actor),
  };
}

export async function refinementPass(deps: RefinementDeps, trigger: 'cadence' | 'idle' = 'cadence'): Promise<RefinementLaneStep> {
  const { sql, rt } = deps.control;
  releaseRefinementLane(sql, rt.actor.actorId);

  return settle(attempt({ doing: 'running the refinement lane', otherwise: 'unavailable' }, async () => {
    await revertRejectedChanges(deps);
    await dreamRequest(deps, trigger);

    return advanceRefinementLane(deps);
  }).pipe(Effect.tapError(() => Effect.sync(() => {
    holdRefinementLane(sql, rt.actor.actorId);
  }))));
}

/** An idle agent's dream, over any new rated turn: the sleep-time wake's first work. Never while learning is off; never rejects. */
export function idleDream(deps: RefinementDeps, learns: boolean): Promise<void> {
  if (!learns) return Promise.resolve();

  return settleLogged('evolution.idle_dream_failed', { doing: 'dreaming while the agent is idle', otherwise: 'unavailable' }, async () => {
    await refinementPass(deps, 'idle');
  });
}

/** Both hosts' stored-answer wake; failures go to `failed`. */
export function evolutionAnswerWake(
  deps: RefinementDeps, now: number, failed: (failure: KinuError) => void,
): Promise<RefinementLaneStep | null> {
  const dueAt = nextEvolutionAnswerAt(deps.control.sql, deps.control.rt.actor.actorId);

  return settle(dueAt === null || dueAt > now ? Effect.succeed(null) : attempt(
    { doing: 'routing a refiner answer the lane was waiting on', otherwise: 'unavailable' }, () => refinementPass(deps),
  ).pipe(Effect.catch((failure) => Effect.sync(() => {
    failed(failure);

    return null;
  }))));
}
