/** `plan.submit` and `plan.reply` served to the owner's plan review. */
import { Effect } from 'effect';
import type { ReplyToCommentToolDeps, SubmitPlanToolDeps } from '../types/plans';
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

export function servePlanReply(deps: ReplyToCommentToolDeps): Served {
  return serve(PLAN.reply, async ({ comment, text }) => {
    const result = await deps.reply(comment, text);

    if (!result.ok) return settle(Effect.fail(new KinuError('bad_input', result.error)));
    const reply = result.plan.annotations.filter((note) => note.type === 'REPLY' && note.inReplyTo === comment).at(-1);

    return { planId: result.plan.id, revision: result.plan.revision, comment, reply: reply?.id ?? '' };
  });
}
