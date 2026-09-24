// Branch wire protocol; both ends parse against these schemas.
import { BranchExplorationSchema, BranchReflectionSchema } from '../mcts/engine';
import * as v from 'valibot';

export const BRANCH_EXPLORE = 'explore' as const;

export const BRANCH_REFLECT = 'reflect' as const;

/** Sent before any call is answered. */
export const BRANCH_READY = 'ready' as const;

const BRANCH_METHODS = [BRANCH_EXPLORE, BRANCH_REFLECT] as const;

/** Replies echo the call id so overlapping same-method calls settle correctly.
 *  Explore args carry no tools: the worker reads crafted tools from the parent DB. */
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

/** A reply carrying neither result nor error does not parse. */
export const BranchReplySchema = v.union([
  v.object({ method: v.literal(BRANCH_READY) }),
  v.object({ method: v.literal(BRANCH_EXPLORE), id: v.number(), result: BranchExplorationSchema }),
  v.object({ method: v.literal(BRANCH_REFLECT), id: v.number(), result: BranchReflectionSchema }),
  v.object({ method: v.picklist(BRANCH_METHODS), id: v.number(), error: v.string() }),
]);

/** A malformed call's id, so the worker can answer that wait with the parse failure. */
export const BranchCallAttributionSchema = v.looseObject({
  id: v.number(),
  method: v.picklist(BRANCH_METHODS),
});

export type BranchCall = v.InferOutput<typeof BranchCallSchema>;

export type BranchReply = v.InferOutput<typeof BranchReplySchema>;

export type BranchMethod = BranchCall['method'];

/** Excludes the ready announcement. */
export type BranchCallReply = Exclude<BranchReply, { method: typeof BRANCH_READY }>;
