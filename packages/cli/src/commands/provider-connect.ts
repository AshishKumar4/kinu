/** Provider connect flows behind a port, shared by the CLI console and the TUI onboarding step; nothing here touches stdout/stdin. */
import { checkOpenCodeAvailability, createOpenCodeProvider } from '@kinu.run/cli-backend';
import {
  ANTHROPIC_DEFAULT_MODEL,
  CLAUDE_CRED_KEY,
  CLAUDE_OAUTH_CALLBACK_PORT,
  CODEX_CRED_KEY,
  MAIN_ACCOUNT,
  accountCredentialKey,
  baseCredentialKey,
  claudeCodeFrom,
  storedAccounts,
  createClaudeOAuthClient,
  createCodexOAuthClient,
  startClaudeSignIn,
  decodeCodexAccountId,
  decodeJsonValue,
  discoverOpenAICompatibleModels,
  tokensToCredential,
  type ModelInfo,
  waitForAnswer,
} from '@kinu.run/core';
import { renderThrownChain, tolerate } from '@kinu.run/core/obs';
import { listCloudCredentials, setCloudCredential } from '../cloud-api';
import {
  API_KEY_PROVIDERS,
  bumpProviderRevision,
  loadConfigFile,
  resolveCloudSession,
  updateConfigFile,
  type KinuConfig,
  type LocalApiKeyProvider,
  type LocalOAuthSession,
} from '../config';
import { adoptDefaultModel } from '../default-model';
import { readDefaultTier } from '../profiles';
import { authenticateCli, openBrowser } from './auth';
import { awaitOAuthCallback } from './oauth-callback';

export type ProviderConnectId =
  | 'cloudflare'
  | 'claude'
  | 'codex'
  | 'openai'
  | 'openrouter'
  | 'anthropic'
  | 'openai-compatible'
  | 'opencode';

export type ProviderCredentialKind = 'browser' | 'device-code' | 'api-key' | 'binary';

export interface ProviderAsk {
  readonly label: string;
  readonly fallback?: string;
  /** Never echoed. */
  readonly secret?: boolean;
}

export interface ProviderConnectPort {
  report(line: string): void;
  ask(request: ProviderAsk): Promise<string>;
  /** Null when the person skips, which aborts `work`. */
  skippable<T>(label: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | null>;
}

export type ProviderConnectOutcome =
  | { readonly kind: 'connected'; readonly summary: string; readonly detail?: string }
  | { readonly kind: 'blocked'; readonly reason: string; readonly hint: string };

export interface ProviderDescriptor {
  readonly id: ProviderConnectId;
  readonly label: string;
  readonly blurb: string;
  readonly credential: ProviderCredentialKind;
}

export interface ProviderConnectionState {
  readonly descriptor: ProviderDescriptor;
  readonly connected: boolean;
  /** The resolved model or store when connected; the connect command when not. */
  readonly detail: string;
  readonly accounts?: readonly string[];
}

export interface ProviderConnections {
  readonly states: readonly ProviderConnectionState[];
  readonly signedInEmail?: string;
  /** Account credentials no row claims (the models.dev tail connected in the web UI). */
  readonly accountExtras: readonly string[];
  /** An unreachable account is not evidence of an empty one. */
  readonly accountUnreachable?: string;
}

const INSTALL_HINT_OPENCODE = 'Install opencode: https://opencode.ai';

const LOGIN_HINT_OPENCODE = 'Sign in to opencode with `opencode auth login`, then run `kinu setup` again.';

export const PROVIDER_CONNECTORS: readonly ProviderDescriptor[] = Object.freeze(([
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    blurb: 'Sign in with your browser to use Workers AI and AI Gateway in your Cloudflare account.',
    credential: 'browser',
  },
  {
    id: 'claude',
    label: 'Claude subscription',
    blurb: 'Your Claude Pro or Max subscription. You sign in with your browser.',
    credential: 'browser',
  },
  {
    id: 'codex',
    label: 'Codex',
    blurb: 'Your ChatGPT Codex subscription. You sign in with a code in your browser.',
    credential: 'device-code',
  },
  { id: 'openai', label: 'OpenAI', blurb: 'An OpenAI API key.', credential: 'api-key' },
  { id: 'openrouter', label: 'OpenRouter', blurb: 'An OpenRouter API key.', credential: 'api-key' },
  { id: 'anthropic', label: 'Anthropic', blurb: 'An Anthropic API key.', credential: 'api-key' },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    blurb: 'Any endpoint that speaks the OpenAI API: Ollama, vLLM, or your own proxy.',
    credential: 'api-key',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    blurb: 'Uses the providers and sign-ins from the opencode CLI on this computer.',
    credential: 'binary',
  },
] satisfies readonly ProviderDescriptor[]).map((descriptor) => Object.freeze(descriptor)));

