import { createChatModel, type LLMProviderConfig } from '@kinu.run/core';
import {
  CODEX_CRED_KEY,
  DEFAULT_WORKERS_AI_MODEL_ID,
  MAIN_ACCOUNT,
  accountCredentialKey,
  accountOf,
  baseCredentialKey,
  credentialToHeaders,
  normalizeModelMenu,
  codexCredentialToHeaders,
  createAnthropicProvider,
  createCodexProvider,
  availableJudgeSpecs,
  accountDeps,
  catalogModelInfo,
  createModelsDevCatalogSource,
  createOpenAICompatProvider,
  createOpenAIProvider,
  createOpenRouterProvider,
  createProviderProxyFetch,
  createProviderRegistry,
  listModelsDevProviderModels,
  normalizeUsage,
  parseModelSpec,
  specProvider,
  workersAiSpec, WORKERS_AI_MODEL_ID_PREFIX,
  catalogProviderOfKey,
  isProxyDeniedCredentialKey,
  providerProxyCredentialsURL,
  providerProxyForwardURL,
  proxyAuthResolution,
  reasoningEffortOptions,
  type AuthResolution,
  type AuthResolver,
  type AgentModelEntry,
  type ModelInfo,
  cloudProxyBaseURL,
  type CloudProxyProviderId,
  type ModelMenu,
  type ModelProvider,
  type ProviderDeps,
  type ProviderInfo,
  type ProviderWaitInfo,
  type ModelCallSpend,
  countRequestInputTokens,
  type CountableRequest,
  type InputTokenCount,
} from '@kinu.run/core';
import { generateText, streamText } from 'ai';
import type { LanguageModel, LanguageModelUsage } from 'ai';
import type { LLM } from '@kinu.run/core';
import { CLAUDE_CLI_PROVIDER_ID, createClaudeCliProvider, type ClaudeCliProviderOptions } from './claude-cli-provider';
import { OPENCODE_PROVIDER_ID, createOpenCodeProvider } from './opencode-provider';
import type { LocalCodexAuthStore } from './codex-auth-store';
import * as v from 'valibot';
import { diagnostics, renderThrownChain } from '@kinu.run/core/obs';

