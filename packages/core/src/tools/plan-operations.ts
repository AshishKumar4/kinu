/** `plan.submit` served to the owner's plan review. */
import { Effect } from 'effect';
import type { SubmitPlanToolDeps } from '../types/plans';
import { KinuError, settle } from '../obs/index';
import { serve, type Served } from '../operations/operation';
import { PLAN } from '../operations/plan';

export function servePlan(deps: SubmitPlanToolDeps): Served {
  return serve(PLAN.submit, async ({ edits }) => {
    const result = await deps.submit(edits);

    if (!result.ok) return settle(Effect.fail(new KinuError('bad_input', result.error)));

    return {
      planId: result.plan.id, revision: result.plan.revision, status: result.plan.status,
      message: 'Plan submitted and awaiting review. Do not implement or produce a preview; end this turn now.',
    };
  });
}