const NAMED_ACCOUNT_KEYS: Readonly<Record<string, true>> = Object.freeze({
  'openai.bearer': true,
  'openrouter.bearer': true,
  'anthropic.bearer': true,
  'openai-compat.default': true,
  'cloudflare.oauth': true,
  'cloudflare.ai-gateway': true,
  'codex.oauth': true,
  'claude.oauth': true,
});

/** A local key wins at resolution, so both stores are read before a row says "connected". */
const ACCOUNT_CREDENTIAL_KEYS: Readonly<Record<string, string>> = Object.freeze({
  openai: 'openai.bearer',
  openrouter: 'openrouter.bearer',
  anthropic: 'anthropic.bearer',
  'openai-compatible': 'openai-compat.default',
});

interface ConnectionFacts {
  readonly providers: NonNullable<KinuConfig['providers']>;
  readonly heldKeys: readonly string[];
  readonly defaultModel: string | undefined;
}

function namedAccounts(baseKey: string, localNames: readonly string[], facts: ConnectionFacts): string[] {
  return [...new Set([...localNames, ...storedAccounts(baseKey, facts.heldKeys)])]
    .filter((name) => name !== MAIN_ACCOUNT)
    .sort();
}

function loginState(descriptor: ProviderDescriptor & { readonly id: 'codex' | 'claude' }, facts: ConnectionFacts): ProviderConnectionState {
  const login = facts.providers[descriptor.id];
  const accounts = namedAccounts(descriptor.id === 'codex' ? CODEX_CRED_KEY : CLAUDE_CRED_KEY, Object.keys(login?.accounts ?? {}), facts);

  if (login?.accessToken === undefined && login?.refreshToken === undefined && accounts.length === 0) {
    return { descriptor, connected: false, detail: `kinu provider connect ${descriptor.id}` };
  }

  return { descriptor, connected: true, detail: currentModel(facts.defaultModel, descriptor.id) ?? 'your subscription', accounts };
}

function apiKeyState(
  descriptor: ProviderDescriptor & { readonly id: ApiKeyProviderId | 'openai-compatible' },
  facts: ConnectionFacts,
): ProviderConnectionState {
  const id = descriptor.id;
  const credKey = ACCOUNT_CREDENTIAL_KEYS[id];
  const model = currentModel(facts.defaultModel, id === 'openai-compatible' ? 'openai-compat' : id);
  const accounts = id === 'openai-compatible' ? [] : namedAccounts(API_KEY_PROVIDERS[id], Object.keys(facts.providers[id]?.accounts ?? {}), facts);
  const local = localApiKey(facts.providers, id);

  if (local || (credKey !== undefined && facts.heldKeys.includes(credKey))) {
    return { descriptor, connected: true, detail: [model, local ? 'this machine' : 'your account'].filter(Boolean).join(' · '), accounts };
  }

  return accounts.length > 0
    ? { descriptor, connected: true, detail: 'no main account', accounts }
    : { descriptor, connected: false, detail: `kinu provider connect ${id}` };
}