const proxiedCredentialsSchema = v.object({
  credentials: v.optional(v.array(v.object({
    key: v.string(),
    baseURL: v.optional(v.string()),
    failure: v.optional(v.string()),
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
  openaiCompat?: Record<string, LocalOpenAICompatCredential>;
  apiKeyAccounts?: Readonly<Record<string, string>>;
}

/** Signed-in Kinu session: local agents use the user's Cloudflare AI through
 *  the worker's /api/user/ai/v1 proxy, with no Cloudflare token on this machine. */
export interface LocalCloudSession {
  origin: string;
  /** CLI bearer (`ptc_…` session or `pta_…` access token with ai.proxy). */
  token: string;
}

// Re-exported: this module is the CLI's endpoint/credential seam.
export {
  CLOUD_PROXY_PROVIDER_IDS, cloudProxyBaseURL, type CloudProxyProviderId,
} from '@kinu.run/core';

/** Memoized per session + fetch: `getModelsDevCatalog` caches on fetch identity,
 *  so a fresh closure per resolver would re-download the catalog. */
const proxyFetchCache = new Map<string, { base: typeof fetch | undefined; proxy: typeof fetch }>();

function proxyFetchFor(cloud: LocalCloudSession, base: typeof fetch | undefined): typeof fetch {
  // Not keyed on sessionAffinity: that header pins a Workers AI replica, is not
  // sent to third parties, and keying on it would re-download the catalog per agent.
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
  /** One broken credential never empties the menu. */
  listModels(): Promise<ModelMenu>;
  /** Per-model metadata (e.g. input modalities); null when unknown or unreachable. */
  modelInfo(specOrNull?: string | null): Promise<ModelInfo | null>;
  /** One spec per available provider, in registry preference order. */
  judgeCandidates(): Promise<string[]>;
  /** Pre-request token count (core `providers/input-tokens.ts`); `unsupported`
   *  means the turn is assembled ungated rather than gated on an estimate. */
  countInputTokens(specOrNull: string | null | undefined, request: CountableRequest): Promise<InputTokenCount>;
  getAuth: AuthResolver;
  /**
   * A setter: the resolver is built before the session owning the sink, and is
   * shared across sessions, so the last install wins. Unset leaves waits unreported.
   */
  setProviderWaitSink?(sink: ((info: ProviderWaitInfo) => void) | undefined): void;
  withAccountChoice?(choice: (providerId: string) => string | undefined): LocalModelResolver;
}

export interface LocalModelResolverConfig {
  /** Default endpoint for bare model ids. Null when nothing derives one: explicit
   *  `provider/model` specs still resolve, bare ids fail with the fixes named. */
  llm: LLMProviderConfig | null;
  credentials?: LocalProviderCredentials;
  codexAuthStore?: LocalCodexAuthStore;
  /** When present, workers-ai + my-gateway resolve through the worker's AI proxy;
   *  when absent they list as unavailable with a `kinu auth` hint. */
  cloud?: LocalCloudSession;
  sessionAffinity?: string;
  fetch?: typeof fetch;
  /** Seam for the local Claude-subscription provider; tests inject a fake `claude` binary. */
  claudeCli?: ClaudeCliProviderOptions;
  /** Read per call so {@link LocalModelResolver.setProviderWaitSink} can install
   *  the session's sink after construction. */
  onProviderWait?: (info: ProviderWaitInfo) => void;
}

/** Reported even when the provider said nothing (`{}`), so a silent provider
 *  stays distinguishable from a free one. */
function reportCall(
  spend: ModelCallSpend,
  spec: string,
  usage: LanguageModelUsage,
  modelId: string | undefined,
): void {
  const reported = normalizeUsage(usage);
  spend.report(modelId !== undefined && modelId.length > 0
    ? { source: spend.source, spec, usage: reported, modelId }
    : { source: spend.source, spec, usage: reported });
}

/**
 * The workspace LLM seam over the local registry. `spec` overrides the model
 * (chosen by the turn profile's tier route); omitted = configured chat model.
 * Only completed calls report spend: a thrown call yields no usage.
 */
export function createLocalProviderLLM(opts: LocalModelResolverConfig & {
  spec?: string | null;
  /** Sink and producer label together: only the consumer knows which producer
   *  a call belongs to. Unset leaves spend unattributed. */
  spend?: ModelCallSpend;
}): LLM {
  const resolver = createLocalModelResolver(opts);
  // Normalized per call: an unresolvable id fails at the call, not at construction.
  const spec = () => resolver.normalizeSpecSync(opts.spec ?? null);
  const model = (resolved: string) => resolver.resolveModel(resolved);
  const spend = opts.spend;
  const effortOptions = (resolved: string) => reasoningEffortOptions('low', parseModelSpec(resolved).provider);

  return {
    async *stream(input) {
      const resolved = spec();

      const request: Parameters<typeof streamText>[0] = {
        model: model(resolved),
        system: input.system,
        messages: input.messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      };

      const providerOptions = effortOptions(resolved);

      if (providerOptions) request.providerOptions = providerOptions;
      const result = streamText(request);

      for await (const chunk of result.textStream) yield chunk;

      // Usage exists only once the stream drains; an abandoned stream reports nothing.
      if (spend) reportCall(spend, resolved, await result.totalUsage, (await result.response).modelId);
    },
    async complete(prompt) {
      const resolved = spec();

      const request: Parameters<typeof generateText>[0] = {
        model: model(resolved),
        prompt,
      };

      const providerOptions = effortOptions(resolved);

      if (providerOptions) request.providerOptions = providerOptions;
      const result = await generateText(request);

      if (spend) reportCall(spend, resolved, result.totalUsage, result.response.modelId);

      return result.text.trim();
    },
  };
}

/**
 * Local provider registry: the DO backend's registry contract from local
 * config/env credentials, keeping the KINU_BASE_URL / KINU_AUTH override.
 */
export function createLocalModelResolver(opts: LocalModelResolverConfig): LocalModelResolver {
  const registry = createProviderRegistry();
  const localEndpoint = opts.llm;
  const credentials = opts.credentials ?? {};
  const authStore = buildAuthStore(localEndpoint, credentials, opts.codexAuthStore);

  const cloud = opts.cloud;

  // An explicit direct endpoint takes precedence over the signed-in proxy; the
  // proxy-derived config registers through the cloud providers below.
  const llmIsCloudProxy = cloud !== undefined
    && localEndpoint !== null
    && localEndpoint.baseURL.replace(/\/+$/, '') === cloudProxyBaseURL(cloud.origin);

  const defaultProvider = defaultProviderFor(localEndpoint);

  if (localEndpoint !== null && defaultProvider === 'workers-ai' && !llmIsCloudProxy) {
    // Cloudflare-shaped endpoint, so it takes the same replica pin as the proxy path.
    const pinned = withAffinity(localEndpoint, opts.sessionAffinity);
    registry.register(createGatewayBackedProvider({
      id: 'workers-ai',
      label: 'Cloudflare Workers AI (local gateway)',
      defaultModel: localEndpoint.model,
      llm: pinned,
      catalogProviderId: 'cloudflare-workers-ai',
      fetch: opts.fetch,
    }));
    registry.register(createGatewayBackedProvider({
      id: 'ai-gateway',
      label: 'Cloudflare AI Gateway (local)',
      defaultModel: workersAiSpec(localEndpoint.model),
      llm: pinned,
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
        sessionAffinity: opts.sessionAffinity,
        menu,
        defaultModel: DEFAULT_WORKERS_AI_MODEL_ID,
        unavailableReason: 'Connect Cloudflare in Account settings in the Kinu app to use Workers AI.',
        fetch: opts.fetch,
      }));
    }

    registry.register(createCloudProxyProvider({
      id: 'my-gateway',
      label: 'Your AI Gateway',
      cloud,
      sessionAffinity: opts.sessionAffinity,
      menu,
      unavailableReason: 'Connect Cloudflare and pick an AI Gateway in Account settings in the Kinu app.',
      fetch: opts.fetch,
    }));
  } else {
    if (!registry.get('workers-ai')) {
      registry.register(createSignedOutCloudProvider('workers-ai', 'Cloudflare Workers AI (your account)'));
    }

    registry.register(createSignedOutCloudProvider('my-gateway', 'Your AI Gateway'));
  }

  registry.register(createClaudeCliProvider(opts.claudeCli));
  registry.register(createOpenCodeProvider());
  registry.register(createCodexProvider());
  registry.register(createOpenAIProvider());
  registry.register(createAnthropicProvider());
  registry.register(createOpenRouterProvider({ appTitle: 'Kinu CLI' }));
  registry.register(createOpenAICompatProvider());

  for (const name of Object.keys(credentials.openaiCompat ?? {}).sort()) {
    if (name !== 'default') registry.register(createOpenAICompatProvider(`openai-compat:${name}`));
  }

  // Web-UI-connected providers resolve through the worker's proxy. A local
  // credential always wins: offline use and explicit override.
  const proxied = cloud ? proxyCredentialSourceFor(cloud, opts.fetch) : null;
  registry.registerDynamic(createModelsDevCatalogSource({ exclude: ['cloudflare-workers-ai'] }));

  const depsFor = (accountFor?: (providerId: string) => string | undefined): ProviderDeps => ({
    env: {},
    sessionAffinity: opts.sessionAffinity,
    fetch: cloud ? proxyFetchFor(cloud, opts.fetch) : opts.fetch,
    async getAuth(key, authOpts) {
      const local = await authStore.get(key, authOpts);

      if (local) return local;
      const remote = (await proxied?.load())?.byKey.get(key);

      if (remote?.failure !== undefined) throw new Error(remote.failure);

      return remote ? proxyAuthResolution(key, remote.baseURL) : null;
    },
    async hasCredential(key) {
      if (authStore.has(key)) return true;

      // A credential the proxy never fronts: the local answer is complete.
      if (isProxyDeniedCredentialKey(key)) return false;
      const remote = await proxied?.load();

      if (!remote) return false;
      const listed = remote.byKey.get(key);

      // Connected but unreadable is that provider's failure, never an absence.
      if (listed?.failure !== undefined) throw new Error(listed.failure);

      if (listed) return true;

      // Never listed successfully: "not connected" would be a guess.
      if (remote.error) throw new Error(remote.error);

      return false;
    },
    async listCredentialKeys() {
      const keys = new Set(authStore.keys());

      for (const key of (await proxied?.load())?.byKey.keys() ?? []) keys.add(key);

      return [...keys];
    },
    onProviderWait: (info) => { opts.onProviderWait?.(info); },
    accountFor,
  });

  const deps = depsFor();

  /** Null endpoint = no default; fixes live in `noDefaultModelMessage`. */
  const fallback: { provider: string; model: string } | null = localEndpoint
    ? {
      provider: defaultProvider !== null && registry.get(defaultProvider) ? defaultProvider : 'openai-compat',
      model: localEndpoint.model,
    }
    : null;

  function normalizeSpecSync(specOrNull?: string | null): string {
    const s = (specOrNull ?? '').trim();

    if (!s) {
      if (!fallback) throw new Error(noDefaultModelMessage());

      return `${fallback.provider}/${fallback.model}`;
    }

    if (s.startsWith(WORKERS_AI_MODEL_ID_PREFIX)) return workersAiSpec(s);

    const first = specProvider(s);

    if (first !== null) {
      if (registry.get(first)) return s;

      // Account-connected models.dev providers count here. The snapshot is empty
      // until a listing lands; every model-picking path lists first.
      if (proxied?.providerIds().has(first)) return s;

      // Slashful model IDs (e.g. minimax/m3) belong to the configured endpoint
      // unless the first segment is a provider.
      if (!fallback) throw new Error(noDefaultModelMessage());

      return `${fallback.provider}/${s}`;
    }

    if (!fallback) throw new Error(noDefaultModelMessage());

    return `${fallback.provider}/${s}`;
  }

  const resolverWith = (own: ProviderDeps): LocalModelResolver => ({
    normalizeSpecSync,
    resolveModel(specOrNull) {
      return registry.resolve(normalizeSpecSync(specOrNull), own);
    },
    listProviders() {
      return registry.listProviders(own);
    },
    judgeCandidates() {
      return availableJudgeSpecs(registry, own);
    },
    listModels() {
      return registry.listAllModels(own);
    },
    async modelInfo(specOrNull) {
      const spec = normalizeSpecSync(specOrNull);
      const { provider, modelId, account } = parseModelSpec(spec);

      return catalogModelInfo(registry.get(provider), accountDeps(own, provider, account), modelId);
    },
    async countInputTokens(specOrNull, request) {
      const spec = normalizeSpecSync(specOrNull);
      const { provider, modelId, account } = parseModelSpec(spec);

      return countRequestInputTokens(registry.get(provider), modelId, accountDeps(own, provider, account), request);
    },
    getAuth: deps.getAuth,
    setProviderWaitSink(sink) {
      opts.onProviderWait = sink;
    },
    withAccountChoice(choice) {
      return resolverWith(depsFor(choice));
    },
  });

  return resolverWith(deps);
}

function withAffinity(llm: LLMProviderConfig, sessionAffinity: string | undefined): LLMProviderConfig {
  if (!sessionAffinity) return llm;

  for (const header in llm.headers) {
    if (header.toLowerCase() === 'x-session-affinity') return llm;
  }

  return { ...llm, headers: { ...llm.headers, 'x-session-affinity': sessionAffinity } };
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
    isAvailable: () => opts.llm.baseURL !== '' && Object.keys(opts.llm.headers).length > 0,
    unavailableReason: () => 'KINU_BASE_URL and KINU_AUTH are required for the local gateway provider.',
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
    createModel(modelId, deps): LanguageModel {
      return createChatModel({
        kind: 'openai-compat',
        name: opts.id,
        baseURL: opts.llm.baseURL,
        headers: opts.llm.headers,
        modelId,
        fetch: opts.fetch,
        onWait: deps.onProviderWait,
      });
    },
  };
}

const CLOUD_MENU_TTL_MS = 60_000;

interface CloudMenu {
  entries: AgentModelEntry[];
  /** Per-provider listing failure, reported verbatim instead of a canned hint. */
  failures: Map<string, string>;
}

interface CloudProxyHeaders {
  [header: string]: string;
  Authorization: string;
}

const EMPTY_CLOUD_MENU: CloudMenu = { entries: [], failures: new Map() };

/** Server-driven model menu (GET /api/cli/models). Failures list as empty;
 *  explicit specs still resolve through the proxy. */
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
      const source = normalizeModelMenu({ payload: await res.json() });

      const menu: CloudMenu = {
        entries: source.models,
        failures: new Map(source.failures.map(({ provider, reason }) => [provider, reason])),
      };

      cached = { at: Date.now(), menu };

      return menu;
    } catch (error) {
      diagnostics.event('model_resolver.cloud_menu_fallback', { error: renderThrownChain({ cause: error }) });

      return EMPTY_CLOUD_MENU;
    }
  };
}

