// Exhaustive model routing — the ONE table that says where every producer's
// model comes from.
//
// A SpendSource names a producer; this file alone decides what that producer
// runs on. The `satisfies Record<SpendSource, ModelRoutePolicy>` below makes
// adding a producer without a routing decision a compile error, and
// `resolveModelRoute` is the only read path — so a producer cannot grow a
// private resolver beside it.
//
//   invocation  the turn's own resolved tier (the agent's active role decides)
//   fixed       one named tier slot for every caller of this producer
//   platform    an explicit fixed-platform binding outside profile resolution;
//               resolveModelRoute refuses it rather than guessing
//
// Every model construction consumes a ResolvedTurnProfile through this table,
// or declares itself `platform`.
//
// ONE DECLARED EXCEPTION, named here because a claim of exhaustiveness has to
// carry its own counter-example. A judge PANEL — the outcome ensemble, which
// puts one model per connected vendor family to the same hand-labelled turns —
// files as `judge` and cannot route through `judge`'s fixed slot: one tier is
// one model, and a panel of one model is not a weaker panel, it is the absence
// of the instrument. Its whole point is that its members disagree for reasons
// other than the turn.
//
// It stays off this table rather than growing a row, and its EFFORT stays on
// the stage table (`REASONING_EFFORT_FOR_STAGE.judge`) rather than being taken
// from the deep tier. That pairing is deliberate: a tier is a (model, effort)
// pair, so applying the effort of a tier whose model was deliberately not used
// would be half a tier — and a half-applied profile reads as routed while only
// one axis is, which is worse than one that is plainly not.
//
// What it MUST NOT become is `resolveModelRoute('judge', …)`. That reads tidier
// and silently makes every judge the same model.
import { SPEND_SOURCES, type SpendSource } from '../events/model-call';
import type { ReasoningEffort } from '../strategy/effort';
import type { TierId } from './catalog';
import type { ResolvedTurnProfile } from './resolve';

export type ModelRoutePolicy =
  | { readonly kind: 'invocation' }
  | { readonly kind: 'fixed'; readonly tier: TierId }
  | { readonly kind: 'platform' };

/** Routing per producer. Keyed by the full union so the compiler, not a test,
 *  holds the exhaustiveness invariant. */
const MODEL_ROUTE_POLICY = {
  // The turn's own work, and every delegation shape that carries the turn's
  // immutable resolved tier with it.
  agent: { kind: 'invocation' },
  head: { kind: 'invocation' },
  mcts: { kind: 'invocation' },
  swarm: { kind: 'invocation' },
  // Fixed slots: account-wide tier assignments decide these, never a pin.
  scaffold: { kind: 'fixed', tier: 'deep' },
  judge: { kind: 'fixed', tier: 'deep' },
  advisor: { kind: 'fixed', tier: 'slow' },
  compaction: { kind: 'fixed', tier: 'fast' },
  fast: { kind: 'fixed', tier: 'tiny' },
  reflection: { kind: 'fixed', tier: 'fast' },
  // Embeddings and other binding-bound calls: no profile route exists.
  platform: { kind: 'platform' },
} as const satisfies Record<SpendSource, ModelRoutePolicy>;

/** Producers whose model the turn profile decides — everything but `platform`. */
export type ProfileRoutedSource = {
  [K in SpendSource]: (typeof MODEL_ROUTE_POLICY)[K] extends { kind: 'platform' } ? never : K
}[SpendSource];

/**
 * Producers whose model comes from ONE named tier slot, whatever the turn
 * resolved — the lanes a fixed-tier factory may be asked to build.
 *
 * Derived from the table because it was hand-mirrored: one backend declared
 * `'judge' | 'fast' | 'advisor'` beside its lane factory, which is a SUBSET of
 * the fixed rows and therefore both a duplicate and quietly wrong — moving a
 * producer to a fixed tier here left that union unable to name it, with nothing
 * failing to say so.
 */
export type FixedTierSource = {
  [K in SpendSource]: (typeof MODEL_ROUTE_POLICY)[K] extends { kind: 'fixed' } ? K : never
}[SpendSource];

function isProfileRouted(source: SpendSource): source is ProfileRoutedSource {
  return MODEL_ROUTE_POLICY[source].kind !== 'platform';
}

/** One producer's concrete model, as the immutable turn profile resolves it. */
export interface ModelRouteResolution {
  readonly source: ProfileRoutedSource;
  /** The tier slot the policy named — the turn's own for `invocation`. */
  readonly tier: TierId;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
}

function tierResolution(
  profile: ResolvedTurnProfile,
  tier: TierId,
): { model: string; reasoningEffort: ReasoningEffort } {
  const assignment = profile.tiers[tier];
  if (!assignment) {
    throw new Error(`turn profile carries no ${tier} tier resolution`);
  }
  return assignment;
}

/** Resolve one producer's model from the immutable turn profile. Returns null
 *  only for the explicit platform exception — callers there construct their
 *  binding-bound client directly, and nowhere else may bypass this table. */
export function resolveModelRoute(
  source: SpendSource,
  profile: ResolvedTurnProfile,
): ModelRouteResolution | null {
  if (!isProfileRouted(source)) return null;
  const policy = MODEL_ROUTE_POLICY[source];
  const tier = policy.kind === 'invocation' ? profile.tier.id : policy.tier;
  return Object.freeze({
    source,
    tier,
    ...tierResolution(profile, tier),
  });
}

export { SPEND_SOURCES };