export async function readProviderConnections(): Promise<ProviderConnections> {
  const config = loadConfigFile();
  const account = await accountCredentials();
  const held = 'credentials' in account ? account.credentials : [];
  const providers = config.providers ?? {};
  const defaultModel = readDefaultTier()?.model;
  const opencode = await checkOpenCodeAvailability();
  const heldKeys = held.map((credential) => credential.key);
  const facts: ConnectionFacts = { providers, heldKeys, defaultModel };

  const states = PROVIDER_CONNECTORS.map((descriptor): ProviderConnectionState => {
    const hint = `kinu provider connect ${descriptor.id}`;

    switch (descriptor.id) {
      case 'cloudflare':
        return config.accessToken === undefined
          ? { descriptor, connected: false, detail: hint }
          : { descriptor, connected: true, detail: config.user?.email ?? 'your account' };
      case 'claude':
      case 'codex': return loginState({ ...descriptor, id: descriptor.id }, facts);
      case 'opencode':
        if (opencode.binary && opencode.authenticated) {
          return { descriptor, connected: true, detail: currentModel(defaultModel, 'opencode') ?? 'your opencode install' };
        }

        return { descriptor, connected: false, detail: opencode.binary ? LOGIN_HINT_OPENCODE : hint };
      case 'openai':
      case 'openrouter':
      case 'anthropic':
      case 'openai-compatible': return apiKeyState({ ...descriptor, id: descriptor.id }, facts);
    }
  });

  const extras = [...new Set(heldKeys.map(baseCredentialKey))].filter((key) => NAMED_ACCOUNT_KEYS[key] !== true);

  const connections: ProviderConnections = {
    states,
    signedInEmail: config.user?.email,
    accountExtras: extras,
  };

  if (!('unreachable' in account)) return connections;

  return { ...connections, accountUnreachable: account.unreachable };
}

type AccountCredentials =
  | { readonly credentials: readonly { readonly key: string }[] }
  | { readonly signedOut: true }
  | { readonly unreachable: string };

async function accountCredentials(): Promise<AccountCredentials> {
  const cloud = resolveCloudSession();

  if (!cloud) return { signedOut: true };

  try {
    return { credentials: await listCloudCredentials(cloud.origin, cloud.token) };
  } catch (error) {
    return { unreachable: renderThrownChain({ cause: error }) };
  }
}

function localApiKey(providers: NonNullable<KinuConfig['providers']>, id: ProviderConnectId): boolean {
  switch (id) {
    case 'openai': return providers.openai?.apiKey !== undefined;
    case 'openrouter': return providers.openrouter?.apiKey !== undefined;
    case 'anthropic': return providers.anthropic?.apiKey !== undefined;
    case 'openai-compatible': return providers.openaiCompat?.default !== undefined;
    case 'cloudflare':
    case 'claude':
    case 'codex':
    case 'opencode':
      return false;
  }
}

function currentModel(model: string | undefined, prefix: string): string | undefined {
  if (!model?.startsWith(`${prefix}/`)) return undefined;

  return model.slice(prefix.length + 1);
}

export type ApiKeyProviderId = keyof typeof API_KEY_PROVIDERS;

const API_KEY_CONNECTORS: Readonly<Record<ApiKeyProviderId, { readonly label: string; readonly defaultModel: string }>> = {
  openai: { label: 'OpenAI', defaultModel: 'gpt-4o-mini' },
  openrouter: { label: 'OpenRouter', defaultModel: 'openai/gpt-4o-mini' },
  anthropic: { label: 'Anthropic', defaultModel: 'claude-sonnet-4-5' },
};

export function holdsAccounts(id: string): id is ApiKeyProviderId | 'codex' | 'claude' {
  return id === 'codex' || id === 'claude' || id in API_KEY_PROVIDERS;
}

