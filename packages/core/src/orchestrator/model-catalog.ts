/**
 * Cached catalog view of the session's resolved model, one lookup per spec, shared by both backends.
 * Synchronous reads never block and fall back to the static table; {@link ModelCatalogSession.resolved}
 * is the awaited read for callers that gate work on the answer (#20).
 */

import { contextWindowForModel } from '../context-window';
import { acceptedMediaForModel, type MediaModality } from '../prompting/attachment-sanitizer';
import type { ModelInfo, ModelPricing } from '../providers/types';
import type { PromptModelContext } from '../prompting/model-profile';
import type { ModelWindow, ResolvedModelWindow } from '../prompting/step-prune';
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

export class ModelCatalogSession {
  private cached: { spec: string; info: ModelInfo | null; lookup?: Promise<void> } | null = null;
  /** Catalog entries of a tier's fallbacks. */
  private readonly others = new Map<string, ModelInfo>();

  constructor(private readonly deps: {
    effectiveSpec: () => string;
    /** Resolve null (or throw) when unavailable; the static fallbacks stay authoritative. */
    lookup: (spec: string) => Promise<ModelInfo | null>;
  }) {}

  /** Arms the lookup on first sight of a spec; reads never block. */
  info(): ModelInfo | null {
    const spec = this.deps.effectiveSpec();

    if (this.cached?.spec !== spec) {
      this.cached = { spec, info: null };
      this.cached.lookup = this.armLookup(spec);
    }

    return this.cached.info;
  }

  contextWindow(): number {
    return this.info()?.contextWindow ?? contextWindowForModel(this.deps.effectiveSpec()).window;
  }

  /** False: the static table's stand-in, which a budget may spend and a refusal may not. */
  windowMeasured(): boolean {
    return this.info()?.contextWindow !== undefined
      || contextWindowForModel(this.deps.effectiveSpec()).measured;
  }

  /** Awaited before the provider is called, for decisions that refuse work. */
  async resolved(): Promise<ResolvedModelWindow> {
    // Awaits the cached promise, keeping one catalog round trip.
    this.info();
    await this.cached?.lookup;

    return {
      contextWindow: this.contextWindow(),
      modelOutputLimit: this.modelOutputLimit(),
      windowMeasured: this.windowMeasured(),
    };
  }

  /** Await the selected operation's catalog, independent of the live chat cache. */
  async contextFor(spec: string): Promise<PromptModelContext & ResolvedModelWindow> {
    const info = await this.lookup(spec);
    const table = contextWindowForModel(spec);

    return Object.freeze({
      id: spec,
      contextWindow: info?.contextWindow ?? table.window,
      windowMeasured: info?.contextWindow !== undefined || table.measured,
      modelOutputLimit: info?.modelOutputLimit ?? null,
    });
  }

  /** Null rather than the whole window when nothing reported one: the reserve must not be invented (#20). */
  modelOutputLimit(): number | null {
    return this.info()?.modelOutputLimit ?? null;
  }

  /** The window pair every producer divides (`stepContextLimit`), read now. */
  window(): ModelWindow {
    return { contextWindow: this.contextWindow(), modelOutputLimit: this.modelOutputLimit() };
  }

  /** Null when the catalog has not landed or prices nothing. Another `spec` prices only once warmed. */
  pricing(spec?: string): ModelPricing | null {
    if (spec === undefined || spec === this.deps.effectiveSpec()) return this.info()?.cost ?? null;

    return this.others.get(spec)?.cost ?? null;
  }

  /** Looked up before the turn, so each step prices at its own model's rate; one the catalog refuses stays blended. */
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

  acceptedMedia(): ReadonlySet<MediaModality> {
    const info = this.info();
    // Only the provider segment is read (it selects the transport ceiling).
    const [provider] = this.deps.effectiveSpec().trim().split('/');

    return acceptedMediaForModel({
      provider,
      catalogInputModalities: info?.inputModalities,
    });
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
