// The one builder of provider snapshots, so every backend computes the same `revision`.

import { sha256Hex } from '../safety/argument-digest';
import type { ModelMenu, ProviderFailure } from '../providers/registry';
import type { ReasoningEffort } from '../providers/reasoning-effort';
import type { ProviderCatalogSnapshot, ProviderCacheOutcome } from './resolve';

/** One credential sweep; `models` are `<provider>/<modelId>` specs. */
export interface ProviderListing {
  readonly models: readonly string[];
  readonly failures: readonly ProviderFailure[];
  /** The levels each model declares, by spec; `[]`: none. */
  readonly reasoningEfforts?: Readonly<Record<string, readonly ReasoningEffort[]>>;
}

/** A registry's menu as a listing. */
export function providerListingOf(menu: ModelMenu): ProviderListing {
  const reasoningEfforts: Record<string, readonly ReasoningEffort[]> = {};

  const models = menu.models.map((model) => {
    const spec = `${model.provider}/${model.id}`;

    if (model.reasoningEfforts !== undefined) reasoningEfforts[spec] = model.reasoningEfforts;

    return spec;
  });

  return { models, failures: menu.failures, reasoningEfforts };
}

/** Both backends' snapshot, as swept; a `pinned` spec moves only the revision. Sorted, so answer order never moves
 *  the revision; failures hashed, as a degraded listing admits unverified. No spec begins with `!`, `~` or `=`. */
export function providerSnapshotOf(listing: ProviderListing, pinned: readonly string[] = []): ProviderCatalogSnapshot {
  const availableModels = [...new Set(listing.models)].sort();

  const reasoningEfforts = Object.fromEntries(availableModels.flatMap((spec) => {
    const levels = listing.reasoningEfforts?.[spec];

    return levels === undefined ? [] : [[spec, [...levels]]];
  }));

  const unavailableProviders = listing.failures
    .map(({ provider, label, reason }) => ({ provider, label: label ?? provider, reason }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.reason.localeCompare(b.reason));

  return {
    revision: sha256Hex([
      ...availableModels,
      ...unavailableProviders.map(({ provider, reason }) => `!${provider}\t${reason}`),
      ...Object.entries(reasoningEfforts).map(([spec, levels]) => `~${spec}\t${levels.join(',')}`),
      ...[...new Set(pinned)].sort().map((spec) => `=${spec}`),
    ].join('\n')),
    availableModels,
    unavailableProviders,
    reasoningEfforts,
  };
}

/** One in-flight sweep; a complete listing is cached unless invalidated mid-sweep, and never expires by clock. */
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
