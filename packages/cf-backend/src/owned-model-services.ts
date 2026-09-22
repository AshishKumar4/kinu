import type { LanguageModel } from 'ai';
import {
  agentAffinityKey, parseModelSpec, reasoningEffortOptions,
  buildProviderCatalogSnapshot, ProviderListingCache,
  type ProviderListing, type ProviderSnapshotRead, type ReasoningEffort,
  type ProviderWaitInfo,
  type WebSearchProvider,
  type ProviderEnv, type WorkersAIBinding,
} from '@kinu.run/core';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import { buildCfWebSearchProvider } from '@kinu.run/core';
import {
  createAgentProviderRegistry,
  type AgentProviderRegistry, type UserCredentialClient,
} from './providers/agent-registry';
import { resolveReviewingModelSelection } from './providers/judge-model';
import type { UserCaller } from '@kinu.run/core';
import type { ObjectNamespace } from '@kinu.run/core';

type MarkdownConversion = NonNullable<Parameters<typeof buildCfWebSearchProvider>[0]['AI']>['toMarkdown'];

/** The `env.AI` binding. HTML→markdown is optional: without it core keeps raw HTML, and a gateway-only binding stays usable. */
export interface OwnedAiBinding extends WorkersAIBinding {
  toMarkdown?: MarkdownConversion;
}

interface ConvertingAiBinding extends OwnedAiBinding {
  toMarkdown: MarkdownConversion;
}

function convertsHtml(ai: OwnedAiBinding | undefined): ai is ConvertingAiBinding {
  return ai?.toMarkdown !== undefined;
}

export interface OwnedModelEnv<Id> extends ProviderEnv {
  AI?: OwnedAiBinding;
  UserDO: ObjectNamespace<Id, UserCredentialClient>;
}

export interface OwnedModelServicesOptions<Id> {
  readonly env: OwnedModelEnv<Id>;
  /** Lazy: a facet's logical name is set by async `_cf_initAsFacet` after construction. */
  readonly agentName: () => string;
  readonly appTitle: string;
  readonly ownerRequired: boolean;
  readonly getOwnerUserId: () => string | null;
  /** Per call: a facet reads it from its parent, and a workspace has one only once claimed. */
  readonly getUserCaller: () => Promise<UserCaller>;
  /** Lazy and best-effort: an unreachable authority leaves the cache as is rather than failing the turn. */
  readonly getCredentialsRevision: () => Promise<number>;
  /** Invoked at wait time, so the callback may read live turn state. */
  readonly onProviderWait?: (info: ProviderWaitInfo) => void;
}

export class OwnedModelServices<Id = DurableObjectId> {
  private providerRegistryCache: AgentProviderRegistry | null = null;
  private webSearchProviderCache: WebSearchProvider | null = null;
  private judgeSpecCache: { key: string; spec: string } | null = null;
  private modelCache: { spec: string; model: LanguageModel } | null = null;
  /** Revision the listing was swept under; a differing live revision invalidates it without a clock. */
  private cachedCredentialsRevision: number | null = null;
  /** Last complete provider listing; the cache policy is core's `ProviderListingCache`, keyed on `revision`. */
  private readonly providerListings = new ProviderListingCache(
    () => this.sweepProviderListing(),
  );

  constructor(private readonly options: OwnedModelServicesOptions<Id>) {}

  /** Lazy so it reads the facet's logical name at call time. */
  get affinityKey(): string {
    return agentAffinityKey(this.options.agentName());
  }

  providerRegistry(): AgentProviderRegistry {
    if (this.providerRegistryCache) return this.providerRegistryCache;

    const userId = this.options.getOwnerUserId();

    if (!userId && this.options.ownerRequired) {
      throw new Error('Agent has no owner_user_id yet — Worker must call claimOwner before any model use.');
    }

    const userDOStub = userId
      ? this.options.env.UserDO.get(this.options.env.UserDO.idFromName(userId))
      : null;

    this.providerRegistryCache = createAgentProviderRegistry({
      env: this.options.env,
      userDO: userDOStub ? { stub: userDOStub, caller: this.options.getUserCaller } : null,
      appTitle: this.options.appTitle,
      sessionAffinity: this.affinityKey,
      onProviderWait: this.options.onProviderWait,
    });

    return this.providerRegistryCache;
  }

  /** Memoized on the normalized spec: heads ask once per step. `invalidate()` drops it. */
  resolveModel(spec?: string | null): LanguageModel {
    const registry = this.providerRegistry();
    const normalized = registry.normalizeSpecSync(spec);

    if (this.modelCache?.spec === normalized) return this.modelCache.model;
    const model = registry.resolveModel(normalized);
    this.modelCache = { spec: normalized, model };

    return model;
  }

  resolveModelWithEffort(spec: string | null | undefined, effort: ReasoningEffort) {
    const registry = this.providerRegistry();
    const normalized = registry.normalizeSpecSync(spec);

    return {
      model: this.resolveModel(normalized),
      providerOptions: reasoningEffortOptions(effort, parseModelSpec(normalized).provider),
    };
  }

  async profileProviderSnapshot(): Promise<ProviderSnapshotRead> {
    // Durable reconciliation against the account revision: the fan-out can fail silently, this cannot.
    try {
      const revision = await this.options.getCredentialsRevision();

      if (revision !== this.cachedCredentialsRevision) this.invalidate();
      this.cachedCredentialsRevision = revision;
    } catch (cause) {
      // Logged so a possibly stale listing is diagnosable.
      diagnostics.failure('profile.credentials_revision_unreadable', toKinuError({
        doing: 'reading the account credential revision a cached provider listing is measured against',
        cause,
        otherwise: 'unavailable',
      }), { agent: this.options.agentName() });
    }

    const { listing, cache } = await this.providerListings.read();
    const snapshot = buildProviderCatalogSnapshot(listing.models, listing.failures);
    diagnostics.event('profile.provider_snapshot.resolved', {
      cache,
      models: snapshot.availableModels.length,
      unavailable: listing.failures.length,
      revision: snapshot.revision,
    });

    return { snapshot, cache };
  }

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

  /** Judge model per core's selectJudgeModel; cached per (review, chat) pair because the search lists credentials. */
  async resolveJudgeModel(opts: { reviewSpec: string | null; chatSpec: string | null }): Promise<LanguageModel> {
    const registry = this.providerRegistry();
    const key = `${opts.reviewSpec ?? ''}\n${opts.chatSpec ?? ''}`;

    if (this.judgeSpecCache?.key !== key) {
      const { spec } = await resolveReviewingModelSelection({ registry, pinned: opts.reviewSpec, chatSpec: opts.chatSpec });
      this.judgeSpecCache = { key, spec };
    }

    return registry.resolveModel(this.judgeSpecCache.spec);
  }

  /** Key-less by default; a stored `tavily` credential upgrades search. */
  getWebSearchProvider(): WebSearchProvider {
    if (this.webSearchProviderCache) return this.webSearchProviderCache;
    const ai = this.options.env.AI;
    this.webSearchProviderCache = buildCfWebSearchProvider(
      convertsHtml(ai) ? { AI: ai } : {},
      () => this.options.getOwnerUserId() ? this.providerRegistry().deps.getAuth : undefined,
    );

    return this.webSearchProviderCache;
  }

  /** Drop owner-bound provider/auth state; the provider listing's only expiry (in-flight sweep included, per core). */
  invalidate(): void {
    this.providerRegistryCache = null;
    this.judgeSpecCache = null;
    this.modelCache = null;
    this.providerListings.invalidate();
  }
}