interface ProxiedCredentials {
  byKey: Map<string, { baseURL?: string; failure?: string }>;
  /** Set only until a listing succeeds; afterwards a failure serves the last
   *  good answer rather than forgetting providers over a network blip. */
  error: string | null;
}

const PROXIED_CREDENTIALS_TTL_MS = 60_000;

interface ProxyCredentialSource {
  load(): Promise<ProxiedCredentials>;
  /** Synchronous: `normalizeSpecSync` must decide whether `groq/llama-3.3` starts
   *  with a provider and cannot await. Empty until a listing lands. */
  providerIds(): ReadonlySet<string>;
}

/** Shared across resolvers so a picker listing also warms the spec normalizer. */
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

      // A rejected session is a real answer; serving the last listing would advertise providers that 401.
      if (res.status === 401 || res.status === 403) {
        const value: ProxiedCredentials = { byKey: new Map(), error: null };
        cached = { at: Date.now(), value };
        providerIds = new Set();

        return value;
      }

      if (!res.ok) throw new Error(`the Kinu provider proxy returned HTTP ${res.status}`);
      const body = v.parse(proxiedCredentialsSchema, await res.json());
      const byKey = new Map<string, { baseURL?: string; failure?: string }>();

      for (const { key, baseURL, failure } of body.credentials) {
        if (!key) continue;

        if (failure !== undefined) byKey.set(key, { failure });
        else byKey.set(key, baseURL ? { baseURL } : {});
      }

      const value: ProxiedCredentials = { byKey, error: null };
      cached = { at: Date.now(), value };
      providerIds = new Set([...byKey.keys()].flatMap((key) => catalogProviderOfKey(key) ?? []));

      return value;
    } catch (err) {
      if (cached) return cached.value;

      return {
        byKey: new Map(),
        error: `Could not reach your Kinu account to list connected providers (${renderThrownChain({ cause: err })}).`,
      };
    }
  };

  return { load, providerIds: () => providerIds };
}

