// The one table routing every SpendSource to a model; `satisfies` makes a missing row a compile error.
import { SPEND_SOURCES, type SpendSource } from '../events/model-call';
import type { ReasoningEffort } from '../providers/effort';
import { declaredReasoningEffort } from '../providers/reasoning-effort';
import { specWithoutAccount } from '../providers/types';
import type { TierId } from './catalog';
import type { ResolvedTurnProfile, TierFallback, TierRoute } from './resolve';

export type ModelRoutePolicy =
  | { readonly kind: 'invocation' }
  /** `effort`: the level the call wants, which each model of the tier's chain is asked at as near as it declares. */
  | { readonly kind: 'fixed'; readonly tier: TierId; readonly effort?: ReasoningEffort }
  | { readonly kind: 'platform' };

export const MODEL_ROUTE_POLICY = {
  agent: { kind: 'invocation' },
  head: { kind: 'invocation' },
  swarm: { kind: 'invocation' },
  slate: { kind: 'invocation' },
  logo: { kind: 'invocation' },
  scaffold: { kind: 'fixed', tier: 'deep' },
  judge: { kind: 'fixed', tier: 'deep' },
  advisor: { kind: 'fixed', tier: 'deep' },
  compaction: { kind: 'fixed', tier: 'fast' },
  fast: { kind: 'fixed', tier: 'fast' },
  // The few words naming each finished phase of a turn's tool calls; its own label, so its spend reads apart.
  phase_line: { kind: 'fixed', tier: 'fast', effort: 'low' },
  reflection: { kind: 'fixed', tier: 'fast' },
  platform: { kind: 'platform' },
  // Replays the frozen spec that wrote the entry (providers/cache-warming.ts); no turn exists.
  warming: { kind: 'platform' },
  test: { kind: 'platform' },
  // The catalog's `decisionModel`, not a tier (providers/decision-model.ts).
  rating: { kind: 'platform' },
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
  readonly retries: number;
}

/** The levels each listed model declares, as the provider listing a profile was resolved on holds them. */
export type DeclaredEfforts = Readonly<Record<string, readonly ReasoningEffort[]>>;

/** The tier's chain asked at `wanted`, each model at the level it declares nearest; a model declaring none is asked at none. */
function atEffort(slot: TierRoute, wanted: ReasoningEffort, declared: DeclaredEfforts): TierRoute {
  const at = (spec: string) => declaredReasoningEffort(wanted, declared[specWithoutAccount(spec)]);

  return { model: slot.model, reasoningEffort: at(slot.model), fallbacks: slot.fallbacks.map((fallback) => ({ ...fallback, reasoningEffort: at(fallback.model) })) };
}

function tierResolution(profile: ResolvedTurnProfile, tier: TierId): TierRoute {
  const assignment = profile.tiers[tier];

  if (!assignment) {
    throw new Error(`turn profile carries no ${tier} tier resolution`);
  }

  return assignment;
}

/** Null only for `platform` producers, which build their binding-bound client directly. */
/** `declared`: the listing's levels, for a source whose policy wants an effort of its own; without it, the slot's. */
export function resolveModelRoute(
  source: ProfileRoutedSource,
  profile: ResolvedTurnProfile,
  declared?: DeclaredEfforts,
): ModelRouteResolution;
export function resolveModelRoute(
  source: SpendSource,
  profile: ResolvedTurnProfile,
  declared?: DeclaredEfforts,
): ModelRouteResolution | null;
export function resolveModelRoute(
  source: SpendSource,
  profile: ResolvedTurnProfile,
  declared?: DeclaredEfforts,
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
      retries: profile.retries,
    });
  }

  const slot = tierResolution(profile, policy.tier);
  const { model, reasoningEffort, fallbacks } = 'effort' in policy && declared !== undefined ? atEffort(slot, policy.effort, declared) : slot;

  return Object.freeze({ source, tier: policy.tier, model, reasoningEffort, fallbacks, retries: profile.retries });
}

export { SPEND_SOURCES };