/** Stores and answers `connected`, or stores nothing and answers `blocked`; failures the person cannot act on throw. */
export async function connectProvider(
  id: ProviderConnectId,
  port: ProviderConnectPort,
  opts: { readonly origin?: string; readonly model?: string; readonly local?: boolean; readonly account?: string } = {},
): Promise<ProviderConnectOutcome> {
  const account = opts.account ?? MAIN_ACCOUNT;

  if (account !== MAIN_ACCOUNT && !holdsAccounts(id)) {
    return { kind: 'blocked', reason: `${id} holds one account here.`, hint: 'Accounts are for openai, openrouter, anthropic, codex and claude.' };
  }

  switch (id) {
    case 'cloudflare': return await connectCloudflare(port, opts.origin);
    case 'claude': return await connectClaude(port, opts.model, account);
    case 'codex': return await connectCodex(port, opts.model, account);
    case 'opencode': return await connectOpenCode(port, opts.model);
    case 'openai':
    case 'openrouter':
    case 'anthropic':
      return await connectApiKeyProvider(port, {
        ...API_KEY_CONNECTORS[id],
        prefix: id,
        credKey: accountCredentialKey(API_KEY_PROVIDERS[id], account),
        account,
        model: opts.model,
        local: opts.local ?? false,
        store: (key) => updateConfigFile((config) => withLocalApiKey(config, id, account, key)),
        clear: () => updateConfigFile((config) => withLocalApiKey(config, id, account, null)),
      });
    case 'openai-compatible': return await connectOpenAiCompatible(port, opts.model, opts.local ?? false);
  }
}

function withLocalApiKey(config: KinuConfig, id: ApiKeyProviderId, account: string, key: string | null): KinuConfig {
  const next: LocalApiKeyProvider = { ...config.providers?.[id] };
  const accounts = { ...next.accounts };

  if (account !== MAIN_ACCOUNT) {
    delete accounts[account];

    if (key !== null) accounts[account] = { apiKey: key };
    next.accounts = accounts;
  } else if (key === null) {
    delete next.apiKey;
  } else {
    next.apiKey = key;
  }

  return withProvider(config, { [id]: next });
}

async function connectCloudflare(port: ProviderConnectPort, origin: string | undefined): Promise<ProviderConnectOutcome> {
  port.report('On the Cloudflare consent page, keep the User Details, Account Settings, Workers AI and AI Gateway scopes ticked.');
  let email = 'your Cloudflare account';
  await authenticateCli(origin === undefined ? {} : { origin }, {
    started(flow) {
      port.report(`Open: ${flow.verificationUrl}`);
      port.report(`Code: ${flow.userCode}`);
    },
    completed(address) {
      email = address;
    },
  });

  return { kind: 'connected', summary: `Signed in as ${email}` };
}

async function connectClaude(port: ProviderConnectPort, requestedModel: string | undefined, account: string): Promise<ProviderConnectOutcome> {
  const answered = account === MAIN_ACCOUNT
    ? requestedModel ?? await port.ask({ label: 'Default Claude model', fallback: currentModel(readDefaultTier()?.model, 'claude') ?? ANTHROPIC_DEFAULT_MODEL })
    : null;

  const credential = await runClaudeSignIn(port);
  updateConfigFile((next) => withOAuthSession(next, 'claude', account, credential));

  if (answered === null) return { kind: 'connected', summary: `Connected the Claude account ${account}`, detail: accountDetail('claude', account) };

  return { kind: 'connected', summary: 'Connected your Claude subscription', detail: defaultModelDetail(`claude/${answered.replace(/^claude\//, '')}`) };
}

/** The browser returns to this machine; where it cannot, the person pastes what Claude showed them. */
async function runClaudeSignIn(port: ProviderConnectPort): Promise<LocalOAuthSession> {
  const signIn = await startClaudeSignIn();

  port.report(`Open: ${signIn.url}`);

  const code = await port.skippable('Waiting for Claude to send your browser back here.', (signal) => {
    const returned = awaitOAuthCallback(CLAUDE_OAUTH_CALLBACK_PORT, signIn.state, signal);

    openBrowser(signIn.url);

    return returned;
  });

  const pasted = code ?? claudeCodeFrom(await port.ask({ label: 'Paste the code Claude showed you, or the address it sent you to', secret: true }), signIn.state);

  return createClaudeOAuthClient().exchange(signIn, pasted);
}

