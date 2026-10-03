import { createChatModel, type LLMProviderConfig } from '@kinu.run/core';
import {
  DEFAULT_WORKERS_AI_MODEL_ID,
  credentialToHeaders,
  normalizeModelMenu,
  createChatGptProvider,
  accountDeps,
  specModelInfo,
  createOpenAICompatProvider,
  createProviderProxyFetch,
  listModelsDevProviderModels,
  generateReported,
  mapModelList,
  streamTextReported,
  parseModelSpec,
  workersAiSpec,
  sessionAffinityOf,
  SESSION_AFFINITY_HEADER,
  createModelRegistry,
  normalizeModelSpec,
  isProxyDeniedCredentialKey,
  providerProxyCredentialsURL,
  providerProxyForwardURL,
  proxyAuthResolution,
  routedCallOptions,
  type AuthRequest,
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
  type ModelRouteResolution,
  type GenerateRequest,
  type StreamRequest,
  countRequestInputTokens,
  type CountableRequest,
  type InputTokenCount,
} from '@kinu.run/core';
import type { LanguageModel } from 'ai';
import type { LLM } from '@kinu.run/core';
import { OPENCODE_PROVIDER_ID, createOpenCodeProvider } from './opencode-provider';
import { isOAuthLoginKey, type LocalOAuthStore } from './oauth-store';
import * as v from 'valibot';
import { Cause, Effect } from 'effect';
import { diagnostics, renderThrownChain, settle } from '@kinu.run/core/obs';

const proxiedCredentialsSchema = v.object({
  credentials: v.optional(v.array(v.object({
    key: v.string(),
    baseURL: v.optional(v.string()),
    failure: v.optional(v.string()),
  })), []),
});

interface LocalOpenAICompatCredential {
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  extraHeaders?: Record<string, string>;
}

export interface LocalProviderCredentials {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  openrouterApiKey?: string;
  openaiCompat?: Record<string, LocalOpenAICompatCredential>;
  apiKeyAccounts?: Readonly<Record<string, string>>;
}

export const PROVIDER_CREDENTIAL_ENV = {
  openaiApiKey: 'OPENAI_API_KEY',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  openrouterApiKey: 'OPENROUTER_API_KEY',
} as const satisfies Record<Exclude<keyof LocalProviderCredentials, 'openaiCompat' | 'apiKeyAccounts'>, string>;

export const SESSION_CREDENTIAL_ENV = ['KINU_TOKEN', 'KINU_AUTH', 'AI_GATEWAY_AUTH'] as const;

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

type PerCloudSession<T> = Map<string, { base: typeof fetch | undefined; value: T }>;

/** One value per session + base fetch, shared by every conversation the session runs. */
function perCloudSession<T>(cache: PerCloudSession<T>, cloud: LocalCloudSession, base: typeof fetch | undefined, make: () => T): T {
  const cacheKey = `${cloud.origin} ${cloud.token}`;
  const cached = cache.get(cacheKey);

  if (cached && cached.base === base) return cached.value;
  const value = make();
  cache.set(cacheKey, { base, value });

  return value;
}

/** `getModelsDevCatalog` caches on fetch identity, so a fresh closure per resolver would re-download the catalog. */
const proxyFetches: PerCloudSession<typeof fetch> = new Map();

export interface LocalModelResolver {
  normalizeSpecSync(specOrNull?: string | null): string;
  /** `conversation`: the affinity key (`agentAffinityKey`) the calls are routed and cached under. */
  resolveModel(specOrNull: string | null | undefined, conversation: string): LanguageModel;
  credentialFor(specOrNull?: string | null): Promise<string | null>;
  listProviders(): Promise<ProviderInfo[]>;
  /** One broken credential never empties the menu. */
  listModels(): Promise<ModelMenu>;
  /** Per-model metadata (e.g. input modalities); null when unknown or unreachable. */
  modelInfo(specOrNull?: string | null): Promise<ModelInfo | null>;
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
  oauthStore?: LocalOAuthStore;
  /** When present, workers-ai + my-gateway resolve through the worker's AI proxy;
   *  when absent they list as unavailable, signed out. */
  cloud?: LocalCloudSession;
  fetch?: typeof fetch;
  /** Read per call so {@link LocalModelResolver.setProviderWaitSink} can install
   *  the session's sink after construction. */
  onProviderWait?: (info: ProviderWaitInfo) => void;
}

