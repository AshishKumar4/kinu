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

/** One spec's catalog row once its held lookup lands; `settled` once it has, row or none. */
interface CachedEntry { info: ModelInfo | null; settled: boolean; lookup?: Promise<Exit.Exit<ModelInfo | null>> }

/** One entry per spec, whichever the turn selects: the effective spec only picks the entry read when none is named. */
export class ModelCatalogSession {
  private readonly entries = new Map<string, CachedEntry>();

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
    return this.window().contextWindow;
  }

  /** Awaited before the provider is called, for decisions that refuse work. */
  resolved(): Promise<ModelWindow> {
    return this.windowFor(this.deps.effectiveSpec());
  }

  /** The reads of one request, on the spec it resolved once. */
  at(spec: string): ModelCatalogRead {
    return Object.freeze({
      window: () => this.window(spec),
      resolved: () => this.windowFor(spec),
    });
  }

  /** Await the selected operation's catalog, independent of the live chat cache. */
  async contextFor(spec: string): Promise<PromptModelContext & ModelWindow> {
    const context: PromptModelContext & ModelWindow = { id: spec, ...await this.windowFor(spec), callsTools: this.callsTools(spec) };

    return Object.freeze(context);
  }

  /** Whether `spec` calls tools, as its catalog row says: a row listing capabilities names tool calling among them, or
   *  the model calls none. Undefined while no row, or no list, says. */
  callsTools(spec?: string): boolean | undefined {
    return this.infoOf(spec)?.capabilities?.includes('tools');
  }

  /** As {@link contextFor}, the window alone: what a head or swarm node on `spec` is admitted against. Joins the held
   *  lookup, keeping one catalog round trip, and answers its refusal. */
  windowFor(spec: string): Promise<ModelWindow> {
    return settle(Effect.map(this.joined(this.armed(spec)), () => this.window(spec)));
  }

  window(spec?: string): ModelWindow {
    const named = spec ?? this.deps.effectiveSpec();

    return this.windowFrom(named, this.armed(named).info);
  }

  /** Null until the catalog lands or when it prices nothing. */
  pricing(spec?: string): ModelPricing | null {
    return this.infoOf(spec)?.cost ?? null;
  }

  /** Warmed before the turn so each step prices at its model's rate; a spec its catalog has not priced is asked again,
   *  and a refused one stays blended. */
  warm(specs: readonly string[]): Promise<void> {
    return settle(Effect.forEach(specs, (spec) => Effect.catchCause(this.joined(this.armed(spec, true)), (failed) => Effect.sync(() => {
      diagnostics.failure(
        'model.catalog_lookup_failed',
        toKinuError({ doing: 'price a fallback model', cause: Cause.squash(failed), otherwise: 'unavailable' }),
        { model: spec },
      );
    })), { concurrency: 'unbounded', discard: true }));
  }

  acceptedMedia(spec?: string): ReadonlySet<MediaModality> {
    const named = spec ?? this.deps.effectiveSpec();

    return acceptedMediaForModel({ spec: named, catalogInputModalities: this.infoOf(named)?.inputModalities });
  }

  private infoOf(spec?: string): ModelInfo | null {
    return this.armed(spec ?? this.deps.effectiveSpec()).info;
  }

  /** `spec`'s entry, its lookup armed on first sight; `again` re-arms one that settled with no row. */
  private armed(spec: string, again = false): CachedEntry {
    const known = this.entries.get(spec);

    if (known !== undefined && !(again && known.settled && known.info === null)) return known;
    const entry: CachedEntry = { info: null, settled: false };

    // Held, not left floating: a sync read arms it, and only an awaited read answers its refusal.
    entry.lookup = hold(Effect.ensuring(this.lookup(spec, (info) => { entry.info = info; }), Effect.sync(() => { entry.settled = true; })));
    this.entries.set(spec, entry);

    return entry;
  }

  /** The entry's held lookup, its refusal failing here. */
  private joined(entry: CachedEntry): Effect.Effect<void> {
    return Effect.gen(function* () {
      const held = entry.lookup;

      if (held !== undefined) yield* (yield* Effect.promise(() => held));
    });
  }

  private windowFrom(spec: string, info: ModelInfo | null): ModelWindow {
    const window = modelWindow(info);

    return window.contextWindow === null ? { ...window, contextWindow: this.deps.measured(spec) } : window;
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