async function connectCodex(port: ProviderConnectPort, requestedModel: string | undefined, account: string): Promise<ProviderConnectOutcome> {
  if (account !== MAIN_ACCOUNT) {
    const credential = await runCodexDeviceFlow(port);
    updateConfigFile((next) => withOAuthSession(next, 'codex', account, credential));

    return { kind: 'connected', summary: `Connected the ChatGPT Codex account ${account}`, detail: accountDetail('codex', account) };
  }

  const current = currentModel(readDefaultTier()?.model, 'codex') ?? 'gpt-5.5';
  const answered = requestedModel ?? await port.ask({ label: 'Default Codex model', fallback: current });
  const model = answered.startsWith('codex/') ? answered.slice('codex/'.length) : answered;
  const credential = await runCodexDeviceFlow(port);
  updateConfigFile((next) => withOAuthSession(next, 'codex', MAIN_ACCOUNT, credential));

  return { kind: 'connected', summary: 'Connected ChatGPT Codex subscription', detail: defaultModelDetail(`codex/${model}`) };
}

function withOAuthSession(config: KinuConfig, issuer: 'codex' | 'claude', account: string, credential: LocalOAuthSession): KinuConfig {
  const stored = config.providers?.[issuer] ?? {};

  const session: LocalOAuthSession = {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAt: credential.expiresAt,
    metadata: credential.metadata,
  };

  return withProvider(config, {
    [issuer]: account === MAIN_ACCOUNT ? { ...stored, ...session } : { ...stored, accounts: { ...stored.accounts, [account]: session } },
  });
}

function accountDetail(provider: string, account: string): string {
  return `Use it with ${provider}@${account}/<model>, or make it the default: kinu provider default ${provider} ${account}`;
}

async function runCodexDeviceFlow(port: ProviderConnectPort) {
  const client = createCodexOAuthClient();
  const flow = await client.startDeviceFlow();
  port.report(`Open: ${flow.portalURL}`);
  port.report(`Code: ${flow.userCode}`);
  openBrowser(flow.portalURL);

  // No clock: the provider's own expired answer ends the wait.
  const probe = async () => {
    const poll = await client.pollDeviceFlow(flow.deviceAuthId, flow.userCode);

    return poll.status === 'pending' ? undefined : poll;
  };

  const outcome = await waitForAnswer(probe, {
    intervalMs: Math.max(3, flow.pollIntervalSec) * 1000,
    onWaiting: () => port.report('Waiting for approval…'),
  });

  if (outcome.status === 'expired' || outcome.status === 'denied') throw new Error(outcome.message);
  const credential = tokensToCredential(outcome.tokens);
  const accountId = decodeCodexAccountId(credential.accessToken);

  return {
    ...credential,
    metadata: accountId ? { accountId } : credential.metadata,
  };
}

interface ApiKeyProvider {
  readonly label: string;
  readonly prefix: string;
  readonly credKey: string;
  readonly account: string;
  readonly defaultModel: string;
  readonly model: string | undefined;
  readonly local: boolean;
  store(key: string): void;
  clear: () => void;
}

