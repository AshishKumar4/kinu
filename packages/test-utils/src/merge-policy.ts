/**
 * The one fixture both backends' head-merge suites route against.
 *
 * The merge's model, its effort and its spend label are ONE policy in core
 * (`headMergeLLM`), and the claim that both backends resolve it identically is
 * only worth something if both are measured against the same catalog and the
 * same expected answer. Two hand-rolled fixtures could agree today and drift
 * tomorrow without either suite noticing — which is exactly how the drift this
 * closes survived: the local merge ran the session's chat model at a hardcoded
 * `'low'` and filed it as `judge` spend anyway, and no test compared the two
 * backends at all.
 *
 * The catalog is built to DISCRIMINATE. `default` and `deep` carry a different
 * model AND a different effort, so a merge that simply used whatever model it was
 * handed is distinguishable from one that took the `judge` route — under a
 * catalog where the tiers agreed, both behaviours look the same.
 */

import {
  BUILTIN_PROFILE_CATALOG,
  profileCatalogDigest,
  resolveTurnProfile,
  type ReasoningEffort,
  type ResolvedTurnProfile,
} from '@kinu.run/core';

/** What the turn is set to: the model a merge must NOT run on. */
export const MERGE_POLICY_CHAT_MODEL = 'fake/chat-default';
export const MERGE_POLICY_CHAT_EFFORT: ReasoningEffort = 'low';

/** What `MODEL_ROUTE_POLICY.judge` routes to — the account-wide `deep` tier, and
 *  therefore the model AND the effort every merge must resolve on either
 *  backend. A tier is a (model, effort) pair, so both halves are pinned: an
 *  implementation that took the routed model at a constant effort is half-routed,
 *  which reads as routed while only one axis is. */
export const MERGE_POLICY_JUDGE_MODEL = 'fake/deep-grader';
export const MERGE_POLICY_JUDGE_EFFORT: ReasoningEffort = 'high';

/** The label the merge's cost is filed under. Same string the route is keyed by,
 *  which is the invariant: the model and its attribution are one decision. */
export const MERGE_POLICY_SPEND_SOURCE = 'judge';

/** A resolved turn profile whose `default` and `deep` tiers disagree on both
 *  axes. */
export function mergePolicyProfile(): ResolvedTurnProfile {
  const catalog = {
    ...BUILTIN_PROFILE_CATALOG,
    tiers: {
      default: { model: MERGE_POLICY_CHAT_MODEL, reasoningEffort: MERGE_POLICY_CHAT_EFFORT },
      deep: { model: MERGE_POLICY_JUDGE_MODEL, reasoningEffort: MERGE_POLICY_JUDGE_EFFORT },
    },
  };
  return resolveTurnProfile({
    envelope: {
      authority: { kind: 'account', accountId: 'acct-1' },
      version: 1,
      digest: profileCatalogDigest(catalog),
      catalog,
    },
    provider: {
      revision: 'rev-1',
      availableModels: [MERGE_POLICY_CHAT_MODEL, MERGE_POLICY_JUDGE_MODEL],
    },
    roleId: 'general',
    workMode: 'build',
    availableTools: [],
    activeSkills: [],
  });
}

/** What a backend's merge must have asked its model binder for: the routed
 *  spec and the routed effort, together. Every head-merge suite compares against
 *  this ONE value, so "the two backends resolve the same policy" is an equality
 *  rather than two separately maintained expectations. */
export const MERGE_POLICY_BINDING = {
  spec: MERGE_POLICY_JUDGE_MODEL,
  effort: MERGE_POLICY_JUDGE_EFFORT,
} satisfies { readonly spec: string; readonly effort: ReasoningEffort };
