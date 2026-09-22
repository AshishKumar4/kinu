/**
 * Connecting a provider, without a console.
 *
 * Two surfaces acquire the same credentials: `kinu setup` / `kinu provider
 * connect`, which own a terminal and a readline, and the TUI's onboarding
 * step, which owns neither. So the flows here take a PORT — a line to report
 * progress on, and one question-asker — and answer with an outcome the
 * surface renders in its own registers. Nothing below writes to stdout or
 * reads stdin, which is the whole point: the CLI supplies a console port and
 * the TUI supplies its step.
 */
import { checkClaudeAvailability, checkOpenCodeAvailability, createOpenCodeProvider } from '@kinu.run/cli-backend';
import {
  createCodexOAuthClient,
  decodeCodexAccountId,
  decodeJsonValue,
  tokensToCredential,
  waitForAnswer,
} from '@kinu.run/core';
import { renderThrownChain, tolerate } from '@kinu.run/core/obs';
import { listCloudCredentials, setCloudCredential } from '../cloud-api';
import {
  bumpProviderRevision,
  loadConfigFile,
  resolveCloudSession,
  setDefaultModel,
  updateConfigFile,
  type KinuConfig,
} from '../config';
import { authenticateCli, openBrowser } from './auth';

export type ProviderConnectId =
  | 'cloudflare'
  | 'claude'
  | 'codex'
  | 'openai'
  | 'openrouter'
  | 'anthropic'
  | 'openai-compatible'
  | 'opencode';

/** What Enter on a provider row does, which is what a surface has to be ready
 *  for: hand the person a URL and a code, take a secret, or probe a binary. */
export type ProviderCredentialKind = 'browser' | 'device-code' | 'api-key' | 'binary';

export interface ProviderAsk {
  readonly label: string;
  /** Taken when the answer is empty. */
  readonly fallback?: string;
  /** Never echoed: an API key or a token. */
  readonly secret?: boolean;
}

export interface ProviderConnectPort {
  /** One line of progress, in the surface's own dim register. */
  report(line: string): void;
  ask(request: ProviderAsk): Promise<string>;
}

export type ProviderConnectOutcome =
  | { readonly kind: 'connected'; readonly summary: string; readonly detail?: string }
  /** Nothing was stored, and this is the next step that would change that. */
  | { readonly kind: 'blocked'; readonly reason: string; readonly hint: string };

export interface ProviderDescriptor {
  readonly id: ProviderConnectId;
  readonly label: string;
  /** One line under the label, on both surfaces. */
  readonly blurb: string;
  readonly credential: ProviderCredentialKind;
}

export interface ProviderConnectionState {
  readonly descriptor: ProviderDescriptor;
  readonly connected: boolean;
  /** The model or the store the connection resolves through, when connected;
   *  the command that would connect it, when not. */
  readonly detail: string;
}

export interface ProviderConnections {
  readonly states: readonly ProviderConnectionState[];
  readonly signedInEmail?: string;
  /** Account credentials no provider row above claims — the models.dev tail
   *  connected in the web UI, usable here without ever holding the key. */
  readonly accountExtras: readonly string[];
  /** Why the account could not be asked. An unreachable account is not
   *  evidence of an empty one. */
  readonly accountUnreachable?: string;
}

const INSTALL_HINT_OPENCODE = 'Install opencode: https://opencode.ai';

const LOGIN_HINT_OPENCODE = 'Run `opencode auth login` to authenticate opencode, then run `kinu setup` again.';

const CLAUDE_LOGIN_HINT = 'Run `claude` once to sign in to your Claude subscription.';

const CLAUDE_INSTALL_HINT = 'Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup';

const CLAUDE_READY = 'Claude subscription ready. Use kinu create --model claude/claude-opus-4-x';

