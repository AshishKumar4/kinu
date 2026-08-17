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
  createModelsDevCatalogSource,
  createOpenAICompatProvider,
  createOpenAIProvider,
  createOpenRouterProvider,
  createProviderProxyFetch,
  createProviderRegistry,
  listModelsDevProviderModels,
  parseModelSpec,
  PROXY_DENIED_CRED_KEYS,
  providerProxyCredentialsURL,
  providerProxyForwardURL,
  proxyAuthResolution,
  reasoningEffortOptions,
  type AuthResolution,
  type AuthResolver,
  type ModelCapability,
  type ModelInfo,
  type ModelMenu,
  type ModelProvider,
  type ProviderDeps,
  type ProviderInfo,
} from '@proteus/core';
import type { OAuthCredential } from '@proteus/core';
import { generateText, streamText } from 'ai';
import type { LanguageModel } from 'ai';
import type { LLM } from '@proteus/core';
import { createClaudeCliProvider, type ClaudeCliProviderOptions } from './claude-cli-provider.js';
import { createOpenCodeProvider, type OpenCodeProviderOptions } from './opencode-provider.js';
import type { LocalCodexAuthStore } from './codex-auth-store.js';
import * as v from 'valibot';

const cloudMenuSchema = v.object({
  models: v.optional(v.array(v.object({
    spec: v.string(),
    label: v.optional(v.string()),
    provider: v.string(),
    capabilities: v.optional(v.array(v.string())),
    contextWindow: v.optional(v.number()),
  })), []),
  failures: v.optional(v.array(v.object({
    provider: v.string(),
    reason: v.string(),
  })), []),
});
const proxiedCredentialsSchema = v.object({
  credentials: v.optional(v.array(v.object({
    key: v.string(),
    baseURL: v.optional(v.string()),
  })), []),
});

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

/** The provider ids the signed-in worker fronts — the native Cloudflare path.
 *  One list so the CLI's endpoint/credential seam and this registry agree on
 *  which specs belong to the account rather than to a local BYO credential. */
export const CLOUD_PROXY_PROVIDER_IDS = ['workers-ai', 'my-gateway'] as const;
export type CloudProxyProviderId = typeof CLOUD_PROXY_PROVIDER_IDS[number];