/**
 * The workspace LLM seam over the local registry. `route` is the turn profile's
 * model and effort; omitted = configured chat model at its own effort.
 * Only completed calls report spend: a thrown call yields no usage.
 */
export function createLocalProviderLLM(opts: LocalModelResolverConfig & {
  route?: Pick<ModelRouteResolution, 'model' | 'reasoningEffort' | 'retries'>;
  conversation: string;
  /** Sink and producer label together: only the consumer knows which producer
   *  a call belongs to. */
  spend: ModelCallSpend;
}): LLM {
  const resolver = createLocalModelResolver(opts);
  // Normalized per call: an unresolvable id fails at the call, not at construction.
  const spec = () => resolver.normalizeSpecSync(opts.route?.model ?? null);
  const model = (resolved: string) => resolver.resolveModel(resolved, opts.conversation);
  const spend = opts.spend;
  const { route } = opts;
  const callOptions = (resolved: string) => (route === undefined ? undefined : routedCallOptions(route, resolved));

  return {
    stream(input) {
      const resolved = spec();

      const streamed: StreamRequest = {
        model: model(resolved),
        system: input.system,
        messages: input.messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
        ...callOptions(resolved),
      };

      // Usage exists only once the stream drains; an abandoned stream files no row.
      return streamTextReported(streamed, { spend, spec: resolved });
    },
    async complete(prompt) {
      const resolved = spec();

      const generated: GenerateRequest = { model: model(resolved), prompt, ...callOptions(resolved) };

      return (await generateReported(generated, { spend, spec: resolved })).text.trim();
    },
  };
}

/**
 * Local provider registry: the DO backend's registry contract from local
 * config/env credentials, keeping the KINU_BASE_URL / KINU_AUTH override.
 */
