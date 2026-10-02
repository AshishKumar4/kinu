/** Provider connect flows behind a port, shared by the CLI console and the TUI onboarding step; nothing here touches stdout/stdin. */
import { Effect } from 'effect';
import { checkOpenCodeAvailability, createOpenCodeProvider } from '@kinu.run/cli-backend';
import {
  ANTHROPIC_DEFAULT_MODEL,
  CHATGPT_CRED_KEY,
  CHATGPT_DEFAULT_MODEL,
  CHATGPT_USAGE_URL,
  CLAUDE_CRED_KEY,
  CLAUDE_OAUTH_CALLBACK_PORT,
  MAIN_ACCOUNT,
  accountCredentialKey,
  baseCredentialKey,
  claudeCodeFrom,
  storedAccounts,
  createChatGptProvider,
  createClaudeOAuthClient,
  listAnthropicModels,
  settleModelList,
  startClaudeSignIn,
  decodeJsonValue,
  discoverOpenAICompatibleModels,
  type ModelInfo,
} from '@kinu.run/core';
import { renderThrownChain, tolerate, settle } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { beginSignIn, deviceRegistration, planEnabled, registrationOf, type SiwcRecord } from '../../../pc-agent/src/chatgpt.js';
import { listCloudCredentials, setCloudCredential } from '../cloud-api';
import {
  AGENT_HOME,
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
  | 'chatgpt'
  | 'openai'
  | 'openrouter'
  | 'anthropic'
  | 'openai-compatible'
  | 'opencode';

interface ProviderAsk {
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

interface ProviderDescriptor {
  readonly id: ProviderConnectId;
  readonly label: string;
  readonly blurb: string;
}

export interface ProviderConnectionState {
  readonly descriptor: ProviderDescriptor;
  readonly connected: boolean;
  /** The resolved model or store when connected; the connect command when not. */
  readonly detail: string;
  readonly accounts?: readonly string[];
}

interface ProviderConnections {
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
  },
  {
    id: 'claude',
    label: 'Claude subscription',
    blurb: 'Your Claude Pro or Max subscription. You sign in with your browser.',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    blurb: 'Your ChatGPT plan. You continue with ChatGPT in your browser, and eligible requests use your plan.',
  },
  { id: 'openai', label: 'OpenAI', blurb: 'An OpenAI API key.' },
  { id: 'openrouter', label: 'OpenRouter', blurb: 'An OpenRouter API key.' },
  { id: 'anthropic', label: 'Anthropic', blurb: 'An Anthropic API key.' },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    blurb: 'Any endpoint that speaks the OpenAI API: Ollama, vLLM, or your own proxy.',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    blurb: 'Uses the providers and sign-ins from the opencode CLI on this computer.',
  },
] satisfies readonly ProviderDescriptor[]).map((descriptor) => Object.freeze(descriptor)));

