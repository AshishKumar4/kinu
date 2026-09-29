/**
 * Cached catalog view per spec for both backends. Synchronous reads fall back to the static table;
 * {@link ModelCatalogSession.resolved} is the awaited read (#20). A model request resolves its spec once
 * and reads through {@link ModelCatalogSession.at}; the live reads resolve it per call.
 */

import { contextWindowForModel, type ModelWindow, type ResolvedModelWindow } from '../context-window';
import { acceptedMediaForModel, type MediaModality } from '../prompting/attachment-sanitizer';
import type { ModelInfo, ModelPricing } from '../providers/types';
import type { PromptModelContext } from '../prompting/model-profile';
import { classifyErrorCode, diagnostics, renderThrownChain, toKinuError } from '../obs/index';

/** Tier, then stored spec, through the backend's normalization, so every row names one spelling. Falls back to the raw value rather than throwing. */
export function resolveEffectiveModelSpec(deps: {
  readonly live: () => string | undefined;
  readonly stored: () => string | null;
  /** Throws when the spec names nothing. */
  readonly normalize: (spec: string | null) => string;
}): string {
  const stored = deps.live() ?? deps.stored();

  try {
    return deps.normalize(stored);
  } catch (error) {
    diagnostics.event('actor.model_spec_unresolvable', { error: renderThrownChain({ cause: error }) });

    return stored ?? '';
  }
}

/** One spec's catalog reads, fixed when a model request is composed. */
export interface ModelCatalogRead {
  readonly spec: string;
  /** The window pair every producer divides (`stepContextLimit`), read now. */
  window(): ModelWindow;
  /** Awaited before the provider is called, for decisions that refuse work. */
  resolved(): Promise<ResolvedModelWindow>;
}

interface CachedEntry { spec: string; info: ModelInfo | null; lookup?: Promise<void> }

export class ModelCatalogSession {
  private cached: CachedEntry | null = null;
  /** Catalog entries of a tier's fallbacks. */
  private readonly others = new Map<string, ModelInfo>();

  constructor(private readonly deps: {
    effectiveSpec: () => string;
    /** Resolve null (or throw) when unavailable; the static fallbacks stay authoritative. */
    lookup: (spec: string) => Promise<ModelInfo | null>;
  }) {}

  /** Arms the lookup on first sight of a spec; reads never block. */
  info(): ModelInfo | null {
    return this.armed(this.deps.effectiveSpec()).info;
  }

  contextWindow(): number {
    return this.windowOf(this.deps.effectiveSpec()).contextWindow;
  }

  /** False: the static table's stand-in, which a budget may spend and a refusal may not. */
  windowMeasured(): boolean {
    return this.windowOf(this.deps.effectiveSpec()).windowMeasured;
  }

  /** Awaited before the provider is called, for decisions that refuse work. */
  resolved(): Promise<ResolvedModelWindow> {
    return this.resolvedOf(this.deps.effectiveSpec());
  }

  /** The reads of one request, on the spec it resolved once. */
  at(spec: string): ModelCatalogRead {
    return Object.freeze({
      spec,
      window: () => this.windowPairOf(spec),
      resolved: () => this.resolvedOf(spec),
    });
  }

  /** Await the selected operation's catalog, independent of the live chat cache. */
  async contextFor(spec: string): Promise<PromptModelContext & ResolvedModelWindow> {
    return Object.freeze({ id: spec, ...ModelCatalogSession.windowFrom(spec, await this.lookup(spec)) });
  }

  /** Null rather than the whole window when nothing reported one: the reserve must not be invented (#20). */
  modelOutputLimit(): number | null {
    return this.info()?.modelOutputLimit ?? null;
  }

  /** The window pair every producer divides (`stepContextLimit`), read now. */
  window(): ModelWindow {
    return this.windowPairOf(this.deps.effectiveSpec());
  }

  /** Null until the catalog lands or when it prices nothing; another `spec` only once warmed. */
  pricing(spec?: string): ModelPricing | null {
    const own = this.deps.effectiveSpec();

    if (spec === undefined || spec === own) return this.armed(own).info?.cost ?? null;

    return this.others.get(spec)?.cost ?? null;
  }

  /** Warmed before the turn so each step prices at its model's rate; a refused one stays blended. */
  async warm(specs: readonly string[]): Promise<void> {
    await Promise.all(specs.filter((spec) => !this.others.has(spec)).map(async (spec) => {
      try {
        const info = await this.lookup(spec);

        if (info !== null) this.others.set(spec, info);
      } catch (cause) {
        diagnostics.failure(
          'model.catalog_lookup_failed',
          toKinuError({ doing: 'price a fallback model', cause, otherwise: 'unavailable' }),
          { model: spec },
        );
      }
    }));
  }

  /** The turn's model, or another `spec` once warmed, as `pricing` reads it. */
  acceptedMedia(spec?: string): ReadonlySet<MediaModality> {
    const own = this.deps.effectiveSpec();
    const named = spec ?? own;
    const info = named === own ? this.armed(own).info : this.others.get(named) ?? null;
    // Only the provider segment is read (it selects the transport ceiling).
    const [provider] = named.trim().split('/');

    return acceptedMediaForModel({
      provider,
      catalogInputModalities: info?.inputModalities,
    });
  }

  private armed(spec: string): CachedEntry {
    if (this.cached?.spec !== spec) {
      this.cached = { spec, info: null };
      this.cached.lookup = this.armLookup(spec);
    }

    return this.cached;
  }

  private windowOf(spec: string): ResolvedModelWindow {
    return ModelCatalogSession.windowFrom(spec, this.armed(spec).info);
  }

  private windowPairOf(spec: string): ModelWindow {
    const { contextWindow, modelOutputLimit } = this.windowOf(spec);

    return { contextWindow, modelOutputLimit };
  }

  private async resolvedOf(spec: string): Promise<ResolvedModelWindow> {
    // Awaits the cached promise, keeping one catalog round trip.
    await this.armed(spec).lookup;

    return this.windowOf(spec);
  }

  private static windowFrom(spec: string, info: ModelInfo | null): ResolvedModelWindow {
    const table = contextWindowForModel(spec);

    return {
      contextWindow: info?.contextWindow ?? table.window,
      modelOutputLimit: info?.modelOutputLimit ?? null,
      windowMeasured: info?.contextWindow !== undefined || table.measured,
    };
  }

  private async armLookup(spec: string): Promise<void> {
    await this.lookup(spec, info => {
      if (info && this.cached?.spec === spec) this.cached.info = info;
    });
  }

  private async lookup(spec: string, accept?: (info: ModelInfo | null) => void): Promise<ModelInfo | null> {
    try {
      const info = await this.deps.lookup(spec);
      accept?.(info);

      return info;
    } catch (cause) {
      // Only an unreachable catalog is tolerated; any other classified failure propagates.
      const reason = classifyErrorCode({ cause });

      if (reason !== null && reason !== 'unavailable' && reason !== 'io' && reason !== 'timeout') throw cause;

      // Reads never block, so the reason is logged once, with the spec.
      diagnostics.failure(
        'model.catalog_lookup_failed',
        toKinuError({ doing: 'look a model up in the provider catalog', cause, otherwise: 'unavailable' }),
        { model: spec },
      );

      return null;
    }
  }
}
