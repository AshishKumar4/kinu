import type { LanguageModel } from 'ai';
import {
  agentAffinityKey, parseModelSpec, reasoningEffortOptions, sha256Hex,
  type ProviderCatalogSnapshot, type ReasoningEffort, type WebSearchProvider,
} from '@kinu.run/core';
import { diagnostics } from '@kinu.run/core/obs';
import { buildCfWebSearchProvider } from './lib/web-provider';
import {
  createAgentProviderRegistry,
  type AgentProviderRegistry,
} from './providers/agent-registry';
import { resolveReviewingModelSelection } from './providers/judge-model';
import type { UserDO } from './user/user-do';
import type { UserCaller } from './user/workspace-capability';

export interface OwnedModelServicesOptions {
  readonly env: Env;
  /** Resolved lazily: a facet's logical name is only set by the async
   *  _cf_initAsFacet after construction, so this must not be read eagerly. */
  readonly agentName: () => string;
  readonly appTitle: string;
  readonly ownerRequired: boolean;
  readonly getOwnerUserId: () => string | null;
  /** How this actor proves its workspace identity to the UserDO. Resolved per
   *  call: a facet reads it from its parent, and a workspace only has one once
   *  the Worker has claimed it. */
  readonly getUserCaller: () => Promise<UserCaller>;
}

/** Owner-scoped provider, model, affinity, and web services shared by CF agents. */
export class OwnedModelServices {
  private providerRegistryCache: AgentProviderRegistry | null = null;
  private webSearchProviderCache: WebSearchProvider | null = null;
  private judgeSpecCache: { key: string; spec: string } | null = null;
  private modelCache: { spec: string; model: LanguageModel } | null = null;
  /**
   * The last COMPLETE provider listing, and the sweep currently in flight.
   *
   * Held here rather than at the callers because this is the only place that
   * knows when it stops being true: `invalidate()` is already the hook every
   * credential mutation, model rebind and owner claim reaches, so the cache
   * expires on CHANGE and never on elapsed time. A turn used to pay a full
   * credential sweep — models.dev, Codex, every connected provider — before it
   * could stream a single byte.
   */
  private providerSnapshotCache: ProviderCatalogSnapshot | null = null;
  private providerSnapshotPending: Promise<ProviderCatalogSnapshot> | null = null;
  /** Bumped by `invalidate()`. A sweep that started under an older generation
   *  may answer its own caller but may never populate the cache. */
  private providerSnapshotGeneration = 0;

  constructor(private readonly options: OwnedModelServicesOptions) {}

  /** Workers-AI session-affinity key. Computed lazily so it reads the facet's
   *  logical name at call time, not the unresolved construction-time value. */
  get affinityKey(): string {
    return agentAffinityKey(this.options.agentName());
  }

