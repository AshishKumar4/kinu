import type { LanguageModel } from 'ai';
import { agentAffinityKey, type WebSearchProvider } from '@proteus/core';
import { buildCfWebSearchProvider } from './lib/web-provider.js';
import {
  createAgentProviderRegistry,
  type AgentProviderRegistry,
} from './providers/agent-registry.js';
import { resolveJudgeModelSelection } from './providers/judge-model.js';
import type { UserDO } from './user/user-do.js';
import type { UserCaller } from './user/workspace-capability.js';

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
      userDO: userDOStub ? { stub: userDOStub, caller: this.options.getUserCaller } : null,
      appTitle: this.options.appTitle,
      workersAI: { sessionAffinity: this.affinityKey },
    });
    return this.providerRegistryCache;
  }

  resolveModel(spec?: string | null): LanguageModel {
    const registry = this.providerRegistry();
    return registry.resolveModel(registry.normalizeSpecSync(spec));
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
      const { spec } = await resolveJudgeModelSelection({ registry, ...opts });
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

  /** Drop owner-bound provider/auth state; the web provider resolves it per call. */
  invalidate(): void {
    this.providerRegistryCache = null;
    this.judgeSpecCache = null;
  }
}
