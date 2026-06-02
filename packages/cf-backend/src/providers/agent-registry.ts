// Per-agent provider registry composition.
//
// Composes:
//   1. Cloudflare-specific providers from cf-backend/src/providers/
//      (workers-ai env.AI binding, ai-gateway env vars)
//   2. Runtime-agnostic providers from @proteus/core
//      (codex, openai, openrouter, openai-compat, anthropic)
//
// Ordering is also the preference order for `defaultSpec()`:
//   ai-gateway → workers-ai → codex → openai → anthropic → openrouter → openai-compat
// ai-gateway is first so the default model is MiniMax M3 (via the gateway's
// unified /compat endpoint); workers-ai (the free env.AI binding, Kimi) is the
// fallback when the gateway isn't configured.
//
// Auth flows through the UserDO stub passed in opts.userDOStub — getAuth /
// hasCredential are thin wrappers over its RPCs. No credential material ever
// touches this layer.
import {
  createProviderRegistry, createCodexProvider, createOpenAIProvider,
  createOpenRouterProvider, createOpenAICompatProvider, createAnthropicProvider,
  type ProviderRegistry, type ProviderDeps, type ProviderEnv, type AuthResolver,
} from '@proteus/core';
import type { LanguageModel } from 'ai';
import { createWorkersAIProvider, type WorkersAIOptions } from './workers-ai.js';
import { createAIGatewayProvider } from './ai-gateway.js';
import type { UserDO } from '../user/user-do.js';

export interface AgentProviderDeps {
  env: ProviderEnv;
  /** Stub for the per-user DO that owns this user's credentials. Null is
   *  allowed for short-lived "env-bound providers only" contexts (e.g. the
   *  inline-branch fallback in runtime.ts, where the spawn closure cannot
   *  reach the user's UserDO). In that case getAuth always returns null
   *  and hasCredential always returns false — only workers-ai / ai-gateway
   *  end up usable. */
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

  // ai-gateway first → its defaultModel (MiniMax M3) is the registry default;
  // workers-ai (env.AI binding, Kimi) is the free fallback.
  registry.register(createAIGatewayProvider());
  registry.register(createWorkersAIProvider(opts.workersAI));
  registry.register(createCodexProvider());
  registry.register(createOpenAIProvider());
  registry.register(createAnthropicProvider());
  registry.register(createOpenRouterProvider({
    refererURL: opts.refererURL,
    appTitle: opts.appTitle,
  }));
  registry.register(createOpenAICompatProvider());

  // Auth resolver — proxies to UserDO. The DO event loop serializes
  // concurrent refreshes for the same credential, so we don't need to
  // dedupe at this layer. When userDOStub is null (inline-branch context),
  // every lookup returns null so only env-bound providers remain usable.
  const stub = opts.userDOStub ?? null;
  const getAuth: AuthResolver = async (key, opts2) => {
    if (!stub) return null;
    const headers = await stub.getAuthHeaders(key, opts2);
    if (!headers) return null;
    if (key.startsWith('openai-compat.')) {
      const baseURL = await stub.getCredentialBaseURL(key);
      if (!baseURL) return null;
      return { headers, baseURL };
    }
    return { headers };
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
    fetch: opts.fetch,
  };

  // Sync-resolvable provider = needs no credential read to construct.
  // ai-gateway (env vars → MiniMax M3) is preferred; workers-ai (env.AI binding
  // → Kimi) is the free fallback when the gateway isn't configured.
  function syncDefaultProvider(): string {
    if (typeof opts.env.AI_GATEWAY_URL === 'string' && opts.env.AI_GATEWAY_URL
     && typeof opts.env.AI_GATEWAY_AUTH === 'string' && opts.env.AI_GATEWAY_AUTH) return 'ai-gateway';
    if (opts.env.AI && typeof opts.env.AI !== 'string') return 'workers-ai';
    throw new Error('No sync-resolvable provider (need AI_GATEWAY_AUTH or env.AI).');
  }
  function syncDefaultModelId(provider: string): string {
    const own = registry.get(provider)?.defaultModel;
    if (own) return own;
    const fallback = registry.get('workers-ai')?.defaultModel ?? '';
    if (!fallback) throw new Error('workers-ai provider missing defaultModel.');
    return fallback;
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
        if (registry.get(first)) return s;
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
        if (registry.get(first)) return s;
        if (first === 'workers-ai') return s;
        throw new Error(`Unknown provider in model spec ${JSON.stringify(s)}.`);
      }
      const def = await registry.defaultSpec(deps);
      const provider = def ? def.slice(0, def.indexOf('/')) : syncDefaultProvider();
      return `${provider}/${s}`;
    },
  };
}