export const PROVIDER_CONNECTORS: readonly ProviderDescriptor[] = Object.freeze(([
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    blurb: 'Browser sign-in attaches your Cloudflare account for Workers AI and AI Gateway.',
    credential: 'browser',
  },
  {
    id: 'claude',
    label: 'Claude subscription',
    blurb: 'Drives the `claude` binary with your Claude Code login. Local workspaces only.',
    credential: 'binary',
  },
  {
    id: 'codex',
    label: 'Codex',
    blurb: 'Your ChatGPT Codex subscription, through the device login.',
    credential: 'device-code',
  },
  { id: 'openai', label: 'OpenAI', blurb: 'An OpenAI API key.', credential: 'api-key' },
  { id: 'openrouter', label: 'OpenRouter', blurb: 'An OpenRouter API key.', credential: 'api-key' },
  { id: 'anthropic', label: 'Anthropic', blurb: 'An Anthropic API key.', credential: 'api-key' },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    blurb: 'Any OpenAI-shaped endpoint — Ollama, vLLM, a proxy of your own.',
    credential: 'api-key',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    blurb: 'Reuses the model providers and auth tokens from your local opencode CLI.',
    credential: 'binary',
  },
] satisfies readonly ProviderDescriptor[]).map((descriptor) => Object.freeze(descriptor)));

/** The account keys the rows above already speak for. */
const NAMED_ACCOUNT_KEYS: Readonly<Record<string, true>> = Object.freeze({
  'openai.bearer': true,
  'openrouter.bearer': true,
  'anthropic.bearer': true,
  'openai-compat.default': true,
  'cloudflare.oauth': true,
  'cloudflare.ai-gateway': true,
  'codex.oauth': true,
});

/** The account key each API-key provider is stored under. A local key WINS at
 *  resolution time, so both stores are read before a row says "connected". */
const ACCOUNT_CREDENTIAL_KEYS: Readonly<Record<string, string>> = Object.freeze({
  openai: 'openai.bearer',
  openrouter: 'openrouter.bearer',
  anthropic: 'anthropic.bearer',
  'openai-compatible': 'openai-compat.default',
});

/**
 * What every provider row says right now, for the listing and for the
 * onboarding step. One reader: a row that reads "connected" in `kinu provider
 * list` and "not connected" in the TUI would be two answers to one question.
 */