  providerRegistry(): AgentProviderRegistry {
    if (this.providerRegistryCache) return this.providerRegistryCache;

    const userId = this.options.getOwnerUserId();
    if (!userId && this.options.ownerRequired) {
      throw new Error('Agent has no owner_user_id yet — Worker must call claimOwner before any model use.');
    }
    // SAFETY: The UserDO namespace binding declares UserDO as its stub contract.
    const userDOStub = userId
      ? this.options.env.UserDO.get(this.options.env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>
      : null;

    this.providerRegistryCache = createAgentProviderRegistry({
      env: this.options.env,
      userDO: userDOStub ? { stub: userDOStub, caller: this.options.getUserCaller } : null,
      appTitle: this.options.appTitle,
      workersAI: { sessionAffinity: this.affinityKey },
    });
    return this.providerRegistryCache;
  }

  /** The resolved model for `spec`, memoized on the NORMALIZED spec.
   *
   *  Cached here rather than in each caller: Think asks for the model once per
   *  turn and a head asked for it once per STEP, rebuilding the registry lookup
   *  every time. `invalidate()` drops it with the rest of the owner-bound state. */
  resolveModel(spec?: string | null): LanguageModel {
    const registry = this.providerRegistry();
    const normalized = registry.normalizeSpecSync(spec);
    if (this.modelCache?.spec === normalized) return this.modelCache.model;
    const model = registry.resolveModel(normalized);
    this.modelCache = { spec: normalized, model };
    return model;
  }

  /** The same memoized model plus the reasoning-effort provider options for it.
   *  One implementation of "normalize the spec, resolve it, derive its effort
   *  options" — the head path needs the pair and used to rebuild both per call. */
  resolveModelWithEffort(spec: string | null | undefined, effort: ReasoningEffort) {
    const registry = this.providerRegistry();
    const normalized = registry.normalizeSpecSync(spec);
    return {
      model: this.resolveModel(normalized),
      providerOptions: reasoningEffortOptions(effort, parseModelSpec(normalized).provider),
    };
  }

  /**
   * Credential-aware model set used by profile resolution, plus the providers
   * that could not be asked.
   *
   * The failure set is load-bearing, not diagnostics. `listAllModels` never
   * rejects for one provider — a revoked credential or a 503 costs only that
   * provider's models and is reported as a failure row. Dropping those rows
   * made an unanswered provider indistinguishable from one that answered and
   * genuinely lacks the model, and core's resolver validates EVERY tier slot,
   * so a single degraded listing refused every turn of any account pinning any
   * tier to that provider. Passed through verbatim: the row's `provider` is the
   * same `p.id` that prefixes `availableModels`, so the resolver can match a
   * tier's spec against it without a mapping that could drift.
   *
   * `revision` covers the failures too. It is the key other caches are held
   * against, and a snapshot taken while a provider was down would otherwise be
   * revision-identical to a healthy one — serving a degraded model set as if it
   * were the whole picture.
   */
  async profileProviderSnapshot(): Promise<ProviderCatalogSnapshot> {
    if (this.providerSnapshotCache) {
      diagnostics.event('profile.provider_snapshot.cache_hit', {
        cache: 'hit', revision: this.providerSnapshotCache.revision,
      });
      return this.providerSnapshotCache;
    }
    // Concurrent turns share ONE sweep. Every stream that opened before the
    // first finished used to start its own credential listing, so the cost was
    // paid per stream rather than per change — and a models.dev or Codex
    // refresh landing inside that window blocked all of them.
    if (this.providerSnapshotPending) {
      diagnostics.event('profile.provider_snapshot.request_joined', { cache: 'joined' });
      return this.providerSnapshotPending;
    }
    const pending = this.buildProviderSnapshot();
    this.providerSnapshotPending = pending;
    try {
      return await pending;
    } finally {
      if (this.providerSnapshotPending === pending) this.providerSnapshotPending = null;
    }
  }

  /**
   * One credential sweep, measured, and memoized only when it was COMPLETE.
   *
   * A degraded listing is deliberately not cached. Under the resolver's rule a
   * non-empty failure set admits every configured model unverified, so caching
   * one would hold that window open past the fault it came from and freeze
   * `revision` at a degraded value — which is the exact thing folding failures
   * into the revision exists to prevent. The inverse hazard closes with it: a
   * cached snapshot always carries an empty failure set that was TRUE when
   * taken, so a provider going unreachable produces a fresh sweep rather than a
   * stale hard-refusal of a model the owner just connected.
   *
   * Cost, accepted: while a provider is failing the sweep is paid every turn.
   * That is the right trade against serving a known-partial availability
   * picture indefinitely, and it needs no timeout to expire — nothing here
   * expires by elapsed time, only by `invalidate()`.
   */
  private async buildProviderSnapshot(): Promise<ProviderCatalogSnapshot> {
    const startedAt = Date.now();
    // Captured before the await. A credential change landing mid-sweep bumps
    // the generation, and the result below is then returned to its caller but
    // NOT cached — a listing of the world before the change must not become the
    // answer for every turn after it.
    const generation = this.providerSnapshotGeneration;
    const { registry, deps } = this.providerRegistry();
    const menu = await registry.listAllModels(deps);
    const availableModels = [...new Set(
      menu.models.map((model) => `${model.provider}/${model.id}`),
    )].sort();
    // Sorted so the revision is stable across listings that differ only in the
    // order providers happened to fail in. `ProviderFailure.label` is optional;
    // the id is the honest fallback, so the snapshot's rows are total and a
    // reader never has to render a blank label.
    const unavailableProviders = menu.failures
      .map(({ provider, label, reason }) => ({ provider, label: label ?? provider, reason }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.reason.localeCompare(b.reason));
    const snapshot: ProviderCatalogSnapshot = {
      revision: sha256Hex([
        ...availableModels,
        // `!` cannot begin a model spec, so a failure line never collides with
        // one — two snapshots differing only by a failure hash differently.
        ...unavailableProviders.map(({ provider, reason }) => `!${provider}\t${reason}`),
      ].join('\n')),
      availableModels,
      unavailableProviders,
    };
    const stale = generation !== this.providerSnapshotGeneration;
    const complete = unavailableProviders.length === 0;
    if (complete && !stale) this.providerSnapshotCache = snapshot;
    diagnostics.event('profile.provider_snapshot.resolved', {
      cache: 'miss',
      ms: Date.now() - startedAt,
      models: availableModels.length,
      unavailable: unavailableProviders.length,
      cached: complete && !stale,
      stale,
      revision: snapshot.revision,
    });
    return snapshot;
  }

  /**
   * The model that judges this agent's own output — `review_model` when the
   * operator set one, else a different-vendor model when one is connected,
   * else the chat model itself (see core's selectJudgeModel). Cached per
   * (review, chat) pair because the cross-family search costs a credential
   * listing; `invalidate()` drops it with the rest of the owner-bound state.
   */
  async resolveJudgeModel(opts: { reviewSpec: string | null; chatSpec: string | null }): Promise<LanguageModel> {
    const registry = this.providerRegistry();
    const key = `${opts.reviewSpec ?? ''}\n${opts.chatSpec ?? ''}`;
    if (this.judgeSpecCache?.key !== key) {
      const { spec } = await resolveReviewingModelSelection({ registry, pinned: opts.reviewSpec, chatSpec: opts.chatSpec });
      this.judgeSpecCache = { key, spec };
    }
    return registry.resolveModel(this.judgeSpecCache.spec);
  }

  getWebSearchProvider(): WebSearchProvider {
    if (this.webSearchProviderCache) return this.webSearchProviderCache;
    this.webSearchProviderCache = buildCfWebSearchProvider(
      this.options.env,
      () => this.options.getOwnerUserId() ? this.providerRegistry().deps.getAuth : undefined,
    );
    return this.webSearchProviderCache;
  }

  /** Drop owner-bound provider/auth state; the web provider resolves it per call.
   *
   *  This is the provider snapshot's ONLY expiry. Every credential mutation,
   *  model rebind and owner claim already reaches here, so the listing is
   *  rebuilt when it stops being true rather than on a clock. The in-flight
   *  sweep is dropped too: one started before a credential changed would
   *  otherwise resolve into the cache describing the world before the change. */
  invalidate(): void {
    this.providerRegistryCache = null;
    this.judgeSpecCache = null;
    this.modelCache = null;
    this.providerSnapshotCache = null;
    this.providerSnapshotPending = null;
    this.providerSnapshotGeneration += 1;
  }
}
