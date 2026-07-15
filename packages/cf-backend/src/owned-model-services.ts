import type { LanguageModel } from 'ai';
import { agentAffinityKey, type WebSearchProvider } from '@proteus/core';
import { buildCfWebSearchProvider } from './lib/web-provider.js';
import {
  createAgentProviderRegistry,
  type AgentProviderRegistry,
} from './providers/agent-registry.js';
import type { UserDO } from './user/user-do.js';

export interface OwnedModelServicesOptions {
  readonly env: Env;
  /** Resolved lazily: a facet's logical name is only set by the async
   *  _cf_initAsFacet after construction, so this must not be read eagerly. */
  readonly agentName: () => string;
  readonly appTitle: string;
  readonly ownerRequired: boolean;
  readonly getOwnerUserId: () => string | null;
}

/** Owner-scoped provider, model, affinity, and web services shared by CF agents. */
export class OwnedModelServices {
  private providerRegistryCache: AgentProviderRegistry | null = null;
  private webSearchProviderCache: WebSearchProvider | null = null;

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
    const userDOStub = userId
      ? this.options.env.UserDO.get(this.options.env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>
      : null;

    this.providerRegistryCache = createAgentProviderRegistry({
      env: this.options.env,
      userDOStub,
      appTitle: this.options.appTitle,
      workersAI: { sessionAffinity: this.affinityKey },
    });
    return this.providerRegistryCache;
  }

  resolveModel(spec?: string | null): LanguageModel {
    const registry = this.providerRegistry();
    return registry.resolveModel(registry.normalizeSpecSync(spec));
  }

  getWebSearchProvider(): WebSearchProvider {
    if (this.webSearchProviderCache) return this.webSearchProviderCache;
    this.webSearchProviderCache = buildCfWebSearchProvider(
      this.options.env,
      () => this.options.getOwnerUserId() ? this.providerRegistry().deps.getAuth : undefined,
    );
    return this.webSearchProviderCache;
  }

  /** Drop owner-bound provider/auth state; the web provider resolves it per call. */
  invalidate(): void {
    this.providerRegistryCache = null;
  }
}
