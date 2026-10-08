import { Effect } from 'effect';
import type { LanguageModel } from 'ai';
import {
  actorAffinity, parseModelSpec, reasoningEffortOptions,
  providerSnapshotOf, providerListingOf, ProviderListingCache,
  type ModelAffinity, type ProviderListing, type ProviderSnapshotRead, type ReasoningEffort,
  type ProviderWaitInfo,
  type WebSearchProvider,
  type ProviderEnv, type WorkersAIBinding,
} from '@kinu.run/core';
import { diagnostics, recording, settle, settleSync } from '@kinu.run/core/obs';
import { buildCfWebSearchProvider, type BrowserRunQuickActions } from '@kinu.run/core';
import {
  createAgentProviderRegistry,
  type AgentProviderRegistry, type UserCredentialClient,
} from './providers/agent-registry';
import type { ActorReference, ModelCallSink, UserCaller } from '@kinu.run/core';
import type { ObjectNamespace } from '@kinu.run/core';

type MarkdownConversion = NonNullable<Parameters<typeof buildCfWebSearchProvider>[0]['AI']>['toMarkdown'];

/** The `env.AI` binding. HTML→markdown is optional: without it core keeps raw HTML, and a gateway-only binding stays usable. */
interface OwnedAiBinding extends WorkersAIBinding {
  toMarkdown?: MarkdownConversion;
}

export interface OwnedModelEnv<Id> extends ProviderEnv {
  AI?: OwnedAiBinding;
  BROWSER: BrowserRunQuickActions;
  UserDO: ObjectNamespace<Id, UserCredentialClient>;
}

export interface OwnedModelServicesOptions<Id> {
  readonly env: OwnedModelEnv<Id>;
  /** Lazy: a facet's logical name is set by async `_cf_initAsFacet` after construction. */
  readonly agentName: () => string;
  /** The workspace whose conversations share a prompt cache (`actorAffinity`). */
  readonly workspaceId: () => string;
  readonly appTitle: string;
  readonly ownerRequired: boolean;
  readonly getOwnerUserId: () => string | null;
  /** Per call: a facet reads it from its parent, and a workspace has one only once claimed. */
  readonly getUserCaller: () => Promise<UserCaller>;
  /** Lazy and best-effort: an unreachable authority leaves the cache as is rather than failing the turn. */
  readonly getCredentialsRevision: () => Promise<number>;
  /** Invoked at wait time, so the callback may read live turn state. */
  readonly onProviderWait?: (info: ProviderWaitInfo) => void;
  readonly accountFor?: (providerId: string) => string | undefined;
  readonly currentTurn?: (actor: ActorReference) => string | null;
  /** Where the web provider's Workers AI conversions are counted, as `platform` spend. */
  readonly reportModelCall: ModelCallSink;
}

export class OwnedModelServices<Id = DurableObjectId> {
  private providerRegistryCache: AgentProviderRegistry | null = null;
  private webSearchProviderCache: WebSearchProvider | null = null;
  private modelCache: { spec: string; model: LanguageModel } | null = null;
  /** Revision the listing was swept under; a differing live revision invalidates it without a clock. */
  private cachedCredentialsRevision: number | null = null;
  /** Last complete provider listing; the cache policy is core's `ProviderListingCache`, keyed on `revision`. */
  private readonly providerListings = new ProviderListingCache(
    () => this.sweepProviderListing(),
  );

  constructor(private readonly options: OwnedModelServicesOptions<Id>) {}

  /** Lazy so it reads the facet's logical name at call time. */
  get affinity(): ModelAffinity {
    return actorAffinity({ name: this.options.agentName(), workspaceId: this.options.workspaceId() });
  }

  get affinityKey(): string {
    return this.affinity.sessionAffinity;
  }

