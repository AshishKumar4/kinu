// The one builder of provider snapshots, so every backend computes the same `revision`.

import { sha256Hex } from '../safety/argument-digest';
import type { ProviderFailure } from '../providers/registry';
import type { ProviderCatalogSnapshot, ProviderCacheOutcome } from './resolve';

/** One credential sweep's result. `models` are joined `<provider>/<modelId>` specs, not rows. */
export interface ProviderListing {
  readonly models: readonly string[];
  readonly failures: readonly ProviderFailure[];
}

/**
 * Both halves are sorted so answer order never changes the revision. Failures are hashed
 * because a degraded listing admits models unverified; `!` cannot begin a model spec.
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
 * One shared in-flight sweep; only complete listings are cached, and only if no invalidation
 * landed mid-sweep. Nothing expires by clock: holders call {@link invalidate}.
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
      // A newer sweep may have replaced it after an invalidation.
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
