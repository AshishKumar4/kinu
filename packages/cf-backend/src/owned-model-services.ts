import type { ModelAttemptIdentity } from '@kinu.run/core';
import { Effect } from 'effect';
import type { LanguageModel } from 'ai';
import {
  actorAffinity, parseModelSpec, reasoningEffortOptions,
  providerSnapshotOf, providerListingKey, providerListingOf, ProviderListingCache,
  type ModelAffinity, type ProviderListing, type StoredProviderListing, type ProviderSnapshotRead, type ReasoningEffort,
  type ModelAttemptInfo, type ProviderWaitInfo, type ProviderAccounts, objectNamed,
  type WebSearchProvider, type WebSearchChain,
  type ProviderEnv, type WorkersAIBinding,
} from '@kinu.run/core';
import { diagnostics, recording, settle, settleSync } from '@kinu.run/core/obs';
import { buildCfWebSearchProvider, type BrowserRunQuickActions } from '@kinu.run/core';
import {
  createAgentProviderRegistry,
  userCredentials,
  type AgentProviderRegistry, type UserCredentialClient, type UserCredentialSource,
} from './providers/agent-registry';
import type { ActorReference, ModelCallSink, UserCaller } from '@kinu.run/core';
import type { LabelSignerEnv, ObjectNamespace, PreviewSuffixEnv } from '@kinu.run/core';
import { selfPreviewPass } from './viewer-pass';

type MarkdownConversion = NonNullable<Parameters<typeof buildCfWebSearchProvider>[0]['AI']>['toMarkdown'];

/** The `env.AI` binding. HTML→markdown is optional: without it core keeps raw HTML, and a gateway-only binding stays usable. */
interface OwnedAiBinding extends WorkersAIBinding {
  toMarkdown?: MarkdownConversion;
}

export interface OwnedModelEnv<Id> extends ProviderEnv, PreviewSuffixEnv, LabelSignerEnv {
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
  /** The workspace's name, which its previews' hosts carry. */
  readonly workspaceName: () => string;
  readonly appTitle: string;
  readonly ownerRequired: boolean;
  readonly getOwnerUserId: () => string | null;
  /** Per call: a facet reads it from its parent, and a workspace has one only once claimed. */
  readonly getUserCaller: () => Promise<UserCaller>;
  /** Lazy and best-effort: an unreachable authority leaves the cache as is rather than failing the turn. */
  readonly getCredentialsRevision: () => Promise<number>;
  /** Invoked at wait time, so the callback may read live turn state. */
  readonly onProviderWait?: (info: ProviderWaitInfo) => void;
  /** Invoked as each request ends, likewise. */
  readonly onModelAttempt?: (info: ModelAttemptInfo) => void;
  /** Each provider's chosen account, as one map: what the registry lists and calls each provider with. */
  readonly accounts?: () => Readonly<Record<string, string>>;
  /** Where a complete listing is kept past this object's life, and how its sweep runs off a turn's path; absent: every
   *  object sweeps for itself. */
  readonly storedListing?: {
    readonly read: (accounts: string) => Promise<ProviderListing | null>;
    readonly keep: (revision: number, accounts: string, listing: ProviderListing) => Promise<void>;
    readonly detach: (work: Effect.Effect<void>) => void;
  };
  readonly currentTurn?: (actor: ActorReference) => string | null;
  /** Where the web provider's Workers AI conversions and searches are counted. */
  readonly reportModelCall: ModelCallSink;
  /** The owner's search chain, read per search from their profile catalog. */
  readonly webSearchChain: () => Promise<WebSearchChain>;
}

/** What a caller of the owner's providers names for itself: its own way to the owner's credentials (null: none), the
 *  title its calls carry, each provider's account it chose, and where its provider's waits and attempts are told (absent:
 *  where the services' own are). */
export interface ProvidersLane {
  readonly credentials: UserCredentialSource | null;
  readonly appTitle: string;
  readonly accounts: (() => ProviderAccounts) | undefined;
  readonly told?: Pick<OwnedModelServicesOptions<unknown>, 'onProviderWait' | 'onModelAttempt'>;
}

export class OwnedModelServices<Id = DurableObjectId> {
  private providerRegistryCache: AgentProviderRegistry | null = null;
  private webSearchProviderCache: WebSearchProvider | null = null;

  private viewerWebSearchProviderCache: WebSearchProvider | null = null;
  private modelCache: { spec: string; model: LanguageModel } | null = null;
  /** Revision the listing was swept under; a differing live revision invalidates it without a clock. */
  private cachedCredentialsRevision: number | null = null;
  /** Last complete provider listing; the cache policy is core's `ProviderListingCache`, keyed on `revision`. */
  private readonly providerListings: ProviderListingCache;

  constructor(private readonly options: OwnedModelServicesOptions<Id>) {
    this.providerListings = new ProviderListingCache(() => this.sweepProviderListing(), this.storedListings());
  }

