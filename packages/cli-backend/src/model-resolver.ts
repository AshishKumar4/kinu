import { createChatModel, type LLMProviderConfig } from '@proteus/core';
import {
  CODEX_CRED_KEY,
  codexAccessTokenExpiring,
  codexCredentialToHeaders,
  createCodexOAuthClient,
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
import type { OAuthCredential } from '@proteus/core';
import { generateText, streamText } from 'ai';
import type { LanguageModel } from 'ai';
import type { LLM } from '@proteus/core';
import type { LocalCodexAuthStore } from './codex-auth-store.js';

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
  codexOAuth?: OAuthCredential;
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
  codexAuthStore?: LocalCodexAuthStore;
  fetch?: typeof fetch;
  onCodexRefresh?: (credential: OAuthCredential) => void;
}

export function createLocalProviderLLM(opts: LocalModelResolverConfig): LLM {
  const resolver = createLocalModelResolver(opts);
  const maxOutputTokens = opts.llm.maxTokens ?? 2048;
  const model = () => resolver.resolveModel(null);
  return {
    async *stream(input) {
      const result = streamText({
        model: model(),
        system: input.system,
        messages: input.messages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        maxOutputTokens,
      });
      for await (const chunk of result.textStream) yield chunk;
    },
    async complete(prompt) {
      const result = await generateText({
        model: model(),
        prompt,
        maxOutputTokens,
      });
      return result.text.trim();
    },
  };
}

/**
 * Local provider registry for the CLI backend.
 *
 * The DO backend resolves model specs through UserDO-scoped credentials. The
 * CLI has no UserDO, so this adapter supplies the same registry contract from
 * local config/env credentials while preserving the advanced PROTEUS_BASE_URL /
 * PROTEUS_AUTH path as a direct OpenAI-compatible endpoint.
 */
