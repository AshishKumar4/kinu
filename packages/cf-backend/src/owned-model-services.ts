import type { LanguageModel } from 'ai';
import {
  agentAffinityKey, parseModelSpec, reasoningEffortOptions,
  buildProviderCatalogSnapshot, ProviderListingCache,
  type ProviderListing, type ProviderSnapshotRead, type ReasoningEffort,
  type WebSearchProvider,
} from '@kinu.run/core';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
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
  /** This account's credential revision, from the object that owns the store.
   *  Resolved lazily and best-effort: an unreachable authority leaves the cache
   *  as it is (the fan-out and the next successful read still repair it),
   *  because refusing a turn over a cache-freshness question would trade a
   *  stale catalog for a dead agent. */
  readonly getCredentialsRevision: () => Promise<number>;
}

/** Owner-scoped provider, model, affinity, and web services shared by CF agents. */
export class OwnedModelServices {
  private providerRegistryCache: AgentProviderRegistry | null = null;
  private webSearchProviderCache: WebSearchProvider | null = null;
  private judgeSpecCache: { key: string; spec: string } | null = null;
  private modelCache: { spec: string; model: LanguageModel } | null = null;
  /** The account credential revision the provider listing was last swept
   *  under. Differing from the live one is what invalidates the listing at use,
   *  without a clock and without depending on the fan-out having landed. */
  private cachedCredentialsRevision: number | null = null;
  /**
   * The last COMPLETE provider listing, and the sweep currently in flight.
   *
   * The cache POLICY is core's (`ProviderListingCache`): one sweep at a time
   * with concurrent callers joining it, complete listings only, a generation
   * guard so an invalidation landing mid-sweep still answers its caller without
   * poisoning the cache, and expiry by signal rather than by clock. Every one of
   * those four rules used to be written here and again in the CLI, holding the
   * key — `revision` — that every other cache is kept against.
   *
   * What stays here is the SWEEP and its trigger: `invalidate()` is the hook
   * every credential mutation, model rebind and owner claim already reaches, and
   * that is genuinely this platform's half. A turn used to pay a full credential
   * sweep — models.dev, Codex, every connected provider — before it could stream
   * a single byte.
   */
  private readonly providerListings = new ProviderListingCache(
    () => this.sweepProviderListing(),
  );

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
   * that could not be read.
   */
  async profileProviderSnapshot(): Promise<ProviderSnapshotRead> {
    // THE DURABLE RECONCILIATION, before anything is read: the account's
    // credential revision, compared against the one this cache was last swept
    // under. The fan-out notification is the fast path and can fail silently;
    // this comparison is the one that cannot, because it reads the same store
    // the mutation wrote. Best-effort by design — see the options' declaration
    // of `getCredentialsRevision` for why an unreachable authority must leave
    // the cache alone here rather than fail the turn.
    try {
      const revision = await this.options.getCredentialsRevision();
      if (revision !== this.cachedCredentialsRevision) this.invalidate();
      this.cachedCredentialsRevision = revision;
    } catch (cause) {
      // Recorded, not swallowed: the cache is left as it is deliberately, and
      // what that costs — a listing that may be one mutation stale until the
      // authority answers again — is only diagnosable if the failure is named.
      diagnostics.failure('profile.credentials_revision_unreadable', toKinuError({
        doing: 'reading the account credential revision a cached provider listing is measured against',
        cause,
        otherwise: 'unavailable',
      }), { agent: this.options.agentName() });
    }
    const { listing, cache } = await this.providerListings.read();
    // The assembly — dedupe, sort, `label ?? provider`, and the failure fold
    // into `revision` — is core's. `revision` is the key every other cache is
    // held against, so the formula deciding when profiles re-resolve had to stop
    // being a twin of the CLI's.
    const snapshot = buildProviderCatalogSnapshot(listing.models, listing.failures);
    diagnostics.event('profile.provider_snapshot.resolved', {
      cache,
      models: snapshot.availableModels.length,
      unavailable: listing.failures.length,
      revision: snapshot.revision,
    });
    return { snapshot, cache };
  }

  /** One credential sweep, measured. Everything about WHEN this runs and
   *  whether its answer is kept is core's cache policy; this is only the
   *  platform call it wraps. */
  private async sweepProviderListing(): Promise<ProviderListing> {
    const startedAt = Date.now();
    const { registry, deps } = this.providerRegistry();
    const menu = await registry.listAllModels(deps);
    const listing: ProviderListing = {
      models: menu.models.map((model) => `${model.provider}/${model.id}`),
      failures: menu.failures,
    };
    diagnostics.event('profile.provider_listing.swept', {
      ms: Date.now() - startedAt,
      models: listing.models.length,
      unavailable: listing.failures.length,
    });
    return listing;
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
   *  This is the provider listing's ONLY expiry, and the trigger is the half of
   *  the cache that genuinely belongs to this platform: every credential
   *  mutation, model rebind and owner claim already reaches here, so the listing
   *  is rebuilt when it stops being true rather than on a clock. What dropping
   *  it MEANS — including that the in-flight sweep goes with it, since one
   *  started before a credential changed would otherwise be handed to everyone
   *  who joined it — is core's rule now. */
  invalidate(): void {
    this.providerRegistryCache = null;
    this.judgeSpecCache = null;
    this.modelCache = null;
    this.providerListings.invalidate();
  }
}
