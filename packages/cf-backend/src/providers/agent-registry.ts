// Per-agent provider registry composition.
//
// Composes:
//   1. Cloudflare-specific providers from cf-backend/src/providers/
//      (workers-ai + my-gateway via the logged-in user's Cloudflare OAuth
//       credential, ai-gateway env vars)
//   2. Runtime-agnostic providers from @proteus/core
//      (codex, openai, openrouter, openai-compat, anthropic)
//   3. The models.dev dynamic catalog source — any other catalog provider
//      with a stored `<id>.bearer` key resolves through the openai-compat
//      wire path. Static providers stay authoritative for their ids.
//
// Ordering is also the preference order for `defaultSpec()`:
//   workers-ai → my-gateway → ai-gateway → codex → openai → anthropic → openrouter → openai-compat → catalog
//
// Auth flows through the UserDO stub passed in opts.userDOStub — getAuth /
// hasCredential are thin wrappers over its RPCs. No credential material ever
// touches this layer.
import {
  createProviderRegistry, createCodexProvider, createOpenAIProvider,
  createOpenRouterProvider, createOpenAICompatProvider, createAnthropicProvider,
  createModelsDevCatalogSource,
  type ProviderRegistry, type ProviderDeps, type ProviderEnv, type AuthResolver,
} from '@proteus/core';
import type { LanguageModel } from 'ai';
import { createWorkersAIProvider, type WorkersAIOptions } from './workers-ai.js';
import { createMyGatewayProvider } from './my-gateway.js';
import { createAIGatewayProvider } from './ai-gateway.js';
import type { UserDO } from '../user/user-do.js';

export interface AgentProviderDeps {
  env: ProviderEnv;
  /** Stub for the per-user DO that owns this user's credentials. Null is
   *  allowed for short-lived "env-bound providers only" contexts (e.g. the
   *  inline-branch fallback in runtime.ts, where the spawn closure cannot
   *  reach the user's UserDO). In that case getAuth always returns null
 *  and hasCredential always returns false — only env-bound providers end up
 *  usable. */
  userDOStub?: DurableObjectStub<UserDO> | null;
  fetch?: typeof fetch;
  refererURL?: string;
  appTitle?: string;
  workersAI?: WorkersAIOptions;
}

export interface AgentProviderRegistry {
  registry: ProviderRegistry;
  deps: ProviderDeps;
  resolveModel(spec: string): LanguageModel;
  /** Sync — handles BC forms (bare `@cf/...`, bare modelId). */
  normalizeSpecSync(specOrNull?: string | null): string;
  /** Async — like `normalizeSpecSync` but cred-aware (picks the highest-
   *  preference available provider when input is empty). */
  resolveSpec(specOrNull?: string | null): Promise<string>;
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

  // Auth resolver — proxies to UserDO. The DO event loop serializes
  // concurrent refreshes for the same credential, so we don't need to
  // dedupe at this layer. When userDOStub is null (inline-branch context),
  // every lookup returns null so only env-bound providers remain usable.
  const stub = opts.userDOStub ?? null;
  const getAuth: AuthResolver = async (key, opts2) => {
    if (!stub) return null;
    const headers = await stub.getAuthHeaders(key, opts2);
    if (!headers) return null;
    const baseURL = await stub.getCredentialBaseURL(key);
    return baseURL ? { headers, baseURL } : { headers };
  };

  const hasCredential = async (key: string) => {
    if (!stub) return false;
    const list = await stub.listCredentials();
    return list.some((c) => c.key === key);
  };

  const deps: ProviderDeps = {
    env: opts.env,
    getAuth,
    hasCredential,
    listCredentialKeys: async () => {
      if (!stub) return [];
      return (await stub.listCredentials()).map((c) => c.key);
    },
    fetch: opts.fetch,
  };

  // Sync model construction does not mean sync credential access: providers
  // that need user credentials resolve them inside custom fetch wrappers.
  // workers-ai resolves the user's Cloudflare OAuth credential through the
  // UserDO stub — without a stub every request is a guaranteed 401, so the
  // sync default must skip it and fall back to the env-bound ai-gateway.
  function syncDefaultProvider(): string {
    if (stub && registry.get('workers-ai')) return 'workers-ai';
    if (typeof opts.env.AI_GATEWAY_URL === 'string' && opts.env.AI_GATEWAY_URL
     && typeof opts.env.AI_GATEWAY_AUTH === 'string' && opts.env.AI_GATEWAY_AUTH) return 'ai-gateway';
    throw new Error('No sync-resolvable provider available (need a UserDO credential stub for workers-ai, or AI_GATEWAY_URL + AI_GATEWAY_AUTH).');
  }
  function syncDefaultModelId(provider: string): string {
    const fallback = registry.get('workers-ai')?.defaultModel ?? '';
    if (!fallback) throw new Error('workers-ai provider missing defaultModel.');
    if (provider === 'ai-gateway') return `workers-ai/${fallback}`;
    return registry.get(provider)?.defaultModel ?? fallback;
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
        const p = syncDefaultProvider();
        return `${p}/${syncDefaultModelId(p)}`;
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
      // Bare model id — wrap with the sync default provider.
      return `${syncDefaultProvider()}/${s}`;
    },

    async resolveSpec(specOrNull): Promise<string> {
      const s = (specOrNull ?? '').trim();
      if (!s) {
        const def = await registry.defaultSpec(deps);
        if (def) return def;
        const p = syncDefaultProvider();
        return `${p}/${syncDefaultModelId(p)}`;
      }
      if (s.startsWith('@cf/')) return `workers-ai/${s}`;
      if (s.includes('/')) {
        const first = s.slice(0, s.indexOf('/'));
        if (registry.canResolve(first)) return s;
        if (first === 'workers-ai') return s;
        throw new Error(`Unknown provider in model spec ${JSON.stringify(s)}.`);
      }
      const def = await registry.defaultSpec(deps);
      const provider = def ? def.slice(0, def.indexOf('/')) : syncDefaultProvider();
      return `${provider}/${s}`;
    },
  };
}
