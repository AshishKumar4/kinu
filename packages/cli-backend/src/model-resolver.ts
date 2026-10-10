import { createChatModel, type LLMProviderConfig } from '@kinu.run/core';
import {
  DEFAULT_WORKERS_AI_MODEL_ID,
  credentialToHeaders,
  type OpenAICompatCredential,
  normalizeModelMenu,
  createChatGptProvider,
  accountDeps,
  specModelInfo,
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
  type ModelAffinity,
  type ModelInfo,
  cloudProxyBaseURL,
  createWireModel,
  gatewayWireModel,
  type CloudProxyProviderId,
  type ModelMenu,
  type ModelProvider,
  type ProviderDeps,
  type ProviderInfo,
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
import { Effect } from 'effect';
import { KinuError, renderThrownChain, settle } from '@kinu.run/core/obs';

const proxiedCredentialsSchema = v.object({
  credentials: v.optional(v.array(v.object({
    key: v.string(),
    baseURL: v.optional(v.string()),
    contextWindow: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    failure: v.optional(v.string()),
  })), []),
});

export interface LocalProviderCredentials {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  openrouterApiKey?: string;
  openaiCompat?: Record<string, OpenAICompatCredential>;
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
  /** `affinity`: the conversation and workspace the calls are routed and cached under (`actorAffinity`). */
  resolveModel(specOrNull: string | null | undefined, affinity: ModelAffinity): LanguageModel;
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
  withCallScope?(scope: Pick<ProviderDeps, 'accountFor' | 'onProviderWait'>): LocalModelResolver;
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
}

/**
 * The workspace LLM seam over the local registry. `route` is the turn profile's
 * model and effort; omitted = configured chat model at its own effort.
 * Only completed calls report spend: a thrown call yields no usage.
 */
export function createLocalProviderLLM(opts: LocalModelResolverConfig & {
  route?: Pick<ModelRouteResolution, 'model' | 'reasoningEffort' | 'retries'>;
  affinity: ModelAffinity;
  /** Sink and producer label together: only the consumer knows which producer
   *  a call belongs to. */
  spend: ModelCallSpend;
}): LLM {
  const resolver = createLocalModelResolver(opts);
  // Normalized per call: an unresolvable id fails at the call, not at construction.
  const spec = () => resolver.normalizeSpecSync(opts.route?.model ?? null);
  const model = (resolved: string) => resolver.resolveModel(resolved, opts.affinity);
  const spend = opts.spend;
  const { route } = opts;
  const callOptions = (resolved: string) => (route === undefined ? undefined : routedCallOptions(route, resolved));

  return {
    stream(input) {
      const resolved = spec();

      const streamed: StreamRequest = {
        model: model(resolved),
        instructions: input.system,
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
  const defaultSpec = defaultSpecForEndpoint(localEndpoint);
  const gateway = workersAiRoute(localEndpoint, cloud)?.gateway ?? null;
  const listings = cloud ? new LocalCloudListings(cloud, opts.fetch) : null;

  const menu = () => listings ? cloudAnswer<CloudMenu>(
    () => listings.menu(),
    (reason) => ({ entries: [], failures: new Map(CLOUD_PROVIDERS.map((provider) => [provider, `Could not reach your Kinu account to list its models (${reason}).`])) }),
  ) : Promise.resolve({ entries: [], failures: new Map<string, string>() });

  const cloudProvider = (readMenu: () => Promise<CloudMenu>, provider: { id: CloudProxyProviderId; label: string; unavailableReason: string; defaultModel?: string }): ModelProvider => {
    if (!cloud) return createSignedOutCloudProvider(provider.id, provider.label);

    return new CloudProxyProvider({ ...provider, cloud, menu: readMenu, fetch: opts.fetch });
  };

  const registryFor = (readMenu: () => Promise<CloudMenu>) => createModelRegistry({
    workersAi: gateway === null
      ? cloudProvider(readMenu, { id: 'workers-ai', label: 'Cloudflare Workers AI (your account)',
        unavailableReason: 'Connect Cloudflare in Account settings in the Kinu app to use Workers AI.', defaultModel: DEFAULT_WORKERS_AI_MODEL_ID })
      : createGatewayBackedProvider({
        id: 'workers-ai',
        label: 'Cloudflare Workers AI (local gateway)',
        defaultModel: gateway.model,
        llm: gateway,
        catalogProviderId: 'cloudflare-workers-ai',
        fetch: opts.fetch,
      }),
    myGateway: cloudProvider(readMenu, { id: 'my-gateway', label: 'Your AI Gateway',
      unavailableReason: 'Connect Cloudflare and pick an AI Gateway in Account settings in the Kinu app.' }),
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
    appTitle: 'Kinu CLI',
  });

  // Web-UI-connected providers resolve through the worker's proxy. A local
  // credential always wins: offline use and explicit override.
  const proxied = () => listings ? cloudAnswer<ProxiedCredentials>(
    () => listings.credentials(),
    (reason) => ({ byKey: new Map(), error: `Could not reach your Kinu account to list connected providers (${reason}).` }),
  ) : Promise.resolve({ byKey: new Map(), error: null });

  const credentialReads = (readProxy: () => Promise<ProxiedCredentials>): Pick<ProviderDeps, 'getAuth' | 'hasCredential' | 'listCredentialKeys'> => {
    const access = new LocalCredentialAccess({ authStore, cloud: cloud !== undefined, readProxy });

    return { getAuth: access.getAuth.bind(access), hasCredential: access.hasCredential.bind(access), listCredentialKeys: access.listCredentialKeys.bind(access) };
  };

  const deps: ProviderDeps = {
    env: {},
    fetch: cloud
      ? perCloudSession(proxyFetches, cloud, opts.fetch, () => createProviderProxyFetch({
        forwardURL: providerProxyForwardURL(cloud.origin), authorization: `Bearer ${cloud.token}`, fetch: opts.fetch,
      }))
      : opts.fetch,
    ...credentialReads(proxied),
  };

  const registry = registryFor(menu);

  const listingScope = (own: ProviderDeps) => {
    let menuRead: Promise<CloudMenu> | undefined;
    let proxyRead: Promise<ProxiedCredentials> | undefined;
    const readProxy = () => proxyRead ??= proxied();

    return { registry: registryFor(() => menuRead ??= menu()), deps: { ...own, ...credentialReads(readProxy) }, readProxy };
  };

  const normalizeSpecSync = (specOrNull?: string | null): string =>
    normalizeModelSpec(specOrNull, registry, { spec: defaultSpec, missing: noDefaultModelMessage() });

  const resolverWith = (own: ProviderDeps): LocalModelResolver => ({
    normalizeSpecSync,
    resolveModel(specOrNull, affinity) {
      return registry.resolve(normalizeSpecSync(specOrNull), { ...own, ...affinity });
    },
    credentialFor(specOrNull) {
      return registry.credentialFor(normalizeSpecSync(specOrNull), own);
    },
    listProviders() {
      const scope = listingScope(own);

      return scope.registry.listProviders(scope.deps);
    },
    async listModels() {
      const scope = listingScope(own);
      const listed = await scope.registry.listAllModels(scope.deps);
      const remote = await scope.readProxy();

      if (remote.error) listed.failures.push({ provider: 'connected-providers', label: 'Connected providers', reason: remote.error });

      return listed;
    },
    modelInfo(specOrNull) {
      return specModelInfo(registry, own, normalizeSpecSync(specOrNull));
    },
    async countInputTokens(specOrNull, request) {
      const spec = normalizeSpecSync(specOrNull);
      const { provider, modelId, account } = parseModelSpec(spec);

      return countRequestInputTokens(registry.get(provider), modelId, accountDeps(own, provider, account), request);
    },
    getAuth: own.getAuth,
    withCallScope(scope) {
      return resolverWith({ ...own, ...scope });
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
      // With no catalog, the configured model is all this endpoint names.
      if (!opts.catalogProviderId) return [{ id: opts.defaultModel, label: opts.defaultModel, capabilities: ['tools', 'streaming'] }];

      const prefix = opts.catalogModelPrefix ?? '';

      return mapModelList(listModelsDevProviderModels(opts.catalogProviderId, deps, {
        required: true,
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
      });
    },
  };
}

async function cloudAnswer<T>(fetchValue: () => Promise<T>, failed: (reason: string) => T): Promise<T> {
  const [fetched] = await Promise.allSettled([fetchValue()]);

  return fetched.status === 'fulfilled' ? fetched.value : failed(renderThrownChain({ cause: fetched.reason }));
}

class LocalCredentialAccess {
  constructor(private readonly source: { authStore: ReturnType<typeof buildAuthStore>; cloud: boolean; readProxy: () => Promise<ProxiedCredentials> }) {}

  getAuth(key: string, authOpts?: Parameters<AuthResolver>[1]): ReturnType<AuthResolver> {
    const { authStore, readProxy } = this.source;

    return settle(Effect.gen(function* () {
        const local = yield* Effect.promise(() => authStore.get(key, authOpts));

        if (local) return local;
        const listing = yield* Effect.promise(readProxy);

        if (listing.error) return yield* Effect.die(new Error(listing.error));
        const remote = listing.byKey.get(key);

        if (remote?.failure !== undefined) return yield* Effect.die(new Error(remote.failure));

        return remote ? proxyAuthResolution(key, remote) : null;
      }));
  }

  hasCredential(key: string): Promise<boolean> {
    const { authStore, cloud, readProxy } = this.source;

    return settle(Effect.gen(function* () {
        if (authStore.has(key)) return true;

        // A credential the proxy never fronts: the local answer is complete.
        if (isProxyDeniedCredentialKey(key) || !cloud) return false;
        const remote = yield* Effect.promise(readProxy);
        const listed = remote.byKey.get(key);

        // Connected but unreadable is that provider's failure, never an absence.
        if (listed?.failure !== undefined) return yield* Effect.die(new Error(listed.failure));

        if (listed) return true;

        // Never listed successfully: "not connected" would be a guess.
        if (remote.error) return yield* Effect.die(new Error(remote.error));

        return false;
      }));
  }

  listCredentialKeys(): Promise<string[]> {
    const { authStore, readProxy } = this.source;

    return settle(Effect.gen(function* () {
        const keys = new Set(authStore.keys());

        for (const key of (yield* Effect.promise(readProxy)).byKey.keys()) keys.add(key);

        return [...keys];
      }));
  }
}

interface CloudMenu {
  readonly entries: readonly AgentModelEntry[];
  readonly failures: ReadonlyMap<string, string>;
}

const CLOUD_PROVIDERS = ['workers-ai', 'my-gateway'] as const;

class LocalCloudListings {
  constructor(private readonly cloud: LocalCloudSession, private readonly fetchImpl: typeof fetch | undefined) {}

  menu(): Promise<CloudMenu> {
    const cloud = this.cloud;
    const baseFetch = this.fetchImpl ?? fetch;

    return settle(Effect.gen(function* () {
      const res = yield* Effect.promise(() => baseFetch(`${cloud.origin.replace(/\/+$/, '')}/api/cli/models`, {
        headers: { authorization: `Bearer ${cloud.token}`, accept: 'application/json' },
      }));

      if (!res.ok) return yield* Effect.die(new Error(`the Kinu model menu returned HTTP ${String(res.status)}`));
      const source = normalizeModelMenu({ payload: yield* Effect.promise(() => res.json()) });

      return { entries: source.models, failures: new Map(source.failures.map(({ provider, reason }) => [provider, reason])) };
    }));
  }

  credentials(): Promise<ProxiedCredentials> {
    const cloud = this.cloud;
    const baseFetch = this.fetchImpl ?? fetch;

    return settle(Effect.gen(function* () {
      const res = yield* Effect.promise(() => baseFetch(providerProxyCredentialsURL(cloud.origin), {
        headers: { authorization: `Bearer ${cloud.token}`, accept: 'application/json' },
      }));

      // A rejected session is a real answer; serving the last listing would advertise providers that 401.
      if (res.status === 401 || res.status === 403) return { byKey: new Map(), error: null };

      if (!res.ok) return yield* Effect.die(new Error(`the Kinu provider proxy returned HTTP ${String(res.status)}`));
      const body = v.parse(proxiedCredentialsSchema, yield* Effect.promise(() => res.json()));
      const byKey: ProxiedCredentials['byKey'] = new Map();

      for (const { key, failure, ...endpoint } of body.credentials) {
        if (!key) continue;

        byKey.set(key, failure === undefined ? endpoint : { failure });
      }

      return { byKey, error: null };
    }));
  }
}

interface ProxiedCredentials {
  byKey: Map<string, { baseURL?: string; contextWindow?: number; failure?: string }>;
  /** An unreadable listing, never a stale successful snapshot. */
  error: string | null;
}



/** The model id is the proxy wire id (`@cf/…` or `{author}/{model}`), so specs
 *  match the hosted backend exactly. */
class CloudProxyProvider implements ModelProvider {
  constructor(private readonly opts: {
    id: 'workers-ai' | 'my-gateway';
    label: string;
    cloud: LocalCloudSession;
    menu: () => Promise<CloudMenu>;
    defaultModel?: string;
    unavailableReason: string;
    fetch?: typeof fetch;
  }) {}

  get id() { return this.opts.id; }
  get label() { return this.opts.label; }
  get defaultModel() { return this.opts.defaultModel; }

  isAvailable() {
    const opts = this.opts;

    return settle(Effect.gen(function* () {
        const menu = yield* Effect.promise(opts.menu);
        const failure = menu.failures.get(opts.id);

        if (failure !== undefined) return yield* new KinuError('unavailable', failure);

        return menu.entries.some((entry) => entry.provider === opts.id);
    }));
  }

  async unavailableReason() {
    const opts = this.opts;

    return (await opts.menu()).failures.get(opts.id) ?? opts.unavailableReason;
  }

  async listModels(): Promise<ModelInfo[]> {
    const opts = this.opts;
    const prefix = opts.id + '/';

    return (await opts.menu()).entries
        .filter((entry) => entry.provider === opts.id)
        .map((entry) => ({
          id: entry.spec.startsWith(prefix) ? entry.spec.slice(prefix.length) : entry.spec,
          label: entry.label,
          capabilities: entry.capabilities ? [...entry.capabilities] : undefined,
          contextWindow: entry.contextWindow,
          reasoningEfforts: entry.reasoningEfforts,
        }));
  }

  // A relay: this machine's model stack retries; the worker answers each request once.
  createModel(modelId: string, deps: ProviderDeps & ModelAffinity): LanguageModel {
    const opts = this.opts;
    const baseURL = cloudProxyBaseURL(opts.cloud.origin);

    const transport = {
        baseURL,
        headers: { Authorization: `Bearer ${opts.cloud.token}`, [SESSION_AFFINITY_HEADER]: deps.sessionAffinity },
        ...(opts.fetch !== undefined && { fetch: opts.fetch }),
      };

    return opts.id === 'my-gateway'
        ? gatewayWireModel(opts.id, modelId, transport)
        : createWireModel({ name: opts.id, modelId, ...transport, protocol: 'chat-completions', reasoning: false });
  }
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
 * Where a Workers AI call from this CLI goes: the configured endpoint when it serves Workers AI (`KINU_BASE_URL`, a
 * local gateway, a Cloudflare login), else the signed-in worker's proxy, an explicit endpoint winning over it.
 * `gateway`: the endpoint, null through the proxy.
 */
export function workersAiRoute(
  llm: LLMProviderConfig | null, cloud: LocalCloudSession | undefined,
): { readonly gateway: LLMProviderConfig | null; readonly auth: AuthResolution } | null {
  const proxied = cloud !== undefined && llm !== null && llm.baseURL.replace(/\/+$/, '') === cloudProxyBaseURL(cloud.origin);

  if (llm !== null && !proxied && defaultProviderFor(llm) === 'workers-ai') {
    return { gateway: llm, auth: { baseURL: llm.baseURL, headers: llm.headers } };
  }

  if (cloud === undefined) return null;

  return { gateway: null, auth: { baseURL: cloudProxyBaseURL(cloud.origin), headers: { Authorization: `Bearer ${cloud.token}` } } };
}

/**
 * Which provider a bare model id belongs to, given the configured endpoint. The
 * adapter's one table, create path included; a copy missing rows would seed the
 * wrong provider.
 */
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
    store.set(`openai-compat.${name}`, {
      headers: credentialToHeaders(`openai-compat.${name}`, compat),
      baseURL: compat.baseURL,
      ...(compat.contextWindow !== undefined && { contextWindow: compat.contextWindow }),
    });
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