async function connectApiKeyProvider(port: ProviderConnectPort, provider: ApiKeyProvider): Promise<ProviderConnectOutcome> {
  const named = provider.account !== MAIN_ACCOUNT;
  const key = await port.ask({ label: `${provider.label} API key${named ? ` for ${provider.account}` : ''}`, secret: true });

  if (key.trim() === '') {
    return { kind: 'blocked', reason: `No ${provider.label} key was given.`, hint: `Run kinu provider connect ${provider.prefix} when you have one.` };
  }

  if (named) {
    const where = await storeProviderSecret({
      local: provider.local,
      credKey: provider.credKey,
      credential: { kind: 'bearer', token: key },
      storeLocally: () => provider.store(key),
      clearLocally: provider.clear,
    });

    return {
      kind: 'connected',
      summary: `Added the ${provider.label} account ${provider.account} to ${where === 'account' ? 'your Kinu account' : 'this machine'}.`,
      detail: accountDetail(provider.prefix, provider.account),
    };
  }

  const current = currentModel(readDefaultTier()?.model, provider.prefix) ?? provider.defaultModel;

  const model = provider.model ?? await port.ask({ label: 'Default model', fallback: current });
  const spec = `${provider.prefix}/${model}`;

  const where = await storeProviderSecret({
    local: provider.local,
    credKey: provider.credKey,
    credential: { kind: 'bearer', token: key },
    storeLocally: () => provider.store(key),
    clearLocally: provider.clear,
  });

  return {
    kind: 'connected',
    summary: where === 'account'
      ? `Connected ${provider.label} to your Kinu account. No key stored on this machine.`
      : `Saved ${provider.label} credentials to this machine.`,
    detail: defaultModelDetail(spec),
  };
}

async function connectOpenAiCompatible(port: ProviderConnectPort, requestedModel: string | undefined, local: boolean): Promise<ProviderConnectOutcome> {
  const baseURL = await port.ask({ label: 'Base URL', fallback: 'http://localhost:11434/v1' });
  const apiKey = await port.ask({ label: 'API key (use any non-empty value for local servers)', fallback: 'local', secret: true });
  const model = requestedModel ?? await askEndpointModel(port, baseURL, apiKey);

  if (model === '') {
    return {
      kind: 'blocked',
      reason: `No model named, and ${baseURL} lists none at /models.`,
      hint: 'Connect again and type the id of a model your server serves.',
    };
  }

  const spec = `openai-compat/${model}`;

  const where = await storeProviderSecret({
    local,
    credKey: 'openai-compat.default',
    credential: { kind: 'openai-compat', baseURL, apiKey },
    storeLocally: () => updateConfigFile((config) => withProvider(config, { openaiCompat: { default: { baseURL, apiKey } } })),
    clearLocally: () => updateConfigFile((config) => { delete config.providers?.openaiCompat?.default; }),
    // Usually Ollama or vLLM on this machine; the proxy is https-only and a Worker cannot reach loopback.
    endpoint: baseURL,
  });

  return {
    kind: 'connected',
    summary: where === 'account'
      ? 'Connected the OpenAI-compatible endpoint to your Kinu account. No key stored on this machine.'
      : 'Saved the OpenAI-compatible endpoint credentials to this machine.',
    detail: defaultModelDetail(spec),
  };
}

async function askEndpointModel(port: ProviderConnectPort, baseURL: string, apiKey: string): Promise<string> {
  let listed: ModelInfo[] = [];

  try {
    const auth = { baseURL, headers: { Authorization: `Bearer ${apiKey}` } };
    listed = await port.skippable(`Checking ${baseURL}/models…`, (signal) => discoverOpenAICompatibleModels(auth, fetch, signal)) ?? [];
  } catch (cause) {
    port.report(`Could not list the models at ${baseURL}: ${renderThrownChain({ cause })}`);
  }

  if (listed.length > 0) port.report(`${baseURL} serves: ${listed.map((entry) => entry.id).join(', ')}`);
  const first = listed[0];
  const answer = await port.ask(first === undefined ? { label: 'Default model' } : { label: 'Default model', fallback: first.id });

  return answer.trim();
}

