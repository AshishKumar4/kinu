// Per-agent provider registry composition.
//
// Composes:
//   1. Cloudflare-specific providers from cf-backend/src/providers/
//      (workers-ai + my-gateway via the logged-in user's Cloudflare OAuth
//       credential, ai-gateway env vars)
//   2. Runtime-agnostic providers from @kinu.run/core
//      (codex, openai, openrouter, openai-compat, anthropic)
//   3. The models.dev dynamic catalog source — any other catalog provider
//      with a stored `<id>.bearer` key resolves through the openai-compat
//      wire path. Static providers stay authoritative for their ids.
//
// Registration order is the listing order the model picker shows.
//
// Auth flows through the UserDO stub passed in opts.userDO — getAuth /
// hasCredential are thin wrappers over its RPCs. No credential material ever
// touches this layer.
import {
  createProviderRegistry, createCodexProvider, createOpenAIProvider,
  createOpenRouterProvider, createOpenAICompatProvider, createAnthropicProvider,
  createModelsDevCatalogSource,
  type ProviderRegistry, type ProviderDeps, type ProviderEnv, type AuthResolver,
} from '@kinu.run/core';
import type { LanguageModel } from 'ai';
import { createWorkersAIProvider, type WorkersAIOptions } from './workers-ai';
import { createMyGatewayProvider } from './my-gateway';
import { AI_GATEWAY_PROVIDER_ID, createAIGatewayProvider, resolvePlatformGateway } from './ai-gateway';
import type { CredentialSummary } from '../user/user-do';
import type { UserCaller } from '../user/workspace-capability';
import { retryTransientDO } from '../lib/do-rpc';

/** Stub for the per-user DO that owns this user's credentials, paired with the
 *  identity this context presents to it — a Worker route acting for the
 *  signed-in owner presents the owner capability, an agent passes its workspace
 *  capability token (resolved per call, since a facet reads it from its
 *  parent). The two travel together so no context can hold the stub without
 *  saying who it is. */
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

export interface AgentProviderDeps {
  env: ProviderEnv;
  /** Null/absent is allowed for short-lived "env-bound providers only" contexts
   *  (e.g. the inline-branch fallback in runtime.ts, where the spawn closure
   *  cannot reach the user's UserDO). In that case getAuth always returns null
   *  and hasCredential always returns false — only env-bound providers end up
   *  usable. */
  userDO?: UserCredentialSource | null;
  fetch?: typeof fetch;
  refererURL?: string;
  appTitle?: string;
  workersAI?: WorkersAIOptions;
}

export interface AgentProviderRegistry {
  registry: ProviderRegistry;
  deps: ProviderDeps;
  resolveModel(spec: string): LanguageModel;
  /** The one spec resolver. Empty input is the platform default, never a
   *  survey of which BYO credential happens to be stored: the native Workers
   *  AI model is what a user who has chosen nothing runs on. Also handles the
   *  BC forms (bare `@cf/...`, bare modelId). */
  normalizeSpecSync(specOrNull?: string | null): string;
}

async function resolveCaller(source: UserCredentialSource): Promise<UserCaller> {
  return source.caller instanceof Function ? await source.caller() : source.caller;
}

/** Auth resolver proxying to UserDO — getAuth is a thin wrapper over its
 *  RPCs, so no credential material ever touches the caller's layer. The DO
 *  event loop serializes concurrent refreshes for the same credential. With no
 *  source (inline-branch context) every lookup returns null, leaving only
 *  env-bound providers usable. Shared by the registry below and the
 *  /api/user/ai/v1 proxy. */
export function createUserDOAuthResolver(source: UserCredentialSource | null): AuthResolver {
  return async (key, opts) => {
    if (!source) return null;
    const caller = await resolveCaller(source);
    // Auth is re-resolved before EVERY request to a provider (providers/util.ts
    // createAuthedFetch), which puts these two cross-DO reads on the critical
    // path of every model step of every turn: one dropped connection ended the
    // turn with an error card the user had to retry by hand. Both are reads —
    // the conditional OAuth refresh inside getAuthHeaders persists before it
    // returns, so a retry either sees the refreshed credential and does nothing,
    // or re-runs a refresh that never happened.
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

  registry.register(createWorkersAIProvider(opts.workersAI));
  registry.register(createMyGatewayProvider());
  registry.register(createAIGatewayProvider());
  registry.register(createCodexProvider());
  registry.register(createOpenAIProvider());
  registry.register(createAnthropicProvider());
  registry.register(createOpenRouterProvider({
    refererURL: opts.refererURL,
    appTitle: opts.appTitle,
  }));
  registry.register(createOpenAICompatProvider());
  // models.dev id `cloudflare-workers-ai` aliases the bespoke workers-ai
  // provider (and its endpoint needs an account-id template anyway) — exclude
  // it so workers-ai never grows a second resolution path.
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
    getAuth,
    hasCredential: async (key: string) => (await credentialKeys()).includes(key),
    listCredentialKeys: credentialKeys,
    fetch: opts.fetch,
  };

  // Model construction is sync, but credential access is not: providers that
  // need user credentials resolve them inside custom fetch wrappers. workers-ai
  // resolves the user's Cloudflare OAuth credential through the UserDO stub —
  // without a stub every request is a guaranteed 401, so the default falls back
  // to the env-bound ai-gateway, which serves the same native model.
  function defaultProvider(): string {
    if (source && registry.get('workers-ai')) return 'workers-ai';
    // Same predicate the provider's own isAvailable() uses, so the default can
    // never name a gateway the provider would refuse to build a model for.
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
        const first = s.slice(0, s.indexOf('/'));
        // canResolve is optimistic for catalog-shaped ids — a typo'd provider
        // surfaces a clear models.dev error at request time instead of here
        // (the catalog cannot be consulted synchronously).
        if (registry.canResolve(first)) return s;
        if (first === 'workers-ai') return s;   // canonical form pre-existed
        throw new Error(`Unknown provider in model spec ${JSON.stringify(s)}.`);
      }
      // Bare model id — wrap with the default provider.
      return `${defaultProvider()}/${s}`;
    },
  };
}