export function createLocalModelResolver(opts: LocalModelResolverConfig): LocalModelResolver {
  const registry = createProviderRegistry();
  const localEndpoint = opts.llm;
  const credentials = opts.credentials ?? {};
  const authStore = buildAuthStore(localEndpoint, credentials, {
    codexAuthStore: opts.codexAuthStore,
    fetch: opts.fetch,
    onCodexRefresh: opts.onCodexRefresh,
  });

  const defaultProvider = defaultProviderFor(localEndpoint);
  if (defaultProvider === 'workers-ai') {
    registry.register(createGatewayBackedProvider({
      id: 'workers-ai',
      label: 'Cloudflare Workers AI (local gateway)',
      defaultModel: localEndpoint.model,
      llm: localEndpoint,
    }));
    registry.register(createGatewayBackedProvider({
      id: 'ai-gateway',
      label: 'Cloudflare AI Gateway (local)',
      defaultModel: localEndpoint.model.startsWith('workers-ai/') ? localEndpoint.model : `workers-ai/${localEndpoint.model}`,
      llm: localEndpoint,
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
      return authStore.get(key, _authOpts);
    },
    async hasCredential(key) {
      return authStore.has(key);
    },
  };

  const fallbackProvider = registry.get(defaultProvider) ? defaultProvider : 'openai-compat';
  const fallbackModel = localEndpoint.model;

  function normalizeSpecSync(specOrNull?: string | null): string {
    const s = (specOrNull ?? '').trim();
    if (!s) return `${fallbackProvider}/${fallbackModel}`;
    if (s.startsWith('@cf/')) return `workers-ai/${s}`;

    const slash = s.indexOf('/');
    if (slash > 0) {
      const first = s.slice(0, slash);
      if (registry.get(first)) return s;
      // Slashful model IDs (for example minimax/m3) are model IDs under the
      // configured local endpoint unless the first path segment is a provider.
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

function defaultProviderFor(llm: LLMProviderConfig): 'workers-ai' | 'codex' | 'openai' | 'anthropic' | 'openrouter' | 'openai-compat' {
  if (llm.name === 'workers-ai' || llm.model.startsWith('@cf/')) return 'workers-ai';
  if (llm.name === 'codex') return 'codex';
  if (llm.name === 'openai') return 'openai';
  if (llm.name === 'anthropic') return 'anthropic';
  if (llm.name === 'openrouter') return 'openrouter';
  return 'openai-compat';
}

function buildAuthStore(
  localEndpoint: LLMProviderConfig,
  credentials: LocalProviderCredentials,
  opts: {
    codexAuthStore?: LocalCodexAuthStore;
    fetch?: typeof fetch;
    onCodexRefresh?: (credential: OAuthCredential) => void;
  } = {},
): {
  has(key: string): boolean;
  get(key: string, authOpts?: { forceRefresh?: boolean }): Promise<AuthResolution | null>;
} {
  const store = new Map<string, AuthResolution>();
  let codexCredential = credentials.codexOAuth;

  if (credentials.openaiApiKey) {
    store.set('openai.bearer', bearer(credentials.openaiApiKey));
  }
  if (!store.has('openai.bearer') && localEndpoint.name === 'openai') {
    const auth = localEndpoint.headers.Authorization ?? localEndpoint.headers.authorization;
    if (auth) store.set('openai.bearer', { headers: { Authorization: auth } });
  }
  if (credentials.anthropicApiKey) {
    store.set('anthropic.bearer', {
      headers: {
        'x-api-key': credentials.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
    });
  }
  if (!store.has('anthropic.bearer') && localEndpoint.name === 'anthropic') {
    const key = localEndpoint.headers['x-api-key'] ?? localEndpoint.headers['X-Api-Key'];
    if (key) {
      store.set('anthropic.bearer', {
        headers: {
          'x-api-key': key,
          'anthropic-version': localEndpoint.headers['anthropic-version'] ?? '2023-06-01',
        },
      });
    }
  }
  if (credentials.openrouterApiKey) {
    store.set('openrouter.bearer', bearer(credentials.openrouterApiKey));
  }
  if (!store.has('openrouter.bearer') && localEndpoint.name === 'openrouter') {
    const auth = localEndpoint.headers.Authorization ?? localEndpoint.headers.authorization;
    if (auth) store.set('openrouter.bearer', { headers: { Authorization: auth } });
  }
  if (localEndpoint.name === 'openai-compat') {
    store.set('openai-compat.default', {
      headers: localEndpoint.headers,
      baseURL: localEndpoint.baseURL,
    });
  }

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

  return {
    has(key: string): boolean {
      if (key === CODEX_CRED_KEY && opts.codexAuthStore) return opts.codexAuthStore.hasCredential();
      if (key === CODEX_CRED_KEY) return Boolean(codexCredential?.accessToken || credentials.codexAccessToken);
      return store.has(key);
    },
    async get(key: string, authOpts?: { forceRefresh?: boolean }): Promise<AuthResolution | null> {
      if (key !== CODEX_CRED_KEY) return store.get(key) ?? null;
      if (opts.codexAuthStore) return opts.codexAuthStore.getAuth(authOpts);
      if (codexCredential?.accessToken) {
        if (codexCredential.refreshToken && (authOpts?.forceRefresh || codexAccessTokenExpiring(codexCredential.accessToken))) {
          const refreshed = await createCodexOAuthClient(opts.fetch).refresh(codexCredential.refreshToken);
          codexCredential = {
            kind: 'oauth',
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
            metadata: codexCredential.metadata,
          };
          opts.onCodexRefresh?.(codexCredential);
        }
        return { headers: codexCredentialToHeaders(codexCredential) };
      }
      if (credentials.codexAccessToken) {
        return {
          headers: codexCredentialToHeaders({
            kind: 'oauth',
            accessToken: credentials.codexAccessToken,
            refreshToken: '',
          }),
        };
      }
      return null;
    },
  };
}

function bearer(token: string): AuthResolution {
  return { headers: { Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}` } };
}
