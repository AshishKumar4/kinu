import { createChatModel, type LLMProviderConfig } from '@proteus/core';
import {
  CODEX_CRED_KEY,
  DEFAULT_WORKERS_AI_MODEL_ID,
  MODEL_CAPABILITIES,
  codexAccessTokenExpiring,
  codexCredentialToHeaders,
  createCodexOAuthClient,
  createAnthropicProvider,
  createCodexProvider,
  availableJudgeSpecs,
  catalogModelInfo,
  createOpenAICompatProvider,
  createOpenAIProvider,
  createOpenRouterProvider,
  createProviderRegistry,
  listModelsDevProviderModels,
  parseModelSpec,
  reasoningEffortOptions,
  type AuthResolution,
  type AuthResolver,
  type ModelCapability,
  type ModelInfo,
  type ModelMenu,
  type ModelProvider,
  type ProviderDeps,
  type ProviderInfo,
  type ProviderRegistry,
} from '@proteus/core';
import type { OAuthCredential } from '@proteus/core';
import { generateText, streamText } from 'ai';
import type { LanguageModel } from 'ai';
import type { LLM } from '@proteus/core';
import { createClaudeCliProvider, type ClaudeCliProviderOptions } from './claude-cli-provider.js';
import { createOpenCodeProvider, type OpenCodeProviderOptions } from './opencode-provider.js';
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

/** The signed-in Proteus session — lets local agents run on the user's
 *  Cloudflare AI (Workers AI + their AI Gateway) through the worker's
 *  /api/user/ai/v1 proxy, with no Cloudflare token on this machine. */
export interface LocalCloudSession {
  origin: string;
  /** CLI bearer (`ptc_…` session or `pta_…` access token with ai.proxy). */
  token: string;
  /** Workers AI prefix-cache pin (x-session-affinity) for this agent. */
  sessionAffinity?: string;
}

