// Per-agent provider registry composition.
//
// Composes:
//   1. Cloudflare-specific providers from cf-backend/src/providers/
//      (workers-ai env.AI binding, ai-gateway env vars)
//   2. Runtime-agnostic providers from @proteus/core
//      (codex, openai, openrouter, openai-compat)
//
// Ordering is also the preference order for `defaultSpec()`:
//   workers-ai → ai-gateway → codex → openai → openrouter → openai-compat
//
// Codex OAuth refresh is wired here (the registry instance carries the
// OAuthRefresher closure).
import {
  createProviderRegistry, createCodexProvider, createOpenAIProvider,
  createOpenRouterProvider, createOpenAICompatProvider, createAnthropicProvider,
  type ProviderRegistry, type ProviderDeps, type ProviderEnv, type CredentialStore,
} from '@proteus/core';
import type { LanguageModel } from 'ai';
import { createWorkersAIProvider, type WorkersAIOptions } from './workers-ai.js';
import { createAIGatewayProvider } from './ai-gateway.js';
import { createCodexOAuthClient } from '../auth/codex-oauth.js';

export interface AgentProviderDeps {
  env: ProviderEnv;
  credentials: CredentialStore;
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
  const oauth = createCodexOAuthClient(opts.fetch);
  const registry = createProviderRegistry();

  registry.register(createWorkersAIProvider(opts.workersAI));
  registry.register(createAIGatewayProvider());
  registry.register(createCodexProvider({ refresh: oauth.refresh.bind(oauth) }));
  registry.register(createOpenAIProvider());
  registry.register(createAnthropicProvider());
  registry.register(createOpenRouterProvider({
    refererURL: opts.refererURL,
    appTitle: opts.appTitle,
  }));
  registry.register(createOpenAICompatProvider());

  const deps: ProviderDeps = {
    env: opts.env,
    credentials: opts.credentials,
    fetch: opts.fetch,
  };

  // Sync-resolvable provider = needs no credential read to construct.
  // workers-ai (env.AI binding) and ai-gateway (env vars) qualify.
  function syncDefaultProvider(): string {
    if (opts.env.AI && typeof opts.env.AI !== 'string') return 'workers-ai';
    if (typeof opts.env.AI_GATEWAY_URL === 'string' && opts.env.AI_GATEWAY_URL
     && typeof opts.env.AI_GATEWAY_AUTH === 'string' && opts.env.AI_GATEWAY_AUTH) return 'ai-gateway';
    throw new Error('No sync-resolvable provider (need env.AI or AI_GATEWAY_AUTH).');
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
