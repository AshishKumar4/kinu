// The one builder of provider snapshots, so every backend computes the same `revision`.

import { sha256Hex } from '../safety/argument-digest';
import type { ModelMenu, ProviderFailure } from '../providers/registry';
import * as v from 'valibot';
import { ReasoningEffortSchema, type ReasoningEffort } from '../providers/reasoning-effort';
import type { ProviderCatalogSnapshot, ProviderCacheOutcome } from './resolve';
import { Effect } from 'effect';
import { logged } from '../obs/index';
import { contextWindowsOf, fastCandidatesOf, type FastCandidate } from './fast-tier';

/** One credential sweep; `models` are `<provider>/<modelId>` specs. */
export interface ProviderListing {
  readonly models: readonly string[];
  readonly failures: readonly ProviderFailure[];
  /** The levels each model declares, by spec; `[]`: none. */
  readonly reasoningEfforts?: Readonly<Record<string, readonly ReasoningEffort[]>>;
  /** What an unset fast tier may run on, cheapest first (`fastCandidatesOf`). */
  readonly fast?: readonly FastCandidate[];
  /** Each model's window, by spec, where the catalog states one (`contextWindowsOf`). */
  readonly contextWindows?: Readonly<Record<string, number>>;
}

/** A complete listing as a store keeps it: no failure row, since a degraded one is never kept. */
export const KeptProviderListingSchema: v.GenericSchema<unknown, ProviderListing> = v.object({
  models: v.array(v.string()),
  failures: v.tuple([]),
  reasoningEfforts: v.optional(v.record(v.string(), v.array(ReasoningEffortSchema))),
  fast: v.optional(v.array(v.object({ model: v.string() }))),
  contextWindows: v.optional(v.record(v.string(), v.number())),
});

export function providerListingOf(menu: ModelMenu): ProviderListing {
  const reasoningEfforts: Record<string, readonly ReasoningEffort[]> = {};

  const models = menu.models.map((model) => {
    const spec = `${model.provider}/${model.id}`;

    if (model.reasoningEfforts !== undefined) reasoningEfforts[spec] = model.reasoningEfforts;

    return spec;
  });

  return { models, failures: menu.failures, reasoningEfforts, fast: fastCandidatesOf(menu), contextWindows: contextWindowsOf(menu) };
}

/** Both backends' snapshot, as swept; a `pinned` spec moves only the revision. Sorted, so answer order never moves
 *  the revision; failures hashed, as a degraded listing admits unverified. No spec begins with `!`, `~`, `=`, `^` or `#`. */
export function providerSnapshotOf(listing: ProviderListing, pinned: readonly string[] = []): ProviderCatalogSnapshot {
  const availableModels = [...new Set(listing.models)].sort();

  const reasoningEfforts = Object.fromEntries(availableModels.flatMap((spec) => {
    const levels = listing.reasoningEfforts?.[spec];

    return levels === undefined ? [] : [[spec, [...levels]]];
  }));

  const unavailableProviders = listing.failures
    .map(({ provider, label, reason }) => ({ provider, label: label ?? provider, reason }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.reason.localeCompare(b.reason));

  // In the pick's order: a price change that reorders the candidates moves the revision.
  const fast = (listing.fast ?? []).map(({ model }) => ({ model }));

  const contextWindows = Object.fromEntries(availableModels.flatMap((spec) => {
    const window = listing.contextWindows?.[spec];

    return window === undefined ? [] : [[spec, window]];
  }));

  return {
    revision: sha256Hex([
      ...availableModels,
      ...unavailableProviders.map(({ provider, reason }) => `!${provider}\t${reason}`),
      ...Object.entries(reasoningEfforts).map(([spec, levels]) => `~${spec}\t${levels.join(',')}`),
      ...[...new Set(pinned)].sort().map((spec) => `=${spec}`),
      ...fast.map(({ model }) => `^${model}`),
      ...Object.entries(contextWindows).map(([spec, window]) => `#${spec}\t${String(window)}`),
    ].join('\n')),
    availableModels,
    unavailableProviders,
    reasoningEfforts,
    fast,
    contextWindows,
  };
}

/**
 * Where a complete listing is kept past this object's life: its owner's account, keyed on what the listing was swept
 * under (the credentials' revision and each provider's account), so a turn on a cold object serves the last sweep made
 * under the same keys rather than wait on a new one.
 */
export interface StoredProviderListing {
  /** The kept listing, if one was swept under what this object lists under now; never rejects: a store that does not
   *  answer has none, and the read sweeps. */
  readonly read: () => Promise<ProviderListing | null>;
  /** Called as a sweep starts: what keeps its listing under the keys it was swept under. */
  readonly keeper: () => (listing: ProviderListing) => Promise<void>;
  /** Runs work off the turn's path, as the object's own background work. */
  readonly detach: (work: Effect.Effect<void>) => void;
}

/**
 * One in-flight sweep; a complete listing is cached unless invalidated mid-sweep, and never expires by clock. With a
 * store, a read with nothing cached serves the stored listing at once and sweeps behind it, once per generation, the
 * fresh listing replacing it here and in the store; only a read the store has nothing for waits on a sweep.
 */
export class ProviderListingCache {
  private readonly sweep: () => Promise<ProviderListing>;
  private cached: ProviderListing | null = null;
  private inFlight: Promise<ProviderListing> | null = null;
  /** The store's read for this generation, one at a time; it is asked once a generation. */
  private storedRead: Promise<ProviderListing | null> | null = null;
  private generation = 0;

  constructor(sweep: () => Promise<ProviderListing>, private readonly stored?: StoredProviderListing) {
    this.sweep = sweep;
  }

  async read(): Promise<{ listing: ProviderListing; cache: ProviderCacheOutcome }> {
    if (this.cached) return { listing: this.cached, cache: 'hit' };

    if (this.inFlight) return { listing: await this.inFlight, cache: 'joined' };
    const stored = this.stored;

    if (stored !== undefined) {
      const generation = this.generation;
      const kept = await this.readStored(stored);

      if (kept !== null && generation === this.generation) {
        this.cached ??= kept;
        stored.detach(Effect.asVoid(Effect.promise(() => this.swept())));

        return { listing: this.cached, cache: 'stored' };
      }

      if (this.inFlight) return { listing: await this.inFlight, cache: 'joined' };
    }

    return { listing: await this.swept(), cache: 'miss' };
  }

  /** The store's listing for this generation, asked once. */
  private readStored(stored: StoredProviderListing): Promise<ProviderListing | null> {
    this.storedRead ??= stored.read();

    return this.storedRead;
  }

  /** One sweep at a time: a complete listing swept within one generation is cached, and kept in the store. */
  private async swept(): Promise<ProviderListing> {
    if (this.inFlight) return await this.inFlight;
    const generation = this.generation;
    const keep = this.stored?.keeper();
    const sweep = this.sweep();
    this.inFlight = sweep;
    let listing: ProviderListing;

    try {
      listing = await sweep;
    } finally {
      // A newer sweep may have replaced it after an invalidation.
      if (this.inFlight === sweep) this.inFlight = null;
    }

    if (listing.failures.length === 0 && generation === this.generation) {
      this.cached = listing;

      if (keep !== undefined) {
        this.stored?.detach(logged('profile.stored_listing_unkept', { doing: 'keeping the provider listing at the account', otherwise: 'unavailable' }, () => keep(listing), {}));
      }
    }

    return listing;
  }

  invalidate(): void {
    this.cached = null;
    this.inFlight = null;
    this.storedRead = null;
    this.generation += 1;
  }
}