async function connectOpenCode(port: ProviderConnectPort, requestedModel: string | undefined): Promise<ProviderConnectOutcome> {
  port.report('Reading your opencode auth and model configuration.');
  const available = await checkOpenCodeAvailability();

  if (!available.binary) return { kind: 'blocked', reason: 'opencode CLI not found.', hint: INSTALL_HINT_OPENCODE };

  if (!available.authenticated) return { kind: 'blocked', reason: 'opencode is not authenticated.', hint: LOGIN_HINT_OPENCODE };
  let model = requestedModel ?? '';

  if (model === '') {
    const provider = createOpenCodeProvider();

    let models;

    try {
      models = await provider.listModels({ env: {}, getAuth: async () => null, hasCredential: async () => false });
    } catch (error) {
      return {
        kind: 'blocked',
        reason: `Could not read opencode models: ${renderThrownChain({ cause: error })}`,
        hint: LOGIN_HINT_OPENCODE,
      };
    }

    const first = models[0];

    if (first === undefined) {
      return { kind: 'blocked', reason: 'No models found in your opencode configuration.', hint: LOGIN_HINT_OPENCODE };
    }

    model = first.id;
  }

  updateConfigFile((config) => withProvider(config, {}));

  return {
    kind: 'connected',
    summary: 'Connected OpenCode',
    detail: `${defaultModelDetail(`opencode/${model}`)} Kinu reads models and auth from your local opencode install at request time.`,
  };
}

/** Signed in: the account (sealed, reachable via the provider proxy). Otherwise, or with `--local`, this machine. */
async function storeProviderSecret(opts: {
  local: boolean;
  credKey: string;
  credential: unknown;
  storeLocally: () => void;
  /** Runs after an account write: a local key wins at resolution and would shadow it. */
  clearLocally: () => void;
  /** An endpoint the proxy cannot reach (loopback, private range, plain http) forces local storage. */
  endpoint?: string;
}): Promise<'account' | 'local'> {
  const reachable = opts.endpoint === undefined || reachableFromTheInternet(opts.endpoint);
  const cloud = opts.local || !reachable ? null : resolveCloudSession();

  if (!cloud) {
    opts.storeLocally();

    return 'local';
  }

  try {
    await setCloudCredential(cloud.origin, cloud.token, opts.credKey, decodeJsonValue({ value: opts.credential }));
  } catch (err) {
    // No fallback to disk: the user asked for account storage.
    throw new Error(
      `Your Kinu account did not accept the key (${renderThrownChain({ cause: err })}). `
      + 'Nothing was saved. Try again, or re-run with --local to keep the key on this machine.',
      { cause: err },
    );
  }

  opts.clearLocally();
  bumpProviderRevision();

  return 'account';
}

/** https, and not a loopback, private, link-local, IPv6 ULA or CGNAT host. */
function reachableFromTheInternet(baseURL: string): boolean {
  const url = tolerate(() => new URL(baseURL), 'malformed-input');

  if (!url) return false;

  if (url.protocol !== 'https:') return false;
  const hostname = url.hostname;
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (isIPv6Ula(host) || isCgnat(host)) return false;

  return !/^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname);
}

/** fc00::/7 */
function isIPv6Ula(host: string): boolean {
  if (!host.includes(':')) return false;
  const first = Number.parseInt(host.split(':')[0] ?? '', 16);

  if (!Number.isFinite(first)) return false;
  const top = first >>> 8;

  return top === 0xfc || top === 0xfd;
}

/** 100.64.0.0/10 */
function isCgnat(host: string): boolean {
  const octets = host.split('.');

  if (octets.length !== 4 || octets.some((o) => !/^\d+$/.test(o))) return false;
  const [first, second] = octets.map(Number);

  return first === 100 && (second ?? 0) >= 64 && (second ?? 0) <= 127;
}

/** Every local provider write goes through here, so the provider revision bump cannot be skipped. */
function withProvider(config: KinuConfig, providers: NonNullable<KinuConfig['providers']>): KinuConfig {
  return {
    ...config,
    providerRevision: (config.providerRevision ?? 0) + 1,
    providers: {
      ...config.providers,
      ...providers,
      openaiCompat: {
        ...config.providers?.openaiCompat,
        ...providers.openaiCompat,
      },
    },
  };
}

function defaultModelDetail(spec: string): string {
  const current = adoptDefaultModel(spec)?.model;

  if (current === spec) return `Default model: ${spec}`;

  if (current === undefined) return `${spec} is connected; your account's default model is unchanged.`;

  return `Default model stays ${current}; to use ${spec}, pick it under Defaults on kinu's home screen.`;
}