/** The model id is the proxy wire id (`@cf/…` or `{author}/{model}`), so specs
 *  match the hosted backend exactly. */
function createCloudProxyProvider(opts: {
  id: 'workers-ai' | 'my-gateway';
  label: string;
  cloud: LocalCloudSession;
  sessionAffinity: string | undefined;
  menu: () => Promise<CloudMenu>;
  defaultModel?: string;
  unavailableReason: string;
  fetch?: typeof fetch;
}): ModelProvider {
  const baseURL = cloudProxyBaseURL(opts.cloud.origin);
  const headers: CloudProxyHeaders = { Authorization: `Bearer ${opts.cloud.token}` };

  if (opts.sessionAffinity) headers['x-session-affinity'] = opts.sessionAffinity;
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
          reasoningEfforts: entry.reasoningEfforts,
        }));
    },
    createModel(modelId, deps): LanguageModel {
      return createChatModel({
        kind: 'openai-compat',
        name: opts.id,
        baseURL,
        headers,
        modelId,
        fetch: opts.fetch,
        onWait: deps.onProviderWait,
      });
    },
  };
}

/** Signed out: providers stay visible in /model with the step that unlocks them. */
function createSignedOutCloudProvider(id: CloudProxyProviderId, label: string): ModelProvider {
  const reason = 'Sign in with `kinu auth` to use Workers AI in your Cloudflare account from local workspaces.';

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

/** Per-backend copy: the CLI and cloud name different remedies. */
function noDefaultModelMessage(): string {
  return 'No default model is set.'
    + ' Run kinu auth to use Workers AI in your Cloudflare account, run kinu setup to pick a model provider,'
    + ' or name a model with --model'
    + ' (for example --model claude/claude-sonnet-4-x once you are signed in to Claude Code).';
}

type CliProviderId =
  | 'workers-ai' | 'codex' | 'openai' | 'anthropic'
  | 'openrouter' | 'openai-compat' | 'opencode' | 'claude';

/**
 * Which provider a bare model id belongs to, given the configured endpoint. The
 * adapter's one table, create path included; a copy missing rows would seed the
 * wrong provider.
 */
function defaultProviderFor(llm: LLMProviderConfig | null): CliProviderId | null {
  if (llm === null) return null;

  if (llm.name === 'workers-ai' || llm.model.startsWith('@cf/')) return 'workers-ai';

  if (llm.name === 'codex') return 'codex';

  if (llm.name === 'openai') return 'openai';

  if (llm.name === 'anthropic') return 'anthropic';

  if (llm.name === 'openrouter') return 'openrouter';

  if (llm.name === OPENCODE_PROVIDER_ID) return OPENCODE_PROVIDER_ID;

  if (llm.name === CLAUDE_CLI_PROVIDER_ID) return CLAUDE_CLI_PROVIDER_ID;

  return 'openai-compat';
}

/** Full spec a configured endpoint stands for: the seed for `actor_config.model`
 *  and the bare-id fallback. Null cues `noDefaultModelMessage()`. */
export function defaultSpecForEndpoint(llm: LLMProviderConfig | null): string | null {
  const provider = defaultProviderFor(llm);

  if (provider === null || llm === null) return null;

  // Some `codex` configs already carry the prefix; avoid `codex/codex/…`.
  return `${provider}/${stripProvider(llm.model, provider)}`;
}

export function stripProvider(model: string, provider: string): string {
  return model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
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
  localEndpoint: LLMProviderConfig | null,
  credentials: LocalProviderCredentials,
  codexAuthStore?: LocalCodexAuthStore,
): LocalAuthStore {
  const store = new Map<string, AuthResolution>();

  if (credentials.openaiApiKey) {
    store.set('openai.bearer', bearer(credentials.openaiApiKey));
  }

  if (!store.has('openai.bearer') && localEndpoint?.name === 'openai') {
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

  if (!store.has('anthropic.bearer') && localEndpoint?.name === 'anthropic') {
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

  if (!store.has('openrouter.bearer') && localEndpoint?.name === 'openrouter') {
    const auth = localEndpoint.headers.Authorization ?? localEndpoint.headers.authorization;

    if (auth) store.set('openrouter.bearer', { headers: { Authorization: auth } });
  }

  if (localEndpoint?.name === 'openai-compat') {
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

  for (const [key, token] of Object.entries(credentials.apiKeyAccounts ?? {})) {
    store.set(key, { headers: credentialToHeaders(key, { kind: 'bearer', token }) });
  }

  const hasCodex = (account: string): boolean => (codexAuthStore
    ? codexAuthStore.hasCredential(account)
    : account === MAIN_ACCOUNT && Boolean(credentials.codexAccessToken));

  const codexKeys = (): string[] => [MAIN_ACCOUNT, ...codexAuthStore?.accounts() ?? []]
    .filter(hasCodex)
    .map((account) => accountCredentialKey(CODEX_CRED_KEY, account));

  return {
    has(key: string): boolean {
      if (baseCredentialKey(key) === CODEX_CRED_KEY) return hasCodex(accountOf(key));

      return store.has(key);
    },
    keys(): string[] {
      return [...store.keys(), ...codexKeys()];
    },
    async get(key: string, authOpts?: { forceRefresh?: boolean }): Promise<AuthResolution | null> {
      if (baseCredentialKey(key) !== CODEX_CRED_KEY) return store.get(key) ?? null;

      if (codexAuthStore) return codexAuthStore.getAuth(authOpts, accountOf(key));

      if (key === CODEX_CRED_KEY && credentials.codexAccessToken) {
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
