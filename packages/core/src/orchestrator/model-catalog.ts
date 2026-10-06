/** Cached catalog view per spec for both backends; {@link ModelCatalogSession.resolved} is the awaited read (#20). */

import { modelWindow, type ModelWindow } from '../context-window';
import { acceptedMediaForModel, type MediaModality } from '../prompting/attachment-sanitizer';
import type { ModelInfo, ModelPricing } from '../providers/types';
import type { PromptModelContext } from '../prompting/model-profile';
import { Cause, Effect, type Exit } from 'effect';
import { classifyErrorCode, diagnostics, hold, renderThrownChain, settle, settleSync, toKinuError } from '../obs/index';

/** Tier, then stored spec, through the backend's normalization, so every row names one spelling. Falls back to the raw value rather than throwing. */
export function resolveEffectiveModelSpec(deps: {
  readonly live: () => string | undefined;
  readonly stored: () => string | null;
  /** Throws when the spec names nothing. */
  readonly normalize: (spec: string | null) => string;
}): string {
  const stored = deps.live() ?? deps.stored();

  return settleSync(Effect.catchCause(Effect.sync(() => deps.normalize(stored)), (failed) => Effect.sync(() => {
    diagnostics.event('actor.model_spec_unresolvable', { error: renderThrownChain({ cause: Cause.squash(failed) }) });

    return stored ?? '';
  })));
}

/** One spec's catalog reads, fixed when a model request is composed. */
export interface ModelCatalogRead {
  /** The window pair every producer divides (`stepContextLimit`), read now. */
  window(): ModelWindow;
  /** Awaited before the provider is called, for decisions that refuse work. */
  resolved(): Promise<ModelWindow>;
}

interface CachedEntry { spec: string; info: ModelInfo | null; lookup?: Promise<Exit.Exit<ModelInfo | null>> }

export class ModelCatalogSession {
  private cached: CachedEntry | null = null;
  /** Catalog entries of a tier's fallbacks. */
  private readonly others = new Map<string, ModelInfo>();

  constructor(private readonly deps: {
    effectiveSpec: () => string;
    /** Resolve null (or throw) when unavailable: the window is then unknown. */
    lookup: (spec: string) => Promise<ModelInfo | null>;
    /** A too-long refusal's window for `spec`, or null. */
    measured: (spec: string) => number | null;
  }) {}

  /** Arms the lookup on first sight of a spec; reads never block. */
  info(): ModelInfo | null {
    return this.armed(this.deps.effectiveSpec()).info;
  }

  contextWindow(): number | null {
    return this.windowOf(this.deps.effectiveSpec()).contextWindow;
  }

  /** Awaited before the provider is called, for decisions that refuse work. */
  resolved(): Promise<ModelWindow> {
    return settle(this.resolvedOf(this.deps.effectiveSpec()));
  }

  /** The reads of one request, on the spec it resolved once. */
  at(spec: string): ModelCatalogRead {
    return Object.freeze({
      window: () => this.windowOf(spec),
      resolved: () => settle(this.resolvedOf(spec)),
    });
  }

  /** Await the selected operation's catalog, independent of the live chat cache. */
  async contextFor(spec: string): Promise<PromptModelContext & ModelWindow> {
    return Object.freeze({ id: spec, ...await this.windowFor(spec) });
  }

  /** As {@link contextFor}, the window alone: what a head or swarm node on `spec` is admitted against. */
  windowFor(spec: string): Promise<ModelWindow> {
    return settle(Effect.map(this.lookup(spec), (info) => this.windowFrom(spec, info)));
  }

  window(spec?: string): ModelWindow {
    const own = this.deps.effectiveSpec();

    return spec === undefined || spec === own ? this.windowOf(own) : this.windowFrom(spec, this.others.get(spec) ?? null);
  }

  /** Null until the catalog lands or when it prices nothing; another `spec` only once warmed. */
  pricing(spec?: string): ModelPricing | null {
    const own = this.deps.effectiveSpec();

    if (spec === undefined || spec === own) return this.armed(own).info?.cost ?? null;

    return this.others.get(spec)?.cost ?? null;
  }

  /** Warmed before the turn so each step prices at its model's rate; a refused one stays blended. */
  warm(specs: readonly string[]): Promise<void> {
    return settle(Effect.forEach(specs.filter((spec) => !this.others.has(spec)), (spec) => Effect.catchCause(Effect.gen({ self: this }, function* () {
      const info = yield* this.lookup(spec);

      if (info !== null) this.others.set(spec, info);
    }), (failed) => Effect.sync(() => {
      diagnostics.failure(
        'model.catalog_lookup_failed',
        toKinuError({ doing: 'price a fallback model', cause: Cause.squash(failed), otherwise: 'unavailable' }),
        { model: spec },
      );
    })), { concurrency: 'unbounded', discard: true }));
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
      // Held, not left floating: a sync read arms it, and only `resolved` answers its refusal.
      this.cached.lookup = hold(this.lookup(spec, info => {
        if (info && this.cached?.spec === spec) this.cached.info = info;
      }));
    }

    return this.cached;
  }

  private windowOf(spec: string): ModelWindow {
    return this.windowFrom(spec, this.armed(spec).info);
  }

  private windowFrom(spec: string, info: ModelInfo | null): ModelWindow {
    const window = modelWindow(info);

    return window.contextWindow === null ? { ...window, contextWindow: this.deps.measured(spec) } : window;
  }

  private resolvedOf(spec: string): Effect.Effect<ModelWindow> {
    return Effect.gen({ self: this }, function* () {
      // Joins the held lookup, keeping one catalog round trip.
      const held = this.armed(spec).lookup;

      // A held refusal is answered here, as the awaited read it was before.
      if (held !== undefined) yield* (yield* Effect.promise(() => held));

      return this.windowOf(spec);
    });
  }

  private lookup(spec: string, accept?: (info: ModelInfo | null) => void): Effect.Effect<ModelInfo | null> {
    return Effect.catchCause(Effect.gen({ self: this }, function* () {
      const info = yield* Effect.promise(() => this.deps.lookup(spec));
      accept?.(info);

      return info;
    }), (failed) => {
      const cause = Cause.squash(failed);
      // Only an unreachable catalog is tolerated; any other classified failure propagates.
      const reason = classifyErrorCode({ cause });

      if (reason !== null && reason !== 'unavailable' && reason !== 'io' && reason !== 'timeout') return Effect.die(cause);

      // Reads never block, so the reason is logged once, with the spec.
      return Effect.sync(() => {
        diagnostics.failure(
          'model.catalog_lookup_failed',
          toKinuError({ doing: 'look a model up in the provider catalog', cause, otherwise: 'unavailable' }),
          { model: spec },
        );

        return null;
      });
    });
  }
}
