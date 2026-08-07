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
 *
 * Both backends previously carried this whole block verbatim, differing only
 * in the lookup function (provider registry vs LocalModelResolver).
 */

import { contextWindowForModel } from '../context-window.js';
import { acceptedMediaForModel, type MediaModality } from '../prompting/attachment-sanitizer.js';
import { parseModelSpec, type ModelInfo } from '../providers/types.js';

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

  acceptedMedia(): ReadonlySet<MediaModality> {
    const info = this.info();
    const spec = this.deps.effectiveSpec();
    let provider: string | undefined;
    try { provider = parseModelSpec(spec).provider; } catch { /* bare or pre-claim spec */ }
    return acceptedMediaForModel({
      ...(provider !== undefined ? { provider } : {}),
      ...(info?.inputModalities ? { catalogInputModalities: info.inputModalities } : {}),
    });
  }

  private async armLookup(spec: string): Promise<void> {
    try {
      const info = await this.deps.lookup(spec);
      if (info && this.cached?.spec === spec) this.cached.info = info;
    } catch { /* catalog unavailable — static fallbacks stay authoritative */ }
  }
}
