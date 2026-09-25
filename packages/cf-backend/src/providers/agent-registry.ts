// Per-agent provider registry: Cloudflare providers, core providers, then the models.dev catalog (static ids win).
// Registration order is the model picker's listing order. Auth goes through the UserDO stub.
import {
  createProviderRegistry, createCodexProvider, createOpenAIProvider,
  createOpenRouterProvider, createOpenAICompatProvider, createAnthropicProvider, createClaudeProvider,
  createModelsDevCatalogSource,
  type ProviderRegistry, type ProviderDeps, type ProviderEnv, type AuthResolver,
  type ProviderWaitInfo,
  specProvider,
} from '@kinu.run/core';
import type { LanguageModel } from 'ai';
import { createWorkersAIProvider } from '@kinu.run/core';
import { createMyGatewayProvider } from '@kinu.run/core';
import { AI_GATEWAY_PROVIDER_ID, createAIGatewayProvider, resolvePlatformGateway } from '@kinu.run/core';
import type { CredentialSummary } from '../user/user-do';
import type { UserCaller } from '@kinu.run/core';
import { retryTransientDO } from '@kinu.run/core';
import { codexEgressFetch, type CodexEgressNamespace } from '../egress/codex-egress-route';

/**
 * Credential DO stub paired with the capability this context presents (owner, or workspace token resolved per call),
 * so no context holds the stub without saying who it is.
 */
export interface UserCredentialClient {
  getAuthHeaders(
    caller: UserCaller,
    key: string,
    opts?: { forceRefresh?: boolean },
  ): Promise<Record<string, string> | null>;
  listCredentials(caller: UserCaller): Promise<CredentialSummary[]>;
  getCredentialBaseURL(caller: UserCaller, key: string): Promise<string | null>;
}

export interface UserCredentialSource {
  stub: UserCredentialClient;
  caller: UserCaller | (() => Promise<UserCaller>);
}

/** Taken from the consuming provider: the direct path calls `run`, which a gateway-only env lacks. */
type DirectAiBinding =
  NonNullable<ProviderEnv['AI']> & NonNullable<Parameters<typeof createWorkersAIProvider>[1]>;

function isDirectAiBinding(binding: NonNullable<ProviderEnv['AI']>): binding is DirectAiBinding {
  return 'run' in binding;
}

export interface AgentProviderDeps {
  env: ProviderEnv & { readonly CodexEgress?: CodexEgressNamespace };
  ownerUserId?: string | null;
  /** Null for env-bound-only contexts (e.g. runtime.ts inline-branch fallback): getAuth is null, hasCredential false. */
  userDO?: UserCredentialSource | null;
  fetch?: typeof fetch;
  /** Fires before a provider-mandated wait; the actor emits `provider_wait` so a rate-limited turn reads as waiting. */
  onProviderWait?: (info: ProviderWaitInfo) => void;
  appTitle?: string;
  sessionAffinity?: string;
  accountFor?: (providerId: string) => string | undefined;
}

export interface AgentProviderRegistry {
  registry: ProviderRegistry;
  deps: ProviderDeps;
  resolveModel(spec: string): LanguageModel;
  /** Empty input is the platform default (native Workers AI), never a survey of stored BYO credentials. Also accepts bare `@cf/...` and bare model ids. */
  normalizeSpecSync(specOrNull?: string | null): string;
}

async function resolveCaller(source: UserCredentialSource): Promise<UserCaller> {
  return source.caller instanceof Function ? await source.caller() : source.caller;
}

/** Proxies to UserDO so no credential material touches the caller; the DO serializes concurrent refreshes. Null source: every lookup null. */
export function createUserDOAuthResolver(source: UserCredentialSource | null): AuthResolver {
  return async (key, opts) => {
    if (!source) return null;
    const caller = await resolveCaller(source);

    // Auth resolves before every provider request, so these cross-DO reads are on every step's critical path; both are
    // retry-safe reads (the conditional OAuth refresh persists before returning).
    const headers = await retryTransientDO('credential auth',
      () => source.stub.getAuthHeaders(caller, key, opts));

    if (!headers) return null;

    const baseURL = await retryTransientDO('credential baseURL',
      () => source.stub.getCredentialBaseURL(caller, key));

    return baseURL ? { headers, baseURL } : { headers };
  };
}