  providerRegistry(): AgentProviderRegistry {
    return settleSync(Effect.gen({ self: this }, function* () {
      if (this.providerRegistryCache) return this.providerRegistryCache;

      const userId = this.options.getOwnerUserId();

      if (!userId && this.options.ownerRequired) {
        return yield* Effect.die(new Error('Agent has no owner_user_id yet: Worker must call claimOwner before any model use.'));
      }

      const userDOStub = userId
        ? this.options.env.UserDO.get(this.options.env.UserDO.idFromName(userId))
        : null;

      this.providerRegistryCache = createAgentProviderRegistry({
        env: this.options.env,
        userDO: userDOStub ? { stub: userDOStub, caller: this.options.getUserCaller } : null,
        appTitle: this.options.appTitle,
        onProviderWait: this.options.onProviderWait,
        accountFor: this.options.accountFor,
        ...(this.options.currentTurn !== undefined && { currentTurn: this.options.currentTurn }),
      });

      return this.providerRegistryCache;
    }));
  }

  /** Memoized on the normalized spec: heads ask once per step. `invalidate()` drops it. */
  resolveModel(spec: string): LanguageModel {
    const registry = this.providerRegistry();
    const normalized = registry.normalizeSpecSync(spec);

    if (this.modelCache?.spec === normalized) return this.modelCache.model;
    const model = registry.resolveModel(normalized, this.affinity);
    this.modelCache = { spec: normalized, model };

    return model;
  }

  credentialFor(spec: string): Promise<string | null> {
    const agent = this.providerRegistry();

    return agent.registry.credentialFor(agent.normalizeSpecSync(spec), agent.deps);
  }

  resolveModelWithEffort(spec: string, effort: ReasoningEffort | null) {
    const registry = this.providerRegistry();
    const normalized = registry.normalizeSpecSync(spec);
    const { provider } = parseModelSpec(normalized);

    return {
      model: this.resolveModel(normalized),
      provider,
      providerOptions: reasoningEffortOptions(effort, provider),
    };
  }

  profileProviderSnapshot(): Promise<ProviderSnapshotRead> {
    return settle(Effect.gen({ self: this }, function* () {
    // Durable reconciliation against the account revision: the fan-out can fail silently, this cannot.
      yield* Effect.catchCause(Effect.gen({ self: this }, function* () {
        const revision = yield* Effect.promise(() => this.options.getCredentialsRevision());

        if (revision !== this.cachedCredentialsRevision) this.invalidate();
        this.cachedCredentialsRevision = revision;
      }), recording({ doing: 'reading the account credential revision a cached provider listing is measured against', otherwise: 'unavailable' }, (failure) => {
        // Logged so a possibly stale listing is diagnosable.
        diagnostics.failure('profile.credentials_revision_unreadable', failure, { agent: this.options.agentName() });
      }));

      const { listing, cache } = yield* Effect.promise(() => this.providerListings.read());
      const snapshot = providerSnapshotOf(listing);
      diagnostics.event('profile.provider_snapshot.resolved', {
        cache,
        models: snapshot.availableModels.length,
        unavailable: listing.failures.length,
        revision: snapshot.revision,
      });

      return { snapshot, cache };
    }));
  }

  private async sweepProviderListing(): Promise<ProviderListing> {
    const startedAt = Date.now();
    const { registry, deps } = this.providerRegistry();
    const listing = providerListingOf(await registry.listAllModels(deps));

    diagnostics.event('profile.provider_listing.swept', {
      ms: Date.now() - startedAt,
      models: listing.models.length,
      unavailable: listing.failures.length,
    });

    return listing;
  }

  /** Key-less by default; a stored `tavily` credential upgrades search. */
  getWebSearchProvider(): WebSearchProvider {
    if (this.webSearchProviderCache) return this.webSearchProviderCache;
    this.webSearchProviderCache = buildCfWebSearchProvider(
      this.options.env,
      () => this.options.getOwnerUserId() ? this.providerRegistry().deps.getAuth : undefined,
      this.options.reportModelCall,
    );

    return this.webSearchProviderCache;
  }

  /** Drop owner-bound provider/auth state; the provider listing's only expiry (in-flight sweep included, per core). */
  invalidate(): void {
    this.providerRegistryCache = null;
    this.modelCache = null;
    this.providerListings.invalidate();
  }
}
