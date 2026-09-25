// The one table routing every SpendSource to a model; `satisfies` makes a missing row a compile error.
// Declared exception: the judge panel files as `judge` but spans vendor families, keeping its effort on
// REASONING_EFFORT_FOR_STAGE.judge; never route it through resolveModelRoute('judge', …).
import { SPEND_SOURCES, type SpendSource } from '../events/model-call';
import type { ReasoningEffort } from '../strategy/effort';
import type { TierId } from './catalog';
import type { ResolvedTurnProfile, TierFallback, TierRoute } from './resolve';

export type ModelRoutePolicy =
  | { readonly kind: 'invocation' }
  | { readonly kind: 'fixed'; readonly tier: TierId }
  | { readonly kind: 'platform' };

const MODEL_ROUTE_POLICY = {
  agent: { kind: 'invocation' },
  head: { kind: 'invocation' },
  mcts: { kind: 'invocation' },
  swarm: { kind: 'invocation' },
  slate: { kind: 'invocation' },
  scaffold: { kind: 'fixed', tier: 'deep' },
  judge: { kind: 'fixed', tier: 'deep' },
  advisor: { kind: 'fixed', tier: 'deep' },
  compaction: { kind: 'fixed', tier: 'fast' },
  fast: { kind: 'fixed', tier: 'fast' },
  reflection: { kind: 'fixed', tier: 'fast' },
  platform: { kind: 'platform' },
  // Replays the frozen spec that wrote the entry (providers/cache-warming.ts); no turn exists.
  warming: { kind: 'platform' },
} as const satisfies Record<SpendSource, ModelRoutePolicy>;

/** Producers whose model the turn profile decides — everything but `platform`. */
export type ProfileRoutedSource = {
  [K in SpendSource]: (typeof MODEL_ROUTE_POLICY)[K] extends { kind: 'platform' } ? never : K
}[SpendSource];

/** Producers routed to one named tier slot regardless of the turn. */
export type FixedTierSource = {
  [K in SpendSource]: (typeof MODEL_ROUTE_POLICY)[K] extends { kind: 'fixed' } ? K : never
}[SpendSource];

function isProfileRouted(source: SpendSource): source is ProfileRoutedSource {
  return MODEL_ROUTE_POLICY[source].kind !== 'platform';
}

/** One producer's concrete model, as the immutable turn profile resolves it. */
export interface ModelRouteResolution {
  readonly source: ProfileRoutedSource;
  readonly tier: TierId;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort | null;
  readonly fallbacks: readonly TierFallback[];
}

function tierResolution(profile: ResolvedTurnProfile, tier: TierId): TierRoute {
  const assignment = profile.tiers[tier];

  if (!assignment) {
    throw new Error(`turn profile carries no ${tier} tier resolution`);
  }

  return assignment;
}

/** Null only for `platform` producers, which build their binding-bound client directly. */
export function resolveModelRoute(
  source: ProfileRoutedSource,
  profile: ResolvedTurnProfile,
): ModelRouteResolution;
export function resolveModelRoute(
  source: SpendSource,
  profile: ResolvedTurnProfile,
): ModelRouteResolution | null;
export function resolveModelRoute(
  source: SpendSource,
  profile: ResolvedTurnProfile,
): ModelRouteResolution | null {
  if (!isProfileRouted(source)) return null;
  const policy = MODEL_ROUTE_POLICY[source];

  // Use the turn's model, not the slot's: a workspace pin overrides the former only.
  if (policy.kind === 'invocation') {
    return Object.freeze({
      source,
      tier: profile.tier.id,
      model: profile.tier.model,
      reasoningEffort: profile.tier.reasoningEffort,
      fallbacks: profile.tier.fallbacks,
    });
  }

  return Object.freeze({
    source,
    tier: policy.tier,
    ...tierResolution(profile, policy.tier),
  });
}

export { SPEND_SOURCES };