/** The worker's signed-in OpenAI-compatible inference proxy. */
export function cloudProxyBaseURL(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/api/user/ai/v1`;
}

export interface LocalModelResolver {
  normalizeSpecSync(specOrNull?: string | null): string;
  resolveModel(specOrNull?: string | null): LanguageModel;
  listProviders(): Promise<ProviderInfo[]>;
  /** Models from every available provider, plus the providers that could not
   *  be listed — one broken credential never empties the menu. */
  listModels(): Promise<ModelMenu>;
  /** One spec's catalog entry (provider listModels lookup) — per-model
   *  metadata like input modalities for the attachment sanitizer. Null when
   *  the provider/model is unknown or the catalog is unreachable. */
  modelInfo(specOrNull?: string | null): Promise<ModelInfo | null>;
  /** One spec per available provider, in registry preference order — what
   *  judge/panel selection walks (core's `availableJudgeSpecs`, the same rule
   *  the DO backend uses). */
  judgeCandidates(): Promise<string[]>;
  /** The registered providers' small-tier declarations — what core's
   *  `selectFastModel` walks to find a cheaper model of the SAME vendor for
   *  the mechanical evolution calls. */
  fastModelCandidates(): ReadonlyArray<Pick<ModelProvider, 'id' | 'fastModel'>>;
  /** Resolve auth headers for a credential key (e.g. `tavily` for the web
   *  search upgrade) through the same local auth store model resolution uses. */
  getAuth: AuthResolver;
}

export interface LocalModelResolverConfig {
  llm: LLMProviderConfig;
  credentials?: LocalProviderCredentials;
  codexAuthStore?: LocalCodexAuthStore;
  /** Signed-in session. When present, workers-ai + my-gateway resolve through
   *  the worker's AI proxy; when absent they list as unavailable with a
   *  `proteus auth` hint. */
  cloud?: LocalCloudSession;
  fetch?: typeof fetch;
  onCodexRefresh?: (credential: OAuthCredential) => void;
  /** Seams for the local Claude-subscription provider (tests inject a fake
   *  `claude` binary). Production leaves this undefined — the provider spawns
   *  the real binary and probes `claude auth status`. */
  claudeCli?: ClaudeCliProviderOptions;
  /** Seam for the local opencode bridge provider. Production leaves this
   *  undefined — the provider probes the real opencode binary and reads
   *  ~/.local/share/opencode/auth.json. */
  opencode?: OpenCodeProviderOptions;
}

/**
 * The workspace LLM seam over the local registry.
 *
 * `spec` overrides which model it resolves — that is how the MECHANICAL
 * evolution calls reach the chat vendor's small tier (core's selectFastModel)
 * without a second provider path: same resolver, same credentials, one
 * different model id. Omitted = the workspace's configured chat model.
 */
export function createLocalProviderLLM(opts: LocalModelResolverConfig & { spec?: string | null }): LLM {
  const resolver = createLocalModelResolver(opts);
  const spec = resolver.normalizeSpecSync(opts.spec ?? null);
  const providerOptions = reasoningEffortOptions('low', parseModelSpec(spec).provider);
  const maxOutputTokens = opts.llm.maxTokens;
  const model = () => resolver.resolveModel(spec);
  return {
    async *stream(input) {
      const result = streamText({
        model: model(),
        system: input.system,
        messages: input.messages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(providerOptions ? { providerOptions } : {}),
      });
      for await (const chunk of result.textStream) yield chunk;
    },
    async complete(prompt) {
      const result = await generateText({
        model: model(),
        prompt,
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(providerOptions ? { providerOptions } : {}),
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

  const cloud = opts.cloud;
  // An explicit direct endpoint (PROTEUS_BASE_URL → llm.name workers-ai) keeps
  // precedence over the signed-in proxy; the proxy-derived llm config (its
  // baseURL IS the proxy) registers through the cloud providers below instead.
  const llmIsCloudProxy = cloud !== undefined
    && localEndpoint.baseURL.replace(/\/+$/, '') === cloudProxyBaseURL(cloud.origin);

  const defaultProvider = defaultProviderFor(localEndpoint);
  if (defaultProvider === 'workers-ai' && !llmIsCloudProxy) {
    registry.register(createGatewayBackedProvider({
      id: 'workers-ai',
      label: 'Cloudflare Workers AI (local gateway)',
      defaultModel: localEndpoint.model,
      llm: localEndpoint,
      catalogProviderId: 'cloudflare-workers-ai',
      fetch: opts.fetch,
    }));
    registry.register(createGatewayBackedProvider({
      id: 'ai-gateway',
      label: 'Cloudflare AI Gateway (local)',
      defaultModel: localEndpoint.model.startsWith('workers-ai/') ? localEndpoint.model : `workers-ai/${localEndpoint.model}`,
      llm: localEndpoint,
      catalogProviderId: 'cloudflare-workers-ai',
      catalogModelPrefix: 'workers-ai/',
      fetch: opts.fetch,
    }));
  }

  if (cloud) {
    const menu = createCloudModelMenu(cloud, opts.fetch);
    if (!registry.get('workers-ai')) {
      registry.register(createCloudProxyProvider({
        id: 'workers-ai',
        label: 'Cloudflare Workers AI (your account)',
        cloud,
        menu,
        defaultModel: DEFAULT_WORKERS_AI_MODEL_ID,
        unavailableReason: 'Connect Cloudflare in your Proteus user settings to use Workers AI.',
        fetch: opts.fetch,
      }));
    }
    registry.register(createCloudProxyProvider({
      id: 'my-gateway',
      label: 'Your AI Gateway',
      cloud,
      menu,
      unavailableReason: 'Connect Cloudflare and select an AI Gateway in your Proteus user settings.',
      fetch: opts.fetch,
    }));
  } else {
    if (!registry.get('workers-ai')) {
      registry.register(createSignedOutCloudProvider('workers-ai', 'Cloudflare Workers AI (your account)'));
    }
    registry.register(createSignedOutCloudProvider('my-gateway', 'Your AI Gateway'));
  }

  registry.register(createClaudeCliProvider(opts.claudeCli));
  registry.register(createOpenCodeProvider(opts.opencode));
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
    judgeCandidates() {
      return availableJudgeSpecs(registry, deps);
    },
    fastModelCandidates() {
      return registry.list();
    },
    listModels() {
      return registry.listAllModels(deps);
    },
    async modelInfo(specOrNull) {
      const spec = normalizeSpecSync(specOrNull);
      const { provider, modelId } = parseModelSpec(spec);
      return catalogModelInfo(registry.get(provider), deps, modelId);
    },
    getAuth: deps.getAuth,
  };
}

function createGatewayBackedProvider(opts: {
  id: string;
  label: string;
  defaultModel: string;
  llm: LLMProviderConfig;
  catalogProviderId?: 'cloudflare-workers-ai';
  catalogModelPrefix?: string;
  fetch?: typeof fetch;
}): ModelProvider {
  return {
    id: opts.id,
    label: opts.label,
    defaultModel: opts.defaultModel,
    isAvailable: () => !!opts.llm.baseURL && Object.keys(opts.llm.headers).length > 0,
    unavailableReason: () => 'PROTEUS_BASE_URL and PROTEUS_AUTH are required for the local gateway provider.',
    async listModels(deps): Promise<ModelInfo[]> {
      const fallback: ModelInfo[] = [{ id: opts.defaultModel, label: opts.defaultModel, capabilities: ['tools', 'streaming'] }];
      if (!opts.catalogProviderId) return fallback;
      const models = await listModelsDevProviderModels(opts.catalogProviderId, deps, {
        fallback,
        preferredIds: [opts.defaultModel.replace(/^workers-ai\//, '')],
      });
      const prefix = opts.catalogModelPrefix ?? '';
      if (!prefix) return models;
      return models.map((model) => ({
        ...model,
        id: model.id.startsWith(prefix) ? model.id : `${prefix}${model.id}`,
        capabilities: model.capabilities ? [...model.capabilities] : undefined,
      }));
    },
    createModel(modelId): LanguageModel {
      return createChatModel({
        kind: 'openai-compat',
        name: opts.id,
        baseURL: opts.llm.baseURL,
        headers: opts.llm.headers,
        modelId,
        fetch: opts.fetch,
      });
    },
  };
}

interface CloudMenuEntry {
  spec: string;
  label: string;
  provider: string;
  capabilities?: ModelCapability[];
  contextWindow?: number;
}

const CLOUD_MENU_TTL_MS = 60_000;

interface CloudMenu {
  entries: CloudMenuEntry[];
  /** Why the server could not list a provider, keyed by provider id — the
   *  cloud providers report it verbatim instead of their canned hint. */
  failures: Map<string, string>;
}

const EMPTY_CLOUD_MENU: CloudMenu = { entries: [], failures: new Map() };

/** Server-driven model menu (GET /api/cli/models) shared by the cloud
 *  providers — the worker is the source of truth for what the signed-in
 *  account can actually serve (Cloudflare connected, gateway BYOK slugs,
 *  Unified Billing). Failures list as empty, so availability stays honest
 *  while explicit specs still resolve through the proxy. */
function createCloudModelMenu(cloud: LocalCloudSession, fetchImpl?: typeof fetch): () => Promise<CloudMenu> {
  const baseFetch = fetchImpl ?? fetch;
  let cached: { at: number; menu: CloudMenu } | null = null;
  return async () => {
    if (cached && Date.now() - cached.at < CLOUD_MENU_TTL_MS) return cached.menu;
    try {
      const res = await baseFetch(`${cloud.origin.replace(/\/+$/, '')}/api/cli/models`, {
        headers: { authorization: `Bearer ${cloud.token}`, accept: 'application/json' },
      });
      if (!res.ok) return EMPTY_CLOUD_MENU;
      const body: unknown = await res.json();
      const source = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      const rows = source.models;
      const entries = (Array.isArray(rows) ? rows : []).flatMap((row): CloudMenuEntry[] => {
        if (!row || typeof row !== 'object') return [];
        const item = row as Record<string, unknown>;
        if (typeof item.spec !== 'string' || typeof item.provider !== 'string') return [];
        return [{
          spec: item.spec,
          label: typeof item.label === 'string' ? item.label : item.spec,
          provider: item.provider,
          capabilities: Array.isArray(item.capabilities)
            ? MODEL_CAPABILITIES.filter((cap) => (item.capabilities as unknown[]).includes(cap))
            : undefined,
          contextWindow: typeof item.contextWindow === 'number' && item.contextWindow > 0
            ? Math.floor(item.contextWindow)
            : undefined,
        }];
      });
      const menu: CloudMenu = { entries, failures: cloudMenuFailures(source.failures) };
      cached = { at: Date.now(), menu };
      return menu;
    } catch {
      return EMPTY_CLOUD_MENU;
    }
  };
}

function cloudMenuFailures(rows: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { provider, reason } = row as Record<string, unknown>;
    if (typeof provider === 'string' && typeof reason === 'string' && provider && reason) {
      out.set(provider, reason);
    }
  }
  return out;
}

/** workers-ai / my-gateway backed by the worker's signed-in AI proxy. The
 *  model id IS the proxy wire id (`@cf/…` or `{author}/{model}`), so specs
 *  match the hosted backend exactly. */
function createCloudProxyProvider(opts: {
  id: 'workers-ai' | 'my-gateway';
  label: string;
  cloud: LocalCloudSession;
  menu: () => Promise<CloudMenu>;
  defaultModel?: string;
  unavailableReason: string;
  fetch?: typeof fetch;
}): ModelProvider {
  const baseURL = cloudProxyBaseURL(opts.cloud.origin);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.cloud.token}`,
    ...(opts.cloud.sessionAffinity ? { 'x-session-affinity': opts.cloud.sessionAffinity } : {}),
  };
  const prefix = `${opts.id}/`;
  return {
    id: opts.id,
    label: opts.label,
    defaultModel: opts.defaultModel,
    async isAvailable() {
      return (await opts.menu()).entries.some((entry) => entry.provider === opts.id);
    },
    async unavailableReason() {
      return (await opts.menu()).failures.get(opts.id) ?? opts.unavailableReason;
    },
    async listModels(): Promise<ModelInfo[]> {
      return (await opts.menu()).entries
        .filter((entry) => entry.provider === opts.id)
        .map((entry) => ({
          id: entry.spec.startsWith(prefix) ? entry.spec.slice(prefix.length) : entry.spec,
          label: entry.label,
          capabilities: entry.capabilities ? [...entry.capabilities] : undefined,
          contextWindow: entry.contextWindow,
        }));
    },
    createModel(modelId): LanguageModel {
      return createChatModel({
        kind: 'openai-compat',
        name: opts.id,
        baseURL,
        headers,
        modelId,
        fetch: opts.fetch,
      });
    },
  };
}

/** Honest placeholder when the user is not signed in: the providers stay
 *  visible in /model with the exact step that unlocks them. */
function createSignedOutCloudProvider(id: 'workers-ai' | 'my-gateway', label: string): ModelProvider {
  const reason = 'Sign in with `proteus auth` to use your Cloudflare AI for local agents.';
  return {
    id,
    label,
    isAvailable: () => false,
    unavailableReason: () => reason,
    listModels: async () => [],
    createModel(): LanguageModel {
      throw new Error(reason);
    },
  };
}

function defaultProviderFor(llm: LLMProviderConfig): 'workers-ai' | 'codex' | 'openai' | 'anthropic' | 'openrouter' | 'openai-compat' | 'opencode' {
  if (llm.name === 'workers-ai' || llm.model.startsWith('@cf/')) return 'workers-ai';
  if (llm.name === 'codex') return 'codex';
  if (llm.name === 'openai') return 'openai';
  if (llm.name === 'anthropic') return 'anthropic';
  if (llm.name === 'openrouter') return 'openrouter';
  if (llm.name === 'opencode') return 'opencode';
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