export async function readProviderConnections(): Promise<ProviderConnections> {
  const config = loadConfigFile();
  const account = await accountCredentials();
  const held = 'credentials' in account ? account.credentials : [];
  const inAccount = (credKey: string): boolean => held.some((credential) => credential.key === credKey);
  const providers = config.providers ?? {};
  const [claude, opencode] = await Promise.all([checkClaudeAvailability(), checkOpenCodeAvailability()]);

  const states = PROVIDER_CONNECTORS.map((descriptor): ProviderConnectionState => {
    const hint = `kinu provider connect ${descriptor.id}`;

    switch (descriptor.id) {
      case 'cloudflare':
        return config.accessToken === undefined
          ? { descriptor, connected: false, detail: hint }
          : { descriptor, connected: true, detail: config.user?.email ?? 'your account' };
      case 'claude':
        if (claude.binary && claude.loggedIn) return { descriptor, connected: true, detail: 'claude/claude-opus-4-x' };

        return { descriptor, connected: false, detail: claude.binary ? CLAUDE_LOGIN_HINT : hint };
      case 'codex':
        return providers.codex?.accessToken === undefined && providers.codex?.refreshToken === undefined
          ? { descriptor, connected: false, detail: hint }
          : { descriptor, connected: true, detail: currentModel(config.model, 'codex') ?? 'your subscription' };
      case 'opencode':
        if (opencode.binary && opencode.authenticated) {
          return { descriptor, connected: true, detail: currentModel(config.model, 'opencode') ?? 'your opencode install' };
        }

        return { descriptor, connected: false, detail: opencode.binary ? LOGIN_HINT_OPENCODE : hint };
      case 'openai':
      case 'openrouter':
      case 'anthropic':
      case 'openai-compatible': {
        const localKey = localApiKey(providers, descriptor.id);
        const credKey = ACCOUNT_CREDENTIAL_KEYS[descriptor.id];
        const model = currentModel(config.model, descriptor.id === 'openai-compatible' ? 'openai-compat' : descriptor.id);

        if (localKey) return { descriptor, connected: true, detail: [model, 'this machine'].filter(Boolean).join(' · ') };

        if (credKey !== undefined && inAccount(credKey)) {
          return { descriptor, connected: true, detail: [model, 'your account'].filter(Boolean).join(' · ') };
        }

        return { descriptor, connected: false, detail: hint };
      }
    }
  });

  const extras = held.filter((credential) => NAMED_ACCOUNT_KEYS[credential.key] !== true).map((credential) => credential.key);

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

/**
 * Acquire and store one provider's credential, reporting through the port.
 *
 * Every branch either stores something and answers `connected`, or stores
 * nothing and answers `blocked` with the step that would unblock it. A
 * failure the person cannot act on — the account refusing a key — throws, and
 * the surface renders the chain.
 */
export async function connectProvider(
  id: ProviderConnectId,
  port: ProviderConnectPort,
  opts: { readonly origin?: string; readonly model?: string; readonly local?: boolean } = {},
): Promise<ProviderConnectOutcome> {
  switch (id) {
    case 'cloudflare': return await connectCloudflare(port, opts.origin);
    case 'claude': return await connectClaude(port);
    case 'codex': return await connectCodex(port, opts.model);
    case 'opencode': return await connectOpenCode(port, opts.model);
    case 'openai':
      return await connectApiKeyProvider(port, {
        label: 'OpenAI',
        prefix: 'openai',
        credKey: 'openai.bearer',
        defaultModel: 'gpt-4o-mini',
        model: opts.model,
        local: opts.local ?? false,
        store: (key, spec) => updateConfigFile((config) => withProvider(config, {
          model: spec,
          providers: { openai: { apiKey: key } },
        })),
        clear: () => updateConfigFile((config) => { delete config.providers?.openai; }),
      });
    case 'openrouter':
      return await connectApiKeyProvider(port, {
        label: 'OpenRouter',
        prefix: 'openrouter',
        credKey: 'openrouter.bearer',
        defaultModel: 'openai/gpt-4o-mini',
        model: opts.model,
        local: opts.local ?? false,
        store: (key, spec) => updateConfigFile((config) => withProvider(config, {
          model: spec,
          providers: { openrouter: { apiKey: key } },
        })),
        clear: () => updateConfigFile((config) => { delete config.providers?.openrouter; }),
      });
    case 'anthropic':
      return await connectApiKeyProvider(port, {
        label: 'Anthropic',
        prefix: 'anthropic',
        credKey: 'anthropic.bearer',
        defaultModel: 'claude-sonnet-4-5',
        model: opts.model,
        local: opts.local ?? false,
        store: (key, spec) => updateConfigFile((config) => withProvider(config, {
          model: spec,
          providers: { anthropic: { apiKey: key } },
        })),
        clear: () => updateConfigFile((config) => { delete config.providers?.anthropic; }),
      });
    case 'openai-compatible': return await connectOpenAiCompatible(port, opts.model, opts.local ?? false);
  }
}

async function connectCloudflare(port: ProviderConnectPort, origin: string | undefined): Promise<ProviderConnectOutcome> {
  port.report('The OAuth consent must include User Details, Account Settings, Workers AI, and AI Gateway scopes.');
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

/** The Claude subscription stores no credential here — the `claude` binary
 *  owns its own login — so "connect" is a probe, and the outcome is what the
 *  probe found. LOCAL ONLY: cloud agents need an Anthropic API key. */
async function connectClaude(port: ProviderConnectPort): Promise<ProviderConnectOutcome> {
  const { binary, loggedIn } = await checkClaudeAvailability();

  if (binary && loggedIn) {
    // Nothing was written here, but this command is how the person says they
    // have just connected it, and its availability is what a listing sweep
    // probes. A resident session has no other way to learn that.
    bumpProviderRevision();

    return { kind: 'connected', summary: CLAUDE_READY, detail: 'Cloud workspaces cannot use the subscription. Connect an Anthropic API key for those.' };
  }

  if (binary) return { kind: 'blocked', reason: CLAUDE_LOGIN_HINT, hint: 'Cloud workspaces cannot use the subscription. Connect an Anthropic API key for those.' };
  port.report('Then run `claude` once to sign in.');

  return { kind: 'blocked', reason: CLAUDE_INSTALL_HINT, hint: 'Cloud workspaces cannot use the subscription. Connect an Anthropic API key for those.' };
}

async function connectCodex(port: ProviderConnectPort, requestedModel: string | undefined): Promise<ProviderConnectOutcome> {
  const config = loadConfigFile();
  const current = config.model?.startsWith('codex/') === true ? config.model.slice('codex/'.length) : 'gpt-5.5';
  const answered = requestedModel ?? await port.ask({ label: 'Default Codex model', fallback: current });
  const model = answered.startsWith('codex/') ? answered.slice('codex/'.length) : answered;
  const credential = await runCodexDeviceFlow(port);
  const spec = `codex/${model}`;
  updateConfigFile((next) => withProvider(next, {
    model: spec,
    providers: {
      codex: {
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        expiresAt: credential.expiresAt,
        metadata: credential.metadata,
      },
    },
  }));

  return { kind: 'connected', summary: 'Connected ChatGPT Codex subscription', detail: `Default model: ${spec}` };
}

async function runCodexDeviceFlow(port: ProviderConnectPort) {
  const client = createCodexOAuthClient();
  const flow = await client.startDeviceFlow();
  port.report(`Open: ${flow.portalURL}`);
  port.report(`Code: ${flow.userCode}`);
  openBrowser(flow.portalURL);

  // No clock on this wait. The device code's lifetime belongs to the
  // provider: its expiry arrives as the provider's own expired answer and
  // ends the wait below, as denial does. A Date.now() bound here would end
  // the wait on an invented number while the approval may still be on its
  // way.
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
  readonly defaultModel: string;
  readonly model: string | undefined;
  readonly local: boolean;
  store(key: string, spec: string): void;
  clear: () => void;
}

async function connectApiKeyProvider(port: ProviderConnectPort, provider: ApiKeyProvider): Promise<ProviderConnectOutcome> {
  const key = await port.ask({ label: `${provider.label} API key`, secret: true });

  if (key.trim() === '') {
    return { kind: 'blocked', reason: `No ${provider.label} key was given.`, hint: `Run kinu provider connect ${provider.prefix} when you have one.` };
  }

  const config = loadConfigFile();

  const current = config.model?.startsWith(`${provider.prefix}/`) === true
    ? config.model.slice(provider.prefix.length + 1)
    : provider.defaultModel;

  const model = provider.model ?? await port.ask({ label: 'Default model', fallback: current });
  const spec = `${provider.prefix}/${model}`;

  const where = await storeProviderSecret({
    local: provider.local,
    credKey: provider.credKey,
    credential: { kind: 'bearer', token: key },
    storeLocally: () => provider.store(key, spec),
    clearLocally: provider.clear,
    model: spec,
  });

  return {
    kind: 'connected',
    summary: where === 'account'
      ? `Connected ${provider.label} to your Kinu account. No key stored on this machine.`
      : `Saved ${provider.label} credentials to this machine.`,
    detail: `Default model: ${spec}`,
  };
}

async function connectOpenAiCompatible(port: ProviderConnectPort, requestedModel: string | undefined, local: boolean): Promise<ProviderConnectOutcome> {
  const baseURL = await port.ask({ label: 'Base URL', fallback: 'http://localhost:11434/v1' });
  const apiKey = await port.ask({ label: 'API key (use any non-empty value for local servers)', fallback: 'local', secret: true });
  const model = requestedModel ?? await port.ask({ label: 'Default model', fallback: 'gpt-oss:20b' });
  const spec = `openai-compat/${model}`;

  const where = await storeProviderSecret({
    local,
    credKey: 'openai-compat.default',
    credential: { kind: 'openai-compat', baseURL, apiKey },
    storeLocally: () => updateConfigFile((config) => withProvider(config, {
      model: spec,
      providers: { openaiCompat: { default: { baseURL, apiKey } } },
    })),
    clearLocally: () => updateConfigFile((config) => { delete config.providers?.openaiCompat?.default; }),
    model: spec,
    // The usual openai-compat endpoint is Ollama or vLLM on this machine. The
    // proxy sends to https only and could not reach a loopback address from a
    // Worker anyway, so that key belongs here.
    endpoint: baseURL,
  });

  return {
    kind: 'connected',
    summary: where === 'account'
      ? 'Connected the OpenAI-compatible endpoint to your Kinu account. No key stored on this machine.'
      : 'Saved the OpenAI-compatible endpoint credentials to this machine.',
    detail: `Default model: ${spec}`,
  };
}

async function connectOpenCode(port: ProviderConnectPort, requestedModel: string | undefined): Promise<ProviderConnectOutcome> {
  port.report('Reading your opencode auth and model configuration.');
  const available = await checkOpenCodeAvailability();

  if (!available.binary) return { kind: 'blocked', reason: 'opencode CLI not found.', hint: INSTALL_HINT_OPENCODE };

  if (!available.authenticated) return { kind: 'blocked', reason: 'opencode is not authenticated.', hint: LOGIN_HINT_OPENCODE };
  let model = requestedModel ?? '';

  if (model === '') {
    // The provider reads auth and models from the filesystem, not from deps.
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

  updateConfigFile((config) => withProvider(config, { model: `opencode/${model}`, providers: {} }));

  return {
    kind: 'connected',
    summary: 'Connected OpenCode',
    detail: `Default model: opencode/${model}. Kinu reads models and auth from your local opencode install at request time.`,
  };
}

/**
 * Where a provider secret is written.
 *
 * Signed in, the answer is the Kinu account: sealed at rest there, reachable
 * from every machine through the provider proxy, and no second copy of the same
 * secret sitting in a config file on this disk. A local key remains an explicit
 * choice (`--local`) for working offline or against an endpoint only this
 * machine can see, and is still what happens when there is no account to
 * store it in.
 *
 * Returns where it landed so the caller can say so.
 */
async function storeProviderSecret(opts: {
  local: boolean;
  credKey: string;
  credential: unknown;
  /** Applied when the secret stays on this machine. */
  storeLocally: () => void;
  /** Removes this provider's local entry — run after a successful account
   *  write, because a local key WINS at resolution time and an older one left
   *  behind would quietly be the key that gets spent. */
  clearLocally: () => void;
  /** Set as the default model either way — a pointer, not a secret. */
  model: string;
  /** The endpoint the key is for, when the provider has one. An endpoint the
   *  proxy could never reach (loopback, a private range, plain http) forces
   *  the local answer whatever the account could hold. Otherwise the key would
   *  be stored somewhere it can never be used from. */
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
    // Deliberately not falling back to disk: the user asked for account
    // storage, and writing the secret somewhere they did not choose is the
    // surprise this refusal prevents. Say what happened and what to do about
    // it, and leave nothing behind.
    throw new Error(
      `Your Kinu account did not accept the key (${renderThrownChain({ cause: err })}). `
      + 'Nothing was saved. Try again, or re-run with --local to keep the key on this machine.',
      { cause: err },
    );
  }

  opts.clearLocally();
  setDefaultModel(opts.model);
  // The account now holds a credential it did not hold a moment ago, and the
  // local copy is gone. Both change what a resident session can resolve.
  bumpProviderRevision();

  return 'account';
}

/** Whether the Kinu Worker could reach this endpoint at all: https, and not
 *  a loopback, private, link-local, IPv6 ULA or CGNAT host. */
function reachableFromTheInternet(baseURL: string): boolean {
  const url = tolerate(() => new URL(baseURL), 'malformed-input');

  if (!url) return false;

  if (url.protocol !== 'https:') return false;
  const hostname = url.hostname;
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (isIPv6Ula(host) || isCgnat(host)) return false;

  return !/^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname);
}

/** IPv6 unique-local addresses (fc00::/7): routable nowhere the proxy runs. */
function isIPv6Ula(host: string): boolean {
  if (!host.includes(':')) return false;
  const first = Number.parseInt(host.split(':')[0] ?? '', 16);

  if (!Number.isFinite(first)) return false;
  const top = first >>> 8;

  return top === 0xfc || top === 0xfd;
}

/** Carrier-grade NAT (100.64.0.0/10): one provider's customers, not the internet. */
function isCgnat(host: string): boolean {
  const octets = host.split('.');

  if (octets.length !== 4 || octets.some((o) => !/^\d+$/.test(o))) return false;
  const [first, second] = octets.map(Number);

  return first === 100 && (second ?? 0) >= 64 && (second ?? 0) <= 127;
}

/**
 * The one shape every LOCAL provider write takes: this machine's credential
 * set plus the model spec that points at it.
 *
 * The provider revision advances here rather than at each call site, because
 * every caller of this function is by definition changing what a model
 * resolution can reach — that is what the function is for — and a new provider
 * branch added below would otherwise silently skip the signal.
 */
function withProvider(config: KinuConfig, patch: Pick<KinuConfig, 'model' | 'providers'>): KinuConfig {
  return {
    ...config,
    model: patch.model,
    providerRevision: (config.providerRevision ?? 0) + 1,
    providers: {
      ...config.providers,
      ...patch.providers,
      openaiCompat: {
        ...config.providers?.openaiCompat,
        ...patch.providers?.openaiCompat,
      },
    },
  };
}
