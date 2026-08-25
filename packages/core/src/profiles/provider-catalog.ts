// The provider availability snapshot: how it is built, and how it is cached.
//
// `resolve.ts` documents what a snapshot MEANS — a positive `availableModels`
// list, a `unavailableProviders` set that says whether the listing was complete,
// and a `revision` that must change whenever either does. It deliberately left
// the FORMULA to producers, and both producers then wrote the same formula: the
// same dedupe-and-sort, the same `label ?? provider` fallback, the same
// `!provider\treason` fold into the same hash, under the same restated comments.
//
// That is the worst place for a twin. `revision` is the key every other cache is
// held against, so the two implementations agreeing is what makes a profile
// resolved on one backend comparable to one resolved on the other — and nothing
// held them together. They agree today. This module is so that they cannot stop.

import { sha256Hex } from '../safety/argument-digest';
import type { ProviderFailure } from '../providers/registry';
import type { ProviderCatalogSnapshot, ProviderCacheOutcome } from './resolve';

/**
 * One credential sweep's result: what could be listed, and what could not be
 * reached.
 *
 * `models` are `<provider>/<modelId>` specs, already joined. Deliberately not
 * model rows: one producer seeds its own configured spec into the set alongside
 * the listing, and a builder that took rows could not express that without
 * knowing about configuration it has no business reading.
 */
export interface ProviderListing {
  readonly models: readonly string[];
  readonly failures: readonly ProviderFailure[];
}
// `ProviderCacheOutcome` is declared beside the resolution evidence it lands on
// (resolve.ts), not here: this module is one producer of it, and the row that
// reads it is the contract.

/**
 * Assemble a snapshot from one listing.
 *
 * Both halves are SORTED before hashing, so two listings differing only in the
 * order providers happened to answer or fail in hash identically — a revision
 * that changed on scheduling noise would re-resolve every profile for nothing.
 *
 * `label` falls back to the provider id because it is optional upstream, and a
 * total row means no reader has to render a blank.
 *
 * Failures are folded into the revision, and that is the load-bearing part. A
 * snapshot taken while a provider was down describes a DIFFERENT world from a
 * healthy one: under the resolver's rule a non-empty failure set admits every
 * configured model unverified, so a revision blind to failures would serve that
 * degraded picture under the same identity as the complete one. `!` cannot begin
 * a model spec, so a failure line can never collide with a model line.
 */
export function buildProviderCatalogSnapshot(
  models: Iterable<string>,
  failures: readonly ProviderFailure[],
): ProviderCatalogSnapshot {
  const availableModels = [...new Set(models)].sort();
  const unavailableProviders = failures
    .map(({ provider, label, reason }) => ({ provider, label: label ?? provider, reason }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.reason.localeCompare(b.reason));
  return {
    revision: sha256Hex([
      ...availableModels,
      ...unavailableProviders.map(({ provider, reason }) => `!${provider}\t${reason}`),
    ].join('\n')),
    availableModels,
    unavailableProviders,
  };
}

/**
 * One credential sweep at a time, memoized only when it was COMPLETE.
 *
 * Four rules, each of which was written twice before this existed:
 *
 * ONE SWEEP. Concurrent callers join the in-flight sweep instead of starting
 * their own. Every turn that opened before the first finished used to pay for
 * its own credential listing, so the cost was per caller rather than per change.
 *
 * COMPLETE LISTINGS ONLY. A degraded listing is never cached. A non-empty
 * failure set admits every configured model unverified, so caching one would
 * hold that window open past the fault it came from and freeze `revision` at a
 * degraded value — the exact thing folding failures into the revision prevents.
 * The inverse hazard closes with it: a cached listing always carries an empty
 * failure set that was TRUE when taken, so a provider going unreachable
 * produces a fresh sweep rather than a stale hard-refusal of a model the owner
 * just connected. Accepted cost: while a provider is failing, the sweep is paid
 * every resolution. That beats serving a known-partial picture indefinitely.
 *
 * GENERATION GUARD. The generation is captured before the await. An
 * invalidation landing mid-sweep bumps it, and the result is then still returned
 * to its caller — it is the best answer anyone has — but NOT cached, because a
 * listing of the world before the change must not become the answer for every
 * resolution after it.
 *
 * INVALIDATION BY SIGNAL, NEVER BY CLOCK. Nothing here expires by elapsed time.
 * A credential revoked, a provider connected, a sign-in: the holder calls
 * {@link invalidate}. The in-flight sweep goes too, because leaving it would
 * hand its pre-change answer to everyone who joined it and re-cache it on the
 * way out.
 *
 * What stays per backend is the sweep itself and what triggers invalidation —
 * a Durable Object's credential hooks and a CLI's cross-process revision
 * counter are genuinely different machinery answering the same question.
 */
export class ProviderListingCache {
  private readonly sweep: () => Promise<ProviderListing>;
  private cached: ProviderListing | null = null;
  private inFlight: Promise<ProviderListing> | null = null;
  private generation = 0;

  constructor(sweep: () => Promise<ProviderListing>) {
    this.sweep = sweep;
  }

  async read(): Promise<{ listing: ProviderListing; cache: ProviderCacheOutcome }> {
    if (this.cached) return { listing: this.cached, cache: 'hit' };
    if (this.inFlight) return { listing: await this.inFlight, cache: 'joined' };
    const generation = this.generation;
    const sweep = this.sweep();
    this.inFlight = sweep;
    let listing: ProviderListing;
    try {
      listing = await sweep;
    } finally {
      // Only if it is still OURS: an invalidation mid-sweep already cleared it,
      // and clearing unconditionally would discard a newer sweep started after.
      if (this.inFlight === sweep) this.inFlight = null;
    }
    if (listing.failures.length === 0 && generation === this.generation) this.cached = listing;
    return { listing, cache: 'miss' };
  }

  invalidate(): void {
    this.cached = null;
    this.inFlight = null;
    this.generation += 1;
  }
}
