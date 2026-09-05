/**
 * Branch wire protocol — the whole parent/child envelope in one place.
 *
 * Both ends import this module. One spelling names each method and each
 * envelope, and both sides parse what they receive against it.
 */
import { BranchExplorationSchema, BranchReflectionSchema } from '@kinu.run/core';
import * as v from 'valibot';

/** The one call that asks a branch for a candidate approach. */
export const BRANCH_EXPLORE = 'explore' as const;
/** The one call that asks a branch what its attempt taught. */
export const BRANCH_REFLECT = 'reflect' as const;
/** The first reply a worker sends, before any call is answered. */
export const BRANCH_READY = 'ready' as const;

/** The call methods, as the picklist source for the error reply. */
export const BRANCH_METHODS = [BRANCH_EXPLORE, BRANCH_REFLECT] as const;

/**
 * Parent to worker. Every call carries its own id, and the worker echoes it
 * back, so two overlapping same-method calls settle on their own replies.
 * The explore args carry no tools: the worker reads crafted tools from the
 * parent database instead.
 */
export const BranchCallSchema = v.variant('method', [
  v.object({
    method: v.literal(BRANCH_EXPLORE),
    id: v.number(),
    args: v.object({
      history: v.array(v.object({ role: v.string(), content: v.string() })),
      languages: v.pipe(v.array(v.string()), v.minLength(1)),
      mode: v.picklist(['plan', 'build']),
      siblings: v.optional(v.array(v.string()), []),
    }),
  }),
  v.object({
    method: v.literal(BRANCH_REFLECT),
    id: v.number(),
    args: v.object({ task: v.string(), outcome: v.optional(v.string()) }),
  }),
]);

/**
 * Worker to parent: the ready announcement, a result for the call with that
 * id, or an error for it. A reply that carries neither does not parse.
 */
export const BranchReplySchema = v.union([
  v.object({ method: v.literal(BRANCH_READY) }),
  v.object({ method: v.literal(BRANCH_EXPLORE), id: v.number(), result: BranchExplorationSchema }),
  v.object({ method: v.literal(BRANCH_REFLECT), id: v.number(), result: BranchReflectionSchema }),
  v.object({ method: v.picklist(BRANCH_METHODS), id: v.number(), error: v.string() }),
]);

/**
 * The most a malformed call still tells: which pending wait it was meant for.
 * The worker answers that id with the parse failure.
 */
export const BranchCallAttributionSchema = v.looseObject({
  id: v.number(),
  method: v.picklist(BRANCH_METHODS),
});

export type BranchCall = v.InferOutput<typeof BranchCallSchema>;
export type BranchReply = v.InferOutput<typeof BranchReplySchema>;
export type BranchMethod = BranchCall['method'];
/** A reply that answers a call. The ready announcement is not one. */
export type BranchCallReply = Exclude<BranchReply, { method: typeof BRANCH_READY }>;