export function createAgentProviderRegistry(opts: AgentProviderDeps): AgentProviderRegistry {
  const registry = createProviderRegistry();

  let developmentBinding: DirectAiBinding | undefined;

  if (opts.env.DEV_USER_EMAIL && opts.env.AI && isDirectAiBinding(opts.env.AI)) {
    developmentBinding = opts.env.AI;
  }

  registry.register(createWorkersAIProvider({ sessionAffinity: opts.sessionAffinity }, developmentBinding));
  registry.register(createMyGatewayProvider());
  registry.register(createAIGatewayProvider());

  const codexEgress = opts.env.CodexEgress !== undefined && opts.ownerUserId
    ? codexEgressFetch(opts.env.CodexEgress, opts.ownerUserId)
    : undefined;

  registry.register(createCodexProvider(codexEgress === undefined ? {} : { egress: codexEgress }));
  registry.register(createClaudeProvider());
  registry.register(createOpenAIProvider());
  registry.register(createAnthropicProvider());
  registry.register(createOpenRouterProvider({
    appTitle: opts.appTitle,
  }));
  registry.register(createOpenAICompatProvider());
  // `cloudflare-workers-ai` aliases the bespoke workers-ai provider; excluded so it has one resolution path.
  registry.registerDynamic(createModelsDevCatalogSource({ exclude: ['cloudflare-workers-ai'] }));

  const source = opts.userDO ?? null;
  const getAuth = createUserDOAuthResolver(source);

  const credentialKeys = async (): Promise<string[]> => {
    if (!source) return [];
    const caller = await resolveCaller(source);

    const credentials = await retryTransientDO('credential listing',
      () => source.stub.listCredentials(caller));

    return credentials.map((c) => c.key);
  };

  const deps: ProviderDeps = {
    env: opts.env,
    sessionAffinity: opts.sessionAffinity,
    getAuth,
    hasCredential: async (key: string) => (await credentialKeys()).includes(key),
    listCredentialKeys: credentialKeys,
    fetch: opts.fetch,
    onProviderWait: opts.onProviderWait,
    accountFor: opts.accountFor,
  };

  // Without a UserDO stub, workers-ai is a guaranteed 401, so the default falls back to the env-bound ai-gateway.
  function defaultProvider(): string {
    if (source && registry.get('workers-ai')) return 'workers-ai';
    // Same predicate as the provider's isAvailable(), so the default never names a gateway it would refuse.
    const platform = resolvePlatformGateway(opts.env);

    if (!('reason' in platform)) return AI_GATEWAY_PROVIDER_ID;
    throw new Error(
      'No default provider available (need a UserDO credential stub for workers-ai, '
      + `or a usable platform gateway — ${platform.reason})`,
    );
  }

  function defaultModelIdFor(provider: string): string {
    const native = registry.get('workers-ai')?.defaultModel ?? '';

    if (!native) throw new Error('workers-ai provider missing defaultModel.');

    if (provider === AI_GATEWAY_PROVIDER_ID) return `workers-ai/${native}`;

    return registry.get(provider)?.defaultModel ?? native;
  }

  return {
    registry,
    deps,

    resolveModel(spec): LanguageModel {
      return registry.resolve(spec, deps);
    },

    normalizeSpecSync(specOrNull): string {
      const s = (specOrNull ?? '').trim();

      if (!s) {
        const provider = defaultProvider();

        return `${provider}/${defaultModelIdFor(provider)}`;
      }

      if (s.startsWith('@cf/')) return `workers-ai/${s}`;

      if (s.includes('/')) {
        const first = specProvider(s) ?? '';

        // Optimistic for catalog-shaped ids: the catalog cannot be consulted synchronously; typos surface at request time.
        if (registry.canResolve(first)) return s;

        if (first === 'workers-ai') return s;
        throw new Error(`Unknown provider in model spec ${JSON.stringify(s)}.`);
      }

      return `${defaultProvider()}/${s}`;
    },
  };
}