/** The worker's signed-in OpenAI-compatible inference proxy. */
export function cloudProxyBaseURL(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/api/user/ai/v1`;
}

/**
 * Proxy fetch wrappers, memoized per session + underlying fetch.
 *
 * `deps.fetch` is the identity the models.dev catalog caches on
 * (`getModelsDevCatalog` compares function identity), so handing every new
 * resolver a fresh closure would re-download the catalog on each one. The
 * wrapper is pure given its inputs, so one instance per session is correct as
 * well as cheap.
 */
const proxyFetchCache = new Map<string, { base: typeof fetch | undefined; proxy: typeof fetch }>();

function proxyFetchFor(cloud: LocalCloudSession, base: typeof fetch | undefined): typeof fetch {
  // Deliberately not keyed on sessionAffinity: that header pins a Workers AI
  // replica and means nothing to a third-party provider, so it is not sent
  // here — and keying on it would have given each agent name its own fetch
  // identity, re-downloading the models.dev catalog on every switch.
  const cacheKey = `${cloud.origin} ${cloud.token}`;
  const cached = proxyFetchCache.get(cacheKey);
  if (cached && cached.base === base) return cached.proxy;
  const proxy = createProviderProxyFetch({
    forwardURL: providerProxyForwardURL(cloud.origin),
    authorization: `Bearer ${cloud.token}`,
    fetch: base,
  });
  proxyFetchCache.set(cacheKey, { base, proxy });
  return proxy;
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
      const request: Parameters<typeof streamText>[0] = {
        model: model(),
        system: input.system,
        messages: input.messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      };
      if (maxOutputTokens !== undefined) request.maxOutputTokens = maxOutputTokens;
      if (providerOptions) request.providerOptions = providerOptions;
      const result = streamText(request);
      for await (const chunk of result.textStream) yield chunk;
    },
    async complete(prompt) {
      const request: Parameters<typeof generateText>[0] = {
        model: model(),
        prompt,
      };
      if (maxOutputTokens !== undefined) request.maxOutputTokens = maxOutputTokens;
      if (providerOptions) request.providerOptions = providerOptions;
      const result = await generateText(request);
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

  // Any provider the owner connected in the web UI resolves through the
  // worker's general proxy — a marker instead of a secret, and the request
  // relocated to a server that holds the key. A LOCAL credential always wins:
  // the machine keeps working offline, and an explicit local key is an
  // explicit override.
  const proxied = cloud ? proxyCredentialSourceFor(cloud, opts.fetch) : null;
  registry.registerDynamic(createModelsDevCatalogSource({ exclude: ['cloudflare-workers-ai'] }));

  const deps: ProviderDeps = {
    env: {},
    fetch: cloud ? proxyFetchFor(cloud, opts.fetch) : opts.fetch,
    async getAuth(key, authOpts) {
      const local = await authStore.get(key, authOpts);
      if (local) return local;
      const remote = (await proxied?.load())?.byKey.get(key);
      return remote ? proxyAuthResolution(key, remote.baseURL) : null;
    },
    async hasCredential(key) {
      if (authStore.has(key)) return true;
      // A credential the proxy would never front cannot be hiding in the
      // account, so the local answer is the whole answer for it.
      if (PROXY_DENIED_CRED_KEYS.includes(key)) return false;
      const remote = await proxied?.load();
      if (!remote) return false;
      if (remote.byKey.has(key)) return true;
      // Never listed successfully — "not connected" would be a guess, and a
      // provider reported unavailable for the wrong reason is worse than one
      // reported unavailable for the right one.
      if (remote.error) throw new Error(remote.error);
      return false;
    },
    async listCredentialKeys() {
      const keys = new Set(authStore.keys());
      for (const key of (await proxied?.load())?.byKey.keys() ?? []) keys.add(key);
      return [...keys];
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
      // A models.dev provider the account has connected is a provider here
      // too — that is what makes a web-UI-connected key selectable locally.
      // The snapshot is empty until a listing lands, so this answer can change
      // once within a process; every path that picks a model (the menu,
      // `findUnusableModel`, catalog lookup) lists first, and the source is
      // memoized per session so one listing warms them all.
      if (proxied?.providerIds().has(first)) return s;
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

interface CloudProxyHeaders {
  [header: string]: string;
  Authorization: string;
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
      const source = v.parse(cloudMenuSchema, await res.json());
      const entries = source.models.map((item): CloudMenuEntry => ({
        spec: item.spec,
        label: item.label ?? item.spec,
        provider: item.provider,
        capabilities: item.capabilities
          ? MODEL_CAPABILITIES.filter((capability) => item.capabilities?.includes(capability))
          : undefined,
        contextWindow: item.contextWindow && item.contextWindow > 0
          ? Math.floor(item.contextWindow)
          : undefined,
      }));
      const menu: CloudMenu = { entries, failures: cloudMenuFailures(source.failures) };
      cached = { at: Date.now(), menu };
      return menu;
    } catch {
      return EMPTY_CLOUD_MENU;
    }
  };
}

/** The credentials the worker will front for this machine: keys only, plus the
 *  base URL for the ones whose endpoint is part of the credential. */
interface ProxiedCredentials {
  byKey: Map<string, { baseURL?: string }>;
  /** Set only while no listing has ever succeeded — once one has, a later
   *  failure serves the last good answer instead of unlearning the account's
   *  providers over a transient network blip. */
  error: string | null;
}

const PROXIED_CREDENTIALS_TTL_MS = 60_000;

const CATALOG_CRED_KEY = /^([a-z0-9][a-z0-9._-]*)\.bearer$/;

interface ProxyCredentialSource {
  load(): Promise<ProxiedCredentials>;
  /** Catalog provider ids the proxy is currently serving, as last loaded.
   *  Synchronous because `normalizeSpecSync` has to decide whether the first
   *  path segment of `groq/llama-3.3` is a provider or part of a slashful
   *  model id, and it cannot await. Empty until a listing has landed, which
   *  is why the source is memoized per session below: every async listing in
   *  the process warms the snapshot the sync path reads. */
  providerIds(): ReadonlySet<string>;
}

/** One source per signed-in session, shared across resolver instances so a
 *  listing done for the model picker also warms the spec normalizer. */
const proxyCredentialSources = new Map<string, { base: typeof fetch | undefined; source: ProxyCredentialSource }>();

function proxyCredentialSourceFor(cloud: LocalCloudSession, base: typeof fetch | undefined): ProxyCredentialSource {
  const cacheKey = `${cloud.origin} ${cloud.token}`;
  const cached = proxyCredentialSources.get(cacheKey);
  if (cached && cached.base === base) return cached.source;
  const source = createProxyCredentialSource(cloud, base);
  proxyCredentialSources.set(cacheKey, { base, source });
  return source;
}

function createProxyCredentialSource(
  cloud: LocalCloudSession,
  fetchImpl?: typeof fetch,
): ProxyCredentialSource {
  const baseFetch = fetchImpl ?? fetch;
  let cached: { at: number; value: ProxiedCredentials } | null = null;
  let providerIds: ReadonlySet<string> = new Set();
  const load = async (): Promise<ProxiedCredentials> => {
    if (cached && Date.now() - cached.at < PROXIED_CREDENTIALS_TTL_MS) return cached.value;
    try {
      const res = await baseFetch(providerProxyCredentialsURL(cloud.origin), {
        headers: { authorization: `Bearer ${cloud.token}`, accept: 'application/json' },
      });
      // A rejected session is a real answer — this machine has no account
      // credentials — and serving the last good listing over it would keep
      // advertising providers every call now 401s on.
      if (res.status === 401 || res.status === 403) {
        const value: ProxiedCredentials = { byKey: new Map(), error: null };
        cached = { at: Date.now(), value };
        providerIds = new Set();
        return value;
      }
      if (!res.ok) throw new Error(`the Proteus provider proxy returned HTTP ${res.status}`);
      const body = v.parse(proxiedCredentialsSchema, await res.json());
      const byKey = new Map<string, { baseURL?: string }>();
      for (const { key, baseURL } of body.credentials) {
        if (!key) continue;
        byKey.set(key, baseURL ? { baseURL } : {});
      }
      const value: ProxiedCredentials = { byKey, error: null };
      cached = { at: Date.now(), value };
      providerIds = new Set([...byKey.keys()].flatMap((key) => CATALOG_CRED_KEY.exec(key)?.[1] ?? []));
      return value;
    } catch (err) {
      if (cached) return cached.value;
      return {
        byKey: new Map(),
        error: `Could not reach your Proteus account to list connected providers (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
  };
  return { load, providerIds: () => providerIds };
}

