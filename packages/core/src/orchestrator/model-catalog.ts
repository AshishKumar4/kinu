/**
 * ModelCatalogSession — the cached, non-blocking catalog view of the session's
 * resolved model. One lookup armed per spec; until (and unless) it lands, the
 * static fallbacks answer:
 *
 *   contextWindow()   catalog-reported, else the static window table — feeds
 *                     compaction, the step-prune budget, and overflow recovery
 *                     with the SAME number.
 *   acceptedMedia()   the attachment sanitizer's policy input — provider class
 *                     caps the wire format immediately (conservative: errs
 *                     toward sanitizing, never toward a rejected request); the
 *                     catalog's input modalities narrow it once the lookup
 *                     lands.
 *   pricing()         the model's real per-1M USD rates, for the mission
 *                     budget's ledger. Null until the lookup lands (or when
 *                     the catalog prices nothing) — the caller falls back to
 *                     the blended rate and RECORDS that it did.
 *
 * Both backends previously carried this whole block verbatim, differing only
 * in the lookup function (provider registry vs LocalModelResolver).
 */

import { contextWindowForModel } from '../context-window';
import { acceptedMediaForModel, type MediaModality } from '../prompting/attachment-sanitizer';
import type { ModelInfo, ModelPricing } from '../providers/types';
import { diagnostics, toProteusError } from '../obs/index';

export class ModelCatalogSession {
  private cached: { spec: string; info: ModelInfo | null } | null = null;

  constructor(private readonly deps: {
    /** The resolved `<provider>/<modelId>` the next turn will use. */
    effectiveSpec: () => string;
    /** The async catalog lookup; resolve null (or throw) when unavailable —
     *  the static fallbacks stay authoritative. */
    lookup: (spec: string) => Promise<ModelInfo | null>;
  }) {}

  /** Catalog ModelInfo for the current spec, cached per spec. Arms the async
   *  lookup on first sight of a spec; never blocks. */
  info(): ModelInfo | null {
    const spec = this.deps.effectiveSpec();
    if (this.cached?.spec !== spec) {
      this.cached = { spec, info: null };
      void this.armLookup(spec);
    }
    return this.cached.info;
  }

  contextWindow(): number {
    return this.info()?.contextWindow ?? contextWindowForModel(this.deps.effectiveSpec());
  }

  /** What the resolved model charges, or null when the catalog has not landed
   *  (or does not price it). */
  pricing(): ModelPricing | null {
    return this.info()?.cost ?? null;
  }

  acceptedMedia(): ReadonlySet<MediaModality> {
    const info = this.info();
    // Only the provider segment is read here (it selects the transport
    // ceiling), and a bare or pre-claim spec simply has none.
    const [provider] = this.deps.effectiveSpec().trim().split('/');
    return acceptedMediaForModel({
      provider,
      catalogInputModalities: info?.inputModalities,
    });
  }

  private async armLookup(spec: string): Promise<void> {
    try {
      const info = await this.deps.lookup(spec);
      if (info && this.cached?.spec === spec) this.cached.info = info;
    } catch (error) {
      // Nothing to propagate to: info() must never block, so this promise is
      // deliberately floating. The static fallbacks stay authoritative, but an
      // empty catalog is otherwise indistinguishable from a priced one that
      // reports nothing — so the reason is stated once, with the spec.
      diagnostics.failure(
        'model.catalog_lookup_failed',
        toProteusError({ doing: 'look a model up in the provider catalog', cause: error, otherwise: 'unavailable' }),
        { model: spec },
      );
    }
  }
}