const NAMED_ACCOUNT_KEYS: Readonly<Record<string, true>> = Object.freeze({
  'openai.bearer': true,
  'openrouter.bearer': true,
  'anthropic.bearer': true,
  'openai-compat.default': true,
  'cloudflare.oauth': true,
  'cloudflare.ai-gateway': true,
  'chatgpt.oauth': true,
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

/** A login that kept only its registration holds none. */
function holdsTokens(login: LocalOAuthSession | undefined): boolean {
  return login?.accessToken !== undefined || login?.refreshToken !== undefined;
}

/** A sign-in whose grant left out plan usage, which a signed-out registration is not. */
function chatgptPlanDeclined(metadata: LocalOAuthSession['metadata']): boolean {
  const grant = v.safeParse(v.object({ scopes: v.array(v.string()) }), metadata);

  return grant.success && !planEnabled(grant.output);
}

function loginState(descriptor: ProviderDescriptor & { readonly id: 'chatgpt' | 'claude' }, facts: ConnectionFacts): ProviderConnectionState {
  const login = facts.providers[descriptor.id];
  const signedIn = Object.entries(login?.accounts ?? {}).flatMap(([name, entry]) => (holdsTokens(entry) ? [name] : []));
  const accounts = namedAccounts(descriptor.id === 'chatgpt' ? CHATGPT_CRED_KEY : CLAUDE_CRED_KEY, signedIn, facts);

  if (!holdsTokens(login) && accounts.length === 0) {
    const registration = descriptor.id === 'chatgpt' ? registrationOf(login?.metadata) : null;

    if (registration === null) return { descriptor, connected: false, detail: `kinu provider connect ${descriptor.id}` };
    const state = chatgptPlanDeclined(login?.metadata) ? 'signed in without ChatGPT plan usage' : 'signed out';

    return { descriptor, connected: false, detail: `${registration.email ?? 'your ChatGPT account'} ${state}: kinu provider connect chatgpt` };
  }

  const model = currentModel(facts.defaultModel, descriptor.id);

  // OpenAI's wording (SIWC UI guidelines).
  if (descriptor.id === 'chatgpt') return { descriptor, connected: true, detail: [model, `Using ChatGPT plan · Manage usage: ${CHATGPT_USAGE_URL}`].filter(Boolean).join(' · '), accounts };

  return { descriptor, connected: true, detail: model ?? 'your subscription', accounts };
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
      case 'chatgpt': return loginState({ ...descriptor, id: descriptor.id }, facts);
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
    case 'chatgpt':
    case 'opencode':
      return false;
  }
}

function currentModel(model: string | undefined, prefix: string): string | undefined {
  if (!model?.startsWith(`${prefix}/`)) return undefined;

  return model.slice(prefix.length + 1);
}

type ApiKeyProviderId = keyof typeof API_KEY_PROVIDERS;

const API_KEY_CONNECTORS: Readonly<Record<ApiKeyProviderId, { readonly label: string; readonly defaultModel: string }>> = {
  openai: { label: 'OpenAI', defaultModel: 'gpt-4o-mini' },
  openrouter: { label: 'OpenRouter', defaultModel: 'openai/gpt-4o-mini' },
  anthropic: { label: 'Anthropic', defaultModel: 'claude-sonnet-4-5' },
};

export function holdsAccounts(id: string): id is ApiKeyProviderId | 'chatgpt' | 'claude' {
  return id === 'chatgpt' || id === 'claude' || id in API_KEY_PROVIDERS;
}

/** Stores and answers `connected`, or stores nothing and answers `blocked`; failures the person cannot act on throw. */
export function connectProvider(
  id: ProviderConnectId,
  port: ProviderConnectPort,
  opts: { readonly origin?: string; readonly model?: string; readonly local?: boolean; readonly account?: string } = {},
): Promise<ProviderConnectOutcome> {
  return settle(Effect.gen(function* () {
    const account = opts.account ?? MAIN_ACCOUNT;

    if (account !== MAIN_ACCOUNT && !holdsAccounts(id)) {
      return { kind: 'blocked', reason: `${id} holds one account here.`, hint: 'Accounts are for openai, openrouter, anthropic, chatgpt and claude.' };
    }

    switch (id) {
      case 'cloudflare': return yield* Effect.promise(async () => connectCloudflare(port, opts.origin));
      case 'claude': return yield* Effect.promise(async () => connectClaude(port, opts.model, account));
      case 'chatgpt': return yield* Effect.promise(async () => connectChatGpt(port, opts.model, account));
      case 'opencode': return yield* Effect.promise(async () => connectOpenCode(port, opts.model));
      case 'openai':
      case 'openrouter':
      case 'anthropic':
        return yield* connectApiKeyProvider(port, {
          ...API_KEY_CONNECTORS[id],
          prefix: id,
          credKey: accountCredentialKey(API_KEY_PROVIDERS[id], account),
          account,
          model: opts.model,
          local: opts.local ?? false,
          store: async (key) => { await updateConfigFile((config) => withLocalApiKey(config, id, account, key)); },
          clear: async () => { await updateConfigFile((config) => withLocalApiKey(config, id, account, null)); },
        });
      case 'openai-compatible': return yield* Effect.promise(async () => connectOpenAiCompatible(port, opts.model, opts.local ?? false));
    }
  }));
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

/** The stored default only while Claude serves it. */
async function suggestedClaudeModel(): Promise<string> {
  const current = currentModel(readDefaultTier()?.model, 'claude');

  if (current === undefined) return ANTHROPIC_DEFAULT_MODEL;
  // Offline, the built-in list stands in, as it does for a turn.
  const { models: served } = await settleModelList(listAnthropicModels({ fetch }));

  return served.some((model) => model.id === current) ? current : ANTHROPIC_DEFAULT_MODEL;
}

async function connectClaude(port: ProviderConnectPort, requestedModel: string | undefined, account: string): Promise<ProviderConnectOutcome> {
  const answered = account === MAIN_ACCOUNT
    ? requestedModel ?? await port.ask({ label: 'Default Claude model', fallback: await suggestedClaudeModel() })
    : null;

  const credential = await runClaudeSignIn(port);
  await updateConfigFile((next) => withOAuthSession(next, 'claude', account, credential));

  if (answered === null) return { kind: 'connected', summary: `Connected the Claude account ${account}`, detail: accountDetail('claude', account) };

  return { kind: 'connected', summary: 'Connected your Claude subscription', detail: await defaultModelDetail(`claude/${answered.replace(/^claude\//, '')}`) };
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

/** Sign in with ChatGPT here, reusing the account's saved client ID (or, first, the daemon's). */
async function connectChatGpt(port: ProviderConnectPort, requestedModel: string | undefined, account: string): Promise<ProviderConnectOutcome> {
  const stored = loadConfigFile().providers?.chatgpt;
  const saved = account === MAIN_ACCOUNT ? stored : stored?.accounts?.[account];
  const registration = registrationOf(saved?.metadata) ?? (account === MAIN_ACCOUNT ? deviceRegistration(AGENT_HOME) : null);

  const result = await port.skippable('Waiting for you to continue with ChatGPT in your browser.', async (signal) => {
    const flow = await beginSignIn({ home: AGENT_HOME, registration, consent: chatgptPlanDeclined(saved?.metadata), signal });

    port.report(`Continue with ChatGPT: ${flow.authorizeUrl}`);
    openBrowser(flow.authorizeUrl);

    return flow.done;
  });

  if (result === null) return { kind: 'blocked', reason: 'The ChatGPT sign-in was skipped.', hint: 'Run kinu provider connect chatgpt when you want to use your ChatGPT plan.' };

  if (result.outcome === 'declined') return { kind: 'blocked', reason: 'You cancelled the ChatGPT sign-in.', hint: 'Run kinu provider connect chatgpt to try again.' };
  await updateConfigFile((next) => withOAuthSession(next, 'chatgpt', account, chatgptSession(result.record)));

  if (result.outcome === 'plan-disabled') {
    return {
      kind: 'blocked',
      reason: `Signed in as ${result.record.email ?? 'your ChatGPT account'}, but ChatGPT plan usage was not granted, so Kinu cannot use your plan.`,
      hint: 'Run kinu provider connect chatgpt to enable it, or connect another provider such as an OpenAI API key (kinu provider connect openai).',
    };
  }

  // OpenAI's first-use confirmation.
  if (result.registered) port.report(`You're using your ChatGPT plan. Eligible requests in Kinu now use it. Manage usage: ${CHATGPT_USAGE_URL}`);

  if (account !== MAIN_ACCOUNT) {
    return { kind: 'connected', summary: `Connected the ChatGPT account ${account} (${result.record.email ?? 'signed in'})`, detail: accountDetail('chatgpt', account) };
  }

  const model = requestedModel ?? await port.ask({ label: 'Default ChatGPT model', fallback: await suggestedChatGptModel(port, result.record.accessToken ?? '') });

  return { kind: 'connected', summary: `Connected your ChatGPT plan as ${result.record.email ?? 'your ChatGPT account'}`, detail: await defaultModelDetail(`chatgpt/${model.replace(/^chatgpt\//, '')}`) };
}

function chatgptSession(record: SiwcRecord): LocalOAuthSession {
  const { accessToken, refreshToken, expiresAt, ...identity } = record;

  return { accessToken, refreshToken, expiresAt, metadata: { ...identity, scopes: [...identity.scopes] } };
}

async function suggestedChatGptModel(port: ProviderConnectPort, accessToken: string): Promise<string> {
  const provider = createChatGptProvider();

  const { models, stale } = await settleModelList(provider.listModels({
    env: {}, getAuth: async () => ({ headers: { Authorization: `Bearer ${accessToken}` } }), hasCredential: async () => true,
  }));

  if (stale !== null) port.report(stale.message);
  else port.report(`Your ChatGPT plan lists: ${models.map((entry) => entry.id).join(', ')}`);
  const current = currentModel(readDefaultTier()?.model, 'chatgpt');

  return models.find((entry) => entry.id === current)?.id ?? models[0]?.id ?? CHATGPT_DEFAULT_MODEL;
}

function withOAuthSession(config: KinuConfig, issuer: 'chatgpt' | 'claude', account: string, credential: LocalOAuthSession): KinuConfig {
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

interface ApiKeyProvider {
  readonly label: string;
  readonly prefix: string;
  readonly credKey: string;
  readonly account: string;
  readonly defaultModel: string;
  readonly model: string | undefined;
  readonly local: boolean;
  store(key: string): Promise<void>;
  clear: () => Promise<void>;
}

function connectApiKeyProvider(port: ProviderConnectPort, provider: ApiKeyProvider): Effect.Effect<ProviderConnectOutcome> {
  return Effect.gen(function* () {
    const named = provider.account !== MAIN_ACCOUNT;
    const key = yield* Effect.promise(async () => port.ask({ label: `${provider.label} API key${named ? ` for ${provider.account}` : ''}`, secret: true }));

    if (key.trim() === '') {
      return { kind: 'blocked', reason: `No ${provider.label} key was given.`, hint: `Run kinu provider connect ${provider.prefix} when you have one.` };
    }

    const storeKey = () => storeProviderSecret({
      local: provider.local,
      credKey: provider.credKey,
      credential: { kind: 'bearer', token: key },
      storeLocally: () => provider.store(key),
      clearLocally: provider.clear,
    });

    if (named) {
      const where = yield* Effect.promise(storeKey);

      return {
        kind: 'connected',
        summary: `Added the ${provider.label} account ${provider.account} to ${where === 'account' ? 'your Kinu account' : 'this machine'}.`,
        detail: accountDetail(provider.prefix, provider.account),
      };
    }

    const current = currentModel(readDefaultTier()?.model, provider.prefix) ?? provider.defaultModel;

    const model = provider.model ?? (yield* Effect.promise(async () => port.ask({ label: 'Default model', fallback: current })));
    const spec = `${provider.prefix}/${model}`;

    const where = yield* Effect.promise(storeKey);

    return {
      kind: 'connected',
      summary: where === 'account'
        ? `Connected ${provider.label} to your Kinu account. No key stored on this machine.`
        : `Saved ${provider.label} credentials to this machine.`,
      detail: yield* Effect.promise(async () => defaultModelDetail(spec)),
    };
  });
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
    storeLocally: async () => { await updateConfigFile((config) => withProvider(config, { openaiCompat: { default: { baseURL, apiKey } } })); },
    clearLocally: async () => { await updateConfigFile((config) => { delete config.providers?.openaiCompat?.default; }); },
    // Usually Ollama or vLLM on this machine; the proxy is https-only and a Worker cannot reach loopback.
    endpoint: baseURL,
  });

  return {
    kind: 'connected',
    summary: where === 'account'
      ? 'Connected the OpenAI-compatible endpoint to your Kinu account. No key stored on this machine.'
      : 'Saved the OpenAI-compatible endpoint credentials to this machine.',
    detail: await defaultModelDetail(spec),
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

  await updateConfigFile((config) => withProvider(config, {}));

  return {
    kind: 'connected',
    summary: 'Connected OpenCode',
    detail: `${await defaultModelDetail(`opencode/${model}`)} Kinu reads models and auth from your local opencode install at request time.`,
  };
}

/** Signed in: the account (sealed, reachable via the provider proxy). Otherwise, or with `--local`, this machine. */
async function storeProviderSecret(opts: {
  local: boolean;
  credKey: string;
  credential: unknown;
  storeLocally: () => Promise<void>;
  /** Runs after an account write: a local key wins at resolution and would shadow it. */
  clearLocally: () => Promise<void>;
  /** An endpoint the proxy cannot reach (loopback, private range, plain http) forces local storage. */
  endpoint?: string;
}): Promise<'account' | 'local'> {
  const reachable = opts.endpoint === undefined || reachableFromTheInternet(opts.endpoint);
  const cloud = opts.local || !reachable ? null : resolveCloudSession();

  if (!cloud) {
    await opts.storeLocally();

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

  await opts.clearLocally();
  await bumpProviderRevision();

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

async function defaultModelDetail(spec: string): Promise<string> {
  const current = (await adoptDefaultModel(spec))?.model;

  if (current === spec) return `Default model: ${spec}`;

  if (current === undefined) return `${spec} is connected; your account's default model is unchanged.`;

  return `Default model stays ${current}; to use ${spec}, pick it under Defaults on kinu's home screen.`;
}
