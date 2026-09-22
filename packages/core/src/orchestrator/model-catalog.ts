/**
 * ModelCatalogSession — the cached catalog view of the session's resolved
 * model. One lookup armed per spec; the SYNCHRONOUS reads never block and the
 * static table answers until (and unless) it lands:
 *
 *   contextWindow()   catalog-reported, else the static window table — feeds
 *                     compaction, the step-prune budget, and overflow recovery
 *                     with the SAME number.
 *   windowMeasured()  whether that number is a figure somebody measured off
 *                     this model, or the table's stand-in for a spec nothing
 *                     here has an entry for.
 *   modelOutputLimit() the answer allowance context admission reserves out of
 *                     that window. Catalog-reported, else NULL — an unanswered
 *                     catalog says nothing about how much of the window the
 *                     answer takes, and every number that could be written here
 *                     instead (the whole window, a picked share) reads as a
 *                     fact and is spent as one.
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
 * {@link ModelCatalogSession.resolved} is the one AWAITED read, for the caller
 * that is about to gate work on the answer: a turn assembled on the first
 * activation after an isolate start measured itself against the stand-in table
 * while the lookup that knew better was already in flight (#20). Awaiting it
 * costs one lookup per spec, before any provider call, and every synchronous
 * read afterwards answers from the landed catalog.
 *
 * One implementation for both backends — they differ only in the lookup
 * function (provider registry vs LocalModelResolver).
 */

import { contextWindowForModel } from '../context-window';
import { acceptedMediaForModel, type MediaModality } from '../prompting/attachment-sanitizer';
import type { ModelInfo, ModelPricing } from '../providers/types';
import type { PromptModelContext } from '../prompting/model-profile';
import type { ResolvedModelWindow } from '../prompting/step-prune';
import { classifyErrorCode, diagnostics, renderThrownChain, toKinuError } from '../obs/index';

/**
 * The one spelling of the model the next turn actually runs on.
 *
 * The claimed turn's tier wins, then the stored config spec, and whichever it
 * is goes through the backend's normalization — the same one `setModel`
 * validates with — so a bare id, an alias and the canonical form all read back
 * as ONE string. This is the value every `model_call` row is priced against
 * and every analytics row is grouped by: a dataset whose `model` column holds
 * three spellings of one model cannot be grouped by it, and a rate compared
 * against a spelling the report did not use prices nothing.
 *
 * A spec the backend cannot normalize yet (no provider registry before the
 * first claim) falls back to the raw stored value rather than throwing: the
 * caller is a catalog read or a ledger row, and neither may cost a turn.
 */
export function resolveEffectiveModelSpec(deps: {
  /** The tier model of the turn in flight, or undefined between turns. */
  readonly live: () => string | undefined;
  /** The stored config spec, or null when unset. */
  readonly stored: () => string | null;
  /** The backend's canonical spelling of a spec; throws when it names nothing. */
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

  constructor(private readonly deps: {
    /** The resolved `<provider>/<modelId>` the next turn will use. */
    effectiveSpec: () => string;
    /** The async catalog lookup; resolve null (or throw) when unavailable —
     *  the static fallbacks stay authoritative. */
    lookup: (spec: string) => Promise<ModelInfo | null>;
  }) {}

  /** Catalog ModelInfo for the current spec, cached per spec. Arms the async
   *  lookup on first sight of a spec; the cache owns its completion, but reads
   *  never block. */
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

  /** Whether {@link contextWindow} is a figure measured off this model. False
   *  says it is the static table's stand-in for a spec nothing here has an
   *  entry for — a number a budget may spend and a refusal may not. */
  windowMeasured(): boolean {
    return this.info()?.contextWindow !== undefined
      || contextWindowForModel(this.deps.effectiveSpec()).measured;
  }

  /**
   * The current spec's window, AFTER the armed lookup has settled.
   *
   * The synchronous reads above are deliberately non-blocking, which is right
   * for a budget and wrong for a decision that refuses work: the first turn of
   * a fresh isolate measured itself against the stand-in table while the lookup
   * that knew the real window was still in flight. One await per spec, taken
   * before the provider is called, and every synchronous read after it answers
   * from the landed catalog.
   */
  async resolved(): Promise<ResolvedModelWindow> {
    // `info()` arms the lookup for the current spec and caches the promise;
    // awaiting THAT — rather than calling `lookup` again — is what keeps this
    // to one catalog round trip shared with every synchronous reader.
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

  /**
   * The largest answer the resolved model will produce, out of the window
   * {@link contextWindow} reports, or null when nothing has reported one.
   *
   * Null rather than the whole window. "The answer may take all of it" reads as
   * the honest reading of an unanswered catalog and is not one: the half bound
   * in `outputReserveTokens` then withheld half of every unreported model's
   * window, which is how a 1M-window model came to refuse a 124,644-token
   * request against 64,000 (#20). An absent figure is absent, and the reserve
   * is the one thing that may not be invented from it.
   */
  modelOutputLimit(): number | null {
    return this.info()?.modelOutputLimit ?? null;
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
      // The failure this catch tolerates is the catalog being unreachable —
      // a transport condition, never a fault in the lookup itself. Anything
      // with a real signature (denied, bad input, cancelled, oom) is not
      // "unavailable" and propagates rather than masquerading as an empty
      // catalog.
      const reason = classifyErrorCode({ cause });

      if (reason !== null && reason !== 'unavailable' && reason !== 'io' && reason !== 'timeout') throw cause;

      // Nothing to propagate to: reads never block, while the cache retains this
      // lookup until it settles. The static fallbacks stay authoritative, but an
      // empty catalog is otherwise indistinguishable from a priced one that
      // reports nothing — so the reason is stated once, with the spec.
      diagnostics.failure(
        'model.catalog_lookup_failed',
        toKinuError({ doing: 'look a model up in the provider catalog', cause, otherwise: 'unavailable' }),
        { model: spec },
      );

      return null;
    }
  }
}
