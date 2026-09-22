/** Shared fixture for both backends' head-merge suites; `default` and `deep` differ in model and effort so an unrouted merge is detectable. */

import {
  BUILTIN_PROFILE_CATALOG,
  profileCatalogDigest,
  resolveTurnProfile,
  type ReasoningEffort,
  type ResolvedTurnProfile,
} from '@kinu.run/core';

/** The turn's model: a merge must not run on it. */
export const MERGE_POLICY_CHAT_MODEL = 'fake/chat-default';

export const MERGE_POLICY_CHAT_EFFORT: ReasoningEffort = 'low';

/** The `deep` tier `MODEL_ROUTE_POLICY.judge` routes to; both model and effort are pinned. */
export const MERGE_POLICY_JUDGE_MODEL = 'fake/deep-grader';

export const MERGE_POLICY_JUDGE_EFFORT: ReasoningEffort = 'high';

/** The spend label; same string the route is keyed by. */
export const MERGE_POLICY_SPEND_SOURCE = 'judge';

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
    roleId: 'task',
    workMode: 'build',
    availableTools: [],
    activeSkills: [],
  });
}

/** The binder request every backend's merge must make: routed spec and effort together. */
export const MERGE_POLICY_BINDING = {
  spec: MERGE_POLICY_JUDGE_MODEL,
  effort: MERGE_POLICY_JUDGE_EFFORT,
} satisfies { readonly spec: string; readonly effort: ReasoningEffort };