  /** The canonical {provider: account} this object lists under: the key a kept listing is served on. */
  private accountsKey(): string {
    return providerListingKey(null, this.options.accounts?.() ?? {});
  }

  /** The account's store, keyed on the credentials' revision this object read last and the accounts it lists under. */
  private storedListings(): StoredProviderListing | undefined {
    const stored = this.options.storedListing;

    if (stored === undefined) return undefined;

    return {
      read: () => stored.read(this.accountsKey()),
      keeper: () => {
        const revision = this.cachedCredentialsRevision;
        const accounts = this.accountsKey();

        return async (listing) => {
          if (revision !== null) await stored.keep(revision, accounts, listing);
        };
      },
      detach: stored.detach,
    };
  }

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

      const { env, getUserCaller } = this.options;

      this.providerRegistryCache = this.registryOver({
        credentials: userId ? userCredentials(() => objectNamed(env.UserDO, userId), getUserCaller) : null,
        appTitle: this.options.appTitle,
        accounts: this.options.accounts,
      });

      return this.providerRegistryCache;
    }));
  }

  /**
   * The owner's providers as `lane` calls them, their waits and attempts told where this object's are. Built anew, so a
   * provider the account connected since is in it; {@link providerRegistry} keeps one, under this object's own lane.
   */
  registryOver(lane: ProvidersLane): AgentProviderRegistry {
    const told = lane.told ?? this.options;

    return createAgentProviderRegistry({
      env: this.options.env,
      userDO: lane.credentials,
      appTitle: lane.appTitle,
      onProviderWait: told.onProviderWait,
      onModelAttempt: told.onModelAttempt,
      accountFor: (provider) => lane.accounts?.()[provider],
      ...(this.options.currentTurn !== undefined && { currentTurn: this.options.currentTurn }),
    });
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

  attemptFor(spec: string): Promise<ModelAttemptIdentity | null> {
    const agent = this.providerRegistry();

    return agent.registry.attemptFor(agent.normalizeSpecSync(spec), agent.deps);
  }

  resolveModelWithEffort(spec: string, effort: ReasoningEffort | null) {
    const registry = this.providerRegistry();
    const normalized = registry.normalizeSpecSync(spec);
    const { provider } = parseModelSpec(normalized);

    return {
      model: this.resolveModel(normalized),
      provider,
      providerOptions: reasoningEffortOptions(effort, normalized),
    };
  }

  profileProviderSnapshot(): Promise<ProviderSnapshotRead> {
    return settle(Effect.gen({ self: this }, function* () {
    // Durable reconciliation against the account revision: the fan-out can fail silently, this cannot.
      yield* Effect.catchCause(Effect.gen({ self: this }, function* () {
        const revision = yield* Effect.promise(() => this.options.getCredentialsRevision());

        // A new revision is new credentials: the registry's cached refreshers go with the listing.
        if (revision !== this.cachedCredentialsRevision) this.invalidate();
        this.cachedCredentialsRevision = revision;
      }), recording({ doing: 'reading the account credential revision a cached provider listing is measured against', otherwise: 'unavailable' }, (failure) => {
        // Logged so a possibly stale listing is diagnosable.
        diagnostics.failure('profile.credentials_revision_unreadable', failure, { agent: this.options.agentName() });
      }));

      const { listing, cache } = yield* Effect.promise(() => this.providerListings.read(providerListingKey(this.cachedCredentialsRevision, this.options.accounts?.() ?? {})));
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

  /** The owner's keys, Cloudflare login and chain, read per search. */
  private searchingOwner() {
    return {
      auth: () => (this.options.getOwnerUserId() ? this.providerRegistry().deps.getAuth : undefined),
      chain: this.options.webSearchChain,
    };
  }

  /** Searches along the owner's chain, with their keys and Cloudflare login. */
  getWebSearchProvider(): WebSearchProvider {
    if (this.webSearchProviderCache) return this.webSearchProviderCache;
    this.webSearchProviderCache = buildCfWebSearchProvider(
      this.options.env,
      this.searchingOwner(),
      this.options.reportModelCall,
      (url) => selfPreviewPass(this.options.env, this.options.workspaceName(), url),
    );

    return this.webSearchProviderCache;
  }

  /** The same web for a share's viewer, whose calls carry no pass to the workspace's own previews. */
  getViewerWebSearchProvider(): WebSearchProvider {
    this.viewerWebSearchProviderCache ??= buildCfWebSearchProvider(
      this.options.env,
      this.searchingOwner(),
      this.options.reportModelCall,
    );

    return this.viewerWebSearchProviderCache;
  }

  /** Drop owner-bound provider/auth state; the provider listing's only expiry (in-flight sweep included, per core). */
  invalidate(): void {
    this.providerRegistryCache = null;
    this.modelCache = null;
    this.providerListings.invalidate();
  }
}