export function createLocalModelResolver(opts: LocalModelResolverConfig): LocalModelResolver {
  const localEndpoint = opts.llm;
  const credentials = opts.credentials ?? {};
  const authStore = buildAuthStore(localEndpoint, credentials, opts.oauthStore);

  const cloud = opts.cloud;

  // An explicit direct endpoint takes precedence over the signed-in proxy; the
  // proxy-derived config registers through the cloud providers below.
  const llmIsCloudProxy = cloud !== undefined
    && localEndpoint !== null
    && localEndpoint.baseURL.replace(/\/+$/, '') === cloudProxyBaseURL(cloud.origin);

  const defaultSpec = defaultSpecForEndpoint(localEndpoint);
  const gateway = defaultProviderFor(localEndpoint) === 'workers-ai' && !llmIsCloudProxy ? localEndpoint : null;
  const menu = cloud ? createCloudModelMenu(cloud, opts.fetch) : null;

  const cloudProvider = (id: CloudProxyProviderId, label: string, unavailableReason: string, defaultModel?: string): ModelProvider => {
    if (!cloud || !menu) return createSignedOutCloudProvider(id, label);

    return createCloudProxyProvider({ id, label, cloud, menu, defaultModel, unavailableReason, fetch: opts.fetch });
  };

  const registry = createModelRegistry({
    workersAi: gateway === null
      ? cloudProvider('workers-ai', 'Cloudflare Workers AI (your account)',
        'Connect Cloudflare in Account settings in the Kinu app to use Workers AI.', DEFAULT_WORKERS_AI_MODEL_ID)
      : createGatewayBackedProvider({
        id: 'workers-ai',
        label: 'Cloudflare Workers AI (local gateway)',
        defaultModel: gateway.model,
        llm: gateway,
        catalogProviderId: 'cloudflare-workers-ai',
        fetch: opts.fetch,
      }),
    myGateway: cloudProvider('my-gateway', 'Your AI Gateway',
      'Connect Cloudflare and pick an AI Gateway in Account settings in the Kinu app.'),
    aiGateway: gateway === null ? undefined : createGatewayBackedProvider({
      id: 'ai-gateway',
      label: 'Cloudflare AI Gateway (local)',
      defaultModel: workersAiSpec(gateway.model),
      llm: gateway,
      catalogProviderId: 'cloudflare-workers-ai',
      catalogModelPrefix: 'workers-ai/',
      fetch: opts.fetch,
    }),
    chatgpt: createChatGptProvider(),
    codex: undefined,
    opencode: createOpenCodeProvider(),
    compat: Object.keys(credentials.openaiCompat ?? {}).sort().flatMap((name) => (name === 'default' ? []
      : [createOpenAICompatProvider(`openai-compat:${name}`)])),
    appTitle: 'Kinu CLI',
  });

  // Web-UI-connected providers resolve through the worker's proxy. A local
  // credential always wins: offline use and explicit override.
  const proxied = cloud ? perCloudSession(proxyCredentialSources, cloud, opts.fetch, () => createProxyCredentialSource(cloud, opts.fetch)) : null;

  const credentialReads: Pick<ProviderDeps, 'getAuth' | 'hasCredential' | 'listCredentialKeys'> = {
    getAuth(key, authOpts) {
      return settle(Effect.gen(function* () {
        const local = yield* Effect.promise(() => authStore.get(key, authOpts));

        if (local) return local;
        const remote = proxied ? (yield* proxied.load()).byKey.get(key) : undefined;

        if (remote?.failure !== undefined) return yield* Effect.die(new Error(remote.failure));

        return remote ? proxyAuthResolution(key, remote.baseURL) : null;
      }));
    },
    hasCredential(key) {
      return settle(Effect.gen(function* () {
        if (authStore.has(key)) return true;

        // A credential the proxy never fronts: the local answer is complete.
        if (isProxyDeniedCredentialKey(key) || !proxied) return false;
        const remote = yield* proxied.load();
        const listed = remote.byKey.get(key);

        // Connected but unreadable is that provider's failure, never an absence.
        if (listed?.failure !== undefined) return yield* Effect.die(new Error(listed.failure));

        if (listed) return true;

        // Never listed successfully: "not connected" would be a guess.
        if (remote.error) return yield* Effect.die(new Error(remote.error));

        return false;
      }));
    },
    listCredentialKeys() {
      return settle(Effect.gen(function* () {
        const keys = new Set(authStore.keys());

        for (const key of proxied ? (yield* proxied.load()).byKey.keys() : []) keys.add(key);

        return [...keys];
      }));
    },
  };

  const depsFor = (accountFor?: (providerId: string) => string | undefined): ProviderDeps => ({
    env: {},
    fetch: cloud
      ? perCloudSession(proxyFetches, cloud, opts.fetch, () => createProviderProxyFetch({
        forwardURL: providerProxyForwardURL(cloud.origin), authorization: `Bearer ${cloud.token}`, fetch: opts.fetch,
      }))
      : opts.fetch,
    ...credentialReads,
    onProviderWait: (info) => { opts.onProviderWait?.(info); },
    accountFor,
  });

  const deps = depsFor();

  const normalizeSpecSync = (specOrNull?: string | null): string =>
    normalizeModelSpec(specOrNull, registry, { spec: defaultSpec, missing: noDefaultModelMessage() });

  const resolverWith = (own: ProviderDeps): LocalModelResolver => ({
    normalizeSpecSync,
    resolveModel(specOrNull, conversation) {
      return registry.resolve(normalizeSpecSync(specOrNull), { ...own, sessionAffinity: conversation });
    },
    credentialFor(specOrNull) {
      return registry.credentialFor(normalizeSpecSync(specOrNull), own);
    },
    listProviders() {
      return registry.listProviders(own);
    },
    listModels() {
      return registry.listAllModels(own);
    },
    modelInfo(specOrNull) {
      return specModelInfo(registry, own, normalizeSpecSync(specOrNull));
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

/** A Cloudflare-shaped endpoint takes the same replica pin as the proxy path; a pin its own headers set wins. */
function withAffinity(llm: LLMProviderConfig, sessionAffinity: string): LLMProviderConfig {
  if (sessionAffinityOf(llm.headers) !== undefined) return llm;

  return { ...llm, headers: { ...llm.headers, [SESSION_AFFINITY_HEADER]: sessionAffinity } };
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

      const prefix = opts.catalogModelPrefix ?? '';

      return mapModelList(listModelsDevProviderModels(opts.catalogProviderId, deps, {
        fallback,
        preferredIds: [opts.defaultModel.replace(/^workers-ai\//, '')],
      }), (models) => models.map((model) => ({
        ...model,
        id: prefix === '' || model.id.startsWith(prefix) ? model.id : `${prefix}${model.id}`,
        capabilities: model.capabilities ? [...model.capabilities] : undefined,
      })));
    },
    createModel(modelId, deps): LanguageModel {
      return createChatModel({
        kind: 'openai-compat',
        name: opts.id,
        baseURL: opts.llm.baseURL,
        headers: withAffinity(opts.llm, deps.sessionAffinity).headers,
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
  load(): Effect.Effect<ProxiedCredentials>;
}

/** Shared across resolvers so one listing serves every conversation. */
const proxyCredentialSources: PerCloudSession<ProxyCredentialSource> = new Map();

function createProxyCredentialSource(
  cloud: LocalCloudSession,
  fetchImpl?: typeof fetch,
): ProxyCredentialSource {
  const baseFetch = fetchImpl ?? fetch;
  let cached: { at: number; value: ProxiedCredentials } | null = null;

  const load = (): Effect.Effect<ProxiedCredentials> => Effect.suspend(() => {
    const fresh = cached;

    if (fresh && Date.now() - fresh.at < PROXIED_CREDENTIALS_TTL_MS) return Effect.succeed(fresh.value);

    return Effect.catchCause(Effect.gen(function* () {
      const res = yield* Effect.promise(() => baseFetch(providerProxyCredentialsURL(cloud.origin), {
        headers: { authorization: `Bearer ${cloud.token}`, accept: 'application/json' },
      }));

      // A rejected session is a real answer; serving the last listing would advertise providers that 401.
      if (res.status === 401 || res.status === 403) {
        const value: ProxiedCredentials = { byKey: new Map(), error: null };
        cached = { at: Date.now(), value };

        return value;
      }

      if (!res.ok) return yield* Effect.die(new Error(`the Kinu provider proxy returned HTTP ${res.status}`));
      const body = v.parse(proxiedCredentialsSchema, yield* Effect.promise(() => res.json()));
      const byKey = new Map<string, { baseURL?: string; failure?: string }>();

      for (const { key, baseURL, failure } of body.credentials) {
        if (!key) continue;

        if (failure !== undefined) byKey.set(key, { failure });
        else byKey.set(key, baseURL ? { baseURL } : {});
      }

      const value: ProxiedCredentials = { byKey, error: null };
      cached = { at: Date.now(), value };

      return value;
    }), (failed) => Effect.sync((): ProxiedCredentials => cached?.value ?? {
      byKey: new Map(),
      error: `Could not reach your Kinu account to list connected providers (${renderThrownChain({ cause: Cause.squash(failed) })}).`,
    }));
  });

  return { load };
}

/** The model id is the proxy wire id (`@cf/…` or `{author}/{model}`), so specs
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
        headers: { Authorization: `Bearer ${opts.cloud.token}`, [SESSION_AFFINITY_HEADER]: deps.sessionAffinity },
        modelId,
        fetch: opts.fetch,
        onWait: deps.onProviderWait,
      });
    },
  };
}

/** Signed out: providers stay visible in /model, saying what they lack. */
function createSignedOutCloudProvider(id: CloudProxyProviderId, label: string): ModelProvider {
  const reason = "This machine isn't signed in to Kinu, so your Cloudflare account's models aren't reachable.";

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

/** Per-backend copy: the CLI and cloud lack different things. */
function noDefaultModelMessage(): string {
  return 'No default model is set, and this machine is neither signed in to Kinu nor connected to a model provider.';
}

type CliProviderId =
  | 'workers-ai' | 'chatgpt' | 'openai' | 'anthropic'
  | 'openrouter' | 'openai-compat' | 'opencode' | 'claude';

/**
 * Which provider a bare model id belongs to, given the configured endpoint. The
 * adapter's one table, create path included; a copy missing rows would seed the
 * wrong provider.
 */
/**
 * Where a Workers AI call from this CLI goes, as the resolver routes one: the configured endpoint when it serves
 * Workers AI (`KINU_BASE_URL`, a local gateway, a Cloudflare login, the proxy), else the signed-in worker's proxy.
 */
export function workersAiEndpoint(llm: LLMProviderConfig | null, cloud: LocalCloudSession | undefined): AuthResolution | null {
  if (defaultProviderFor(llm) === 'workers-ai' && llm !== null) return { baseURL: llm.baseURL, headers: llm.headers };

  return cloud === undefined ? null : { baseURL: cloudProxyBaseURL(cloud.origin), headers: { Authorization: `Bearer ${cloud.token}` } };
}

function defaultProviderFor(llm: LLMProviderConfig | null): CliProviderId | null {
  if (llm === null) return null;

  if (llm.name === 'workers-ai' || llm.model.startsWith('@cf/')) return 'workers-ai';

  if (llm.name === 'chatgpt') return 'chatgpt';

  if (llm.name === 'openai') return 'openai';

  if (llm.name === 'anthropic') return 'anthropic';

  if (llm.name === 'openrouter') return 'openrouter';

  if (llm.name === OPENCODE_PROVIDER_ID) return OPENCODE_PROVIDER_ID;

  if (llm.name === 'claude') return 'claude';

  return 'openai-compat';
}

/** Full spec a configured endpoint stands for: the seed for `actor_config.model`
 *  and the bare-id fallback. Null cues `noDefaultModelMessage()`. */
export function defaultSpecForEndpoint(llm: LLMProviderConfig | null): string | null {
  const provider = defaultProviderFor(llm);

  if (provider === null || llm === null) return null;

  // Some configs already carry the prefix; avoid `chatgpt/chatgpt/…`.
  return `${provider}/${stripProvider(llm.model, provider)}`;
}

export function stripProvider(model: string, provider: string): string {
  return model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
}

interface LocalAuthStore {
  has(key: string): boolean;
  keys(): string[];
  get(key: string, authOpts?: AuthRequest): Promise<AuthResolution | null>;
}

function buildAuthStore(
  localEndpoint: LLMProviderConfig | null,
  credentials: LocalProviderCredentials,
  oauthStore?: LocalOAuthStore,
): LocalAuthStore {
  const store = new Map<string, AuthResolution>();

  const apiKeys = {
    'openai.bearer': credentials.openaiApiKey,
    'anthropic.bearer': credentials.anthropicApiKey,
    'openrouter.bearer': credentials.openrouterApiKey,
    ...credentials.apiKeyAccounts,
  };

  for (const [key, token] of Object.entries(apiKeys)) {
    if (token) store.set(key, { headers: credentialToHeaders(key, { kind: 'bearer', token }) });
  }

  if (localEndpoint?.name === 'openai-compat') {
    store.set('openai-compat.default', {
      headers: localEndpoint.headers,
      baseURL: localEndpoint.baseURL,
    });
  }

  for (const [name, compat] of Object.entries(credentials.openaiCompat ?? {})) {
    store.set(`openai-compat.${name}`, { headers: openAiCompatHeaders(compat), baseURL: compat.baseURL });
  }

  return {
    has(key: string): boolean {
      if (isOAuthLoginKey(key)) return oauthStore?.has(key) ?? false;

      return store.has(key);
    },
    keys(): string[] {
      return [...store.keys(), ...(oauthStore?.keys() ?? [])];
    },
    async get(key: string, authOpts?: AuthRequest): Promise<AuthResolution | null> {
      if (!isOAuthLoginKey(key)) return store.get(key) ?? null;

      return oauthStore ? oauthStore.getAuth(key, authOpts) : null;
    },
  };
}

/** Core's openai-compat order (`credentialToHeaders`): the key's Authorization, then the extra headers over it. */
export function openAiCompatHeaders(compat: LocalOpenAICompatCredential) {
  const headers = { ...compat.headers };

  if (compat.apiKey) headers.Authorization = `Bearer ${compat.apiKey}`;

  return { ...headers, ...compat.extraHeaders };
}
