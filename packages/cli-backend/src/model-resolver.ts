import { createChatModel, type LLMProviderConfig } from '@proteus/core';
import {
  createAnthropicProvider,
  createCodexProvider,
  createOpenAICompatProvider,
  createOpenAIProvider,
  createOpenRouterProvider,
  createProviderRegistry,
  type AuthResolution,
  type ModelInfo,
  type ModelProvider,
  type ProviderDeps,
  type ProviderInfo,
  type ProviderRegistry,
} from '@proteus/core';
import type { LanguageModel } from 'ai';

export interface LocalOpenAICompatCredential {
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  extraHeaders?: Record<string, string>;
}

export interface LocalProviderCredentials {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  openrouterApiKey?: string;
  codexAccessToken?: string;
  openaiCompat?: Record<string, LocalOpenAICompatCredential>;
}

export interface LocalModelResolver {
  normalizeSpecSync(specOrNull?: string | null): string;
  resolveModel(specOrNull?: string | null): LanguageModel;
  listProviders(): Promise<ProviderInfo[]>;
  listModels(): Promise<Array<ModelInfo & { provider: string }>>;
}

export interface LocalModelResolverConfig {
  llm: LLMProviderConfig;
  credentials?: LocalProviderCredentials;
  fetch?: typeof fetch;
}

/**
 * Local provider registry for the CLI backend.
 *
 * The DO backend resolves model specs through UserDO-scoped credentials. The
 * CLI has no UserDO, so this adapter supplies the same registry contract from
 * local config/env credentials while preserving the legacy PROTEUS_BASE_URL /
 * PROTEUS_AUTH path as an OpenAI-compatible endpoint.
 */
export function createLocalModelResolver(opts: LocalModelResolverConfig): LocalModelResolver {
  const registry = createProviderRegistry();
  const legacy = opts.llm;
  const credentials = opts.credentials ?? {};
  const authStore = buildAuthStore(legacy, credentials);

  const defaultProvider = defaultProviderFor(legacy);
  if (defaultProvider === 'workers-ai') {
    registry.register(createGatewayBackedProvider({
      id: 'workers-ai',
      label: 'Cloudflare Workers AI (local gateway)',
      defaultModel: legacy.model,
      llm: legacy,
    }));
    registry.register(createGatewayBackedProvider({
      id: 'ai-gateway',
      label: 'Cloudflare AI Gateway (local)',
      defaultModel: legacy.model.startsWith('workers-ai/') ? legacy.model : `workers-ai/${legacy.model}`,
      llm: legacy,
    }));
  }

  registry.register(createCodexProvider());
  registry.register(createOpenAIProvider());
  registry.register(createAnthropicProvider());
  registry.register(createOpenRouterProvider({ appTitle: 'Proteus CLI' }));
  registry.register(createOpenAICompatProvider());

  for (const name of Object.keys(credentials.openaiCompat ?? {}).sort()) {
    if (name !== 'default') registry.register(createOpenAICompatProvider(`openai-compat:${name}`));
  }

  const deps: ProviderDeps = {
    env: {},
    fetch: opts.fetch,
    async getAuth(key, _authOpts) {
      return authStore.get(key) ?? null;
    },
    async hasCredential(key) {
      return authStore.has(key);
    },
  };

  const fallbackProvider = registry.get(defaultProvider) ? defaultProvider : 'openai-compat';
  const fallbackModel = fallbackProvider === 'workers-ai' ? legacy.model : legacy.model;

  function normalizeSpecSync(specOrNull?: string | null): string {
    const s = (specOrNull ?? '').trim();
    if (!s) return `${fallbackProvider}/${fallbackModel}`;
    if (s.startsWith('@cf/')) return `workers-ai/${s}`;

    const slash = s.indexOf('/');
    if (slash > 0) {
      const first = s.slice(0, slash);
      if (registry.get(first)) return s;
      // Preserve legacy behavior: slashful model IDs (for example minimax/m3)
      // are model IDs under the configured local endpoint, not necessarily
      // provider prefixes.
      return `${fallbackProvider}/${s}`;
    }

    return `${fallbackProvider}/${s}`;
  }

  return {
    normalizeSpecSync,
    resolveModel(specOrNull) {
      return registry.resolve(normalizeSpecSync(specOrNull), deps);
    },
    listProviders() {
      return registry.listProviders(deps);
    },
    listModels() {
      return registry.listAllModels(deps);
    },
  };
}

function createGatewayBackedProvider(opts: {
  id: string;
  label: string;
  defaultModel: string;
  llm: LLMProviderConfig;
}): ModelProvider {
  return {
    id: opts.id,
    label: opts.label,
    defaultModel: opts.defaultModel,
    isAvailable: () => !!opts.llm.baseURL && Object.keys(opts.llm.headers).length > 0,
    unavailableReason: () => 'PROTEUS_BASE_URL and PROTEUS_AUTH are required for the local gateway provider.',
    listModels: () => [
      { id: opts.defaultModel, label: opts.defaultModel, capabilities: ['tools', 'streaming'] },
    ],
    createModel(modelId): LanguageModel {
      return createChatModel({
        kind: 'openai-compat',
        name: opts.id,
        baseURL: opts.llm.baseURL,
        headers: opts.llm.headers,
        modelId,
      });
    },
  };
}

function defaultProviderFor(llm: LLMProviderConfig): 'workers-ai' | 'openai-compat' {
  if (llm.name === 'workers-ai' || llm.model.startsWith('@cf/')) return 'workers-ai';
  return 'openai-compat';
}

function buildAuthStore(
  legacy: LLMProviderConfig,
  credentials: LocalProviderCredentials,
): Map<string, AuthResolution> {
  const store = new Map<string, AuthResolution>();

  if (credentials.openaiApiKey) {
    store.set('openai.bearer', bearer(credentials.openaiApiKey));
  }
  if (credentials.anthropicApiKey) {
    store.set('anthropic.bearer', {
      headers: {
        'x-api-key': credentials.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
    });
  }
  if (credentials.openrouterApiKey) {
    store.set('openrouter.bearer', bearer(credentials.openrouterApiKey));
  }
  if (credentials.codexAccessToken) {
    store.set('codex.oauth', bearer(credentials.codexAccessToken));
  }

  store.set('openai-compat.default', {
    headers: legacy.headers,
    baseURL: legacy.baseURL,
  });

  for (const [name, compat] of Object.entries(credentials.openaiCompat ?? {})) {
    const headers = {
      ...(compat.headers ?? {}),
      ...(compat.apiKey ? { Authorization: `Bearer ${compat.apiKey}` } : {}),
      ...(compat.extraHeaders ?? {}),
    };
    store.set(`openai-compat.${name}`, {
      headers,
      baseURL: compat.baseURL,
    });
  }

  return store;
}

function bearer(token: string): AuthResolution {
  return { headers: { Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}` } };
}