function cloudMenuFailures(rows: v.InferOutput<typeof cloudMenuSchema>['failures']): Map<string, string> {
  const out = new Map<string, string>();
  for (const { provider, reason } of rows) {
    if (provider && reason) {
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
  const headers: CloudProxyHeaders = { Authorization: `Bearer ${opts.cloud.token}` };
  if (opts.cloud.sessionAffinity) headers['x-session-affinity'] = opts.cloud.sessionAffinity;
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
function createSignedOutCloudProvider(id: CloudProxyProviderId, label: string): ModelProvider {
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

interface LocalAuthStore {
  has(key: string): boolean;
  keys(): string[];
  get(key: string, authOpts?: { forceRefresh?: boolean }): Promise<AuthResolution | null>;
}

interface OpenAICompatHeaders {
  [header: string]: string;
}

function buildAuthStore(
  localEndpoint: LLMProviderConfig,
  credentials: LocalProviderCredentials,
  opts: {
    codexAuthStore?: LocalCodexAuthStore;
    fetch?: typeof fetch;
    onCodexRefresh?: (credential: OAuthCredential) => void;
  } = {},
): LocalAuthStore {
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
    const headers: OpenAICompatHeaders = {
      ...compat.headers,
      ...compat.extraHeaders,
    };
    if (compat.apiKey) headers.Authorization = `Bearer ${compat.apiKey}`;
    store.set(`openai-compat.${name}`, {
      headers,
      baseURL: compat.baseURL,
    });
  }

  const hasCodex = (): boolean => (opts.codexAuthStore
    ? opts.codexAuthStore.hasCredential()
    : Boolean(codexCredential?.accessToken || credentials.codexAccessToken));

  return {
    has(key: string): boolean {
      if (key === CODEX_CRED_KEY) return hasCodex();
      return store.has(key);
    },
    keys(): string[] {
      return hasCodex() ? [...store.keys(), CODEX_CRED_KEY] : [...store.keys()];
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
