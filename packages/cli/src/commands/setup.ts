import {
  createCodexOAuthClient,
  DEFAULT_WORKERS_AI_MODEL_SPEC,
  decodeJsonValue,
  decodeCodexAccountId,
  tokensToCredential,
} from '@kinu/core';
import { renderThrownChain, tolerate } from '@kinu/core/obs';
import { checkClaudeAvailability, checkOpenCodeAvailability, createOpenCodeProvider } from '@kinu/cli-backend';
import { setCloudCredential } from '../cloud-api';
import { loadConfigFile, resolveCloudSession, saveConfigFile, setDefaultModel, updateConfigFile, type KinuConfig } from '../config';
import { ACCENT, DIM, OK, WARN } from '../display';
import { ask, askSecret, canPrompt, confirm } from '../prompt';
import { authCommand, openBrowser } from './auth';

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
export async function storeProviderSecret(opts: {
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
  /** An endpoint the proxy could never reach (loopback, plain http) forces the
   *  local answer whatever the account could hold — otherwise the key would be
   *  stored somewhere it can never be used from. */
  reachableOnlyLocally?: boolean;
}): Promise<'account' | 'local'> {
  const cloud = opts.local || opts.reachableOnlyLocally ? null : resolveCloudSession();
  if (!cloud) {
    opts.storeLocally();
    return 'local';
  }
  try {
    await setCloudCredential(cloud.origin, cloud.token, opts.credKey, decodeJsonValue({ value: opts.credential }));
  } catch (err) {
    // Deliberately not falling back to disk: the user asked for account
    // storage, and writing the secret somewhere they did not choose is the
    // surprise this whole change exists to remove. Say what happened and what
    // to do about it, and leave nothing behind.
    throw new Error(
      `Your Kinu account did not accept the key (${renderThrownChain({ cause: err })}). `
      + 'Nothing was saved. Try again, or re-run with --local to keep the key on this machine.',
      { cause: err },
    );
  }
  opts.clearLocally();
  setDefaultModel(opts.model);
  return 'account';
}

/** Whether the Kinu Worker could reach this endpoint at all: https, and not
 *  a loopback or link-local host. */
function reachableFromTheInternet(baseURL: string): boolean {
  const url = tolerate(() => new URL(baseURL), 'malformed-input');
  if (!url) return false;
  if (url.protocol !== 'https:') return false;
  return !/^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
}

function reportStored(where: 'account' | 'local', label: string, model: string): void {
  console.log(where === 'account'
    ? `${OK('✓')} Connected ${label} to your Kinu account — no key stored on this machine.`
    : `${OK('✓')} Saved ${label} credentials to this machine.`);
  console.log(DIM(`Default model: ${model}`));
}

export async function setupCommand(opts: {
  origin?: string;
  provider?: string;
  model?: string;
  yes?: boolean;
  skipCloud?: boolean;
  localModel?: boolean;
  accountOnly?: boolean;
  /** Keep the provider secret on this machine instead of the account. */
  local?: boolean;
}): Promise<void> {
  console.log('');
  console.log(ACCENT('Kinu setup'));
  console.log(DIM('Connect your account, Cloudflare Workers AI billing, and optional local providers.'));
  console.log('');

  const config = loadConfigFile();
  let cloudReady = Boolean(config.accessToken);
  if (cloudReady) {
    console.log(`${OK('✓')} Signed in${config.user?.email ? ` as ${ACCENT(config.user.email)}` : ''}`);
    console.log(DIM('Local workspaces you create while signed in run on your Cloudflare account via Workers AI — no API key on this machine.'));
  }

  if (!opts.skipCloud && !config.accessToken) {
    // Without a terminal there is nothing to ask — fall through to the
    // honest instruction paths below instead of letting readline hang on
    // a pipe (the `curl | bash` installer freeze).
    const shouldLogin = opts.yes || (canPrompt() && await confirm('Sign in and attach Cloudflare Workers AI permissions now?', true));
    if (shouldLogin) {
      await authCommand({ origin: opts.origin });
      cloudReady = Boolean(loadConfigFile().accessToken);
    }
  }

  if (opts.accountOnly) {
    if (cloudReady) {
      console.log(`${OK('✓')} Kinu account ready.`);
      console.log(DIM('Cloud workspaces can use Workers AI through your Cloudflare account when Cloudflare sign-in granted AI permissions.'));
      console.log(DIM('Run kinu provider connect codex for local workspaces that should use your ChatGPT Codex subscription.'));
    } else {
      console.log(`${WARN('!')} Kinu account was not connected.`);
      console.log(DIM(`Run kinu auth${opts.origin ? ` --origin ${opts.origin}` : ''} when you are ready.`));
    }
    return;
  }

  if (!opts.yes && !opts.provider && !opts.localModel && !canPrompt()) {
    if (cloudReady) {
      console.log(`${OK('✓')} Kinu account ready.`);
      console.log(DIM('Workers AI is tied to the Cloudflare account used during browser sign-in.'));
    } else {
      console.log(`${WARN('!')} Kinu account was not connected (no interactive terminal).`);
      console.log(DIM(`Run kinu auth${opts.origin ? ` --origin ${opts.origin}` : ''} when you are ready.`));
    }
    console.log(DIM('Run kinu provider connect <provider> to configure local workspace model access.'));
    return;
  }

  const provider = normalizeProvider(opts.provider ?? (opts.yes ? 'workers-ai' : await chooseProvider(cloudReady)));
  if (provider === 'skip') {
    console.log(`${WARN('!')} Skipped local model setup.`);
    console.log(DIM(cloudReady
      ? 'Cloud workspaces remain ready. Run kinu provider connect <provider> later for local workspaces.'
      : 'Run kinu setup later before creating workspaces.'));
    return;
  }

  if (provider === 'workers-ai') {
    if (!cloudReady) {
      console.log(`${WARN('!')} Workers AI needs a signed-in Kinu account.`);
      console.log(DIM(`Run kinu auth${opts.origin ? ` --origin ${opts.origin}` : ''}, then kinu setup again.`));
      return;
    }
    if (opts.model) {
      const spec = `workers-ai/${stripProviderPrefix(opts.model, 'workers-ai')}`;
      setDefaultModel(spec);
      console.log(`${OK('✓')} Using Cloudflare Workers AI`);
      console.log(DIM(`Default model: ${spec}`));
      return;
    }
    // Storing nothing is deliberate: the platform default is one constant in
    // @kinu/core, and an unset model reads it at resolve time instead of
    // pinning a copy that would go stale.
    updateConfigFile((config) => { delete config.model; });
    console.log(`${OK('✓')} Using Cloudflare Workers AI`);
    console.log(DIM(`Default model: ${DEFAULT_WORKERS_AI_MODEL_SPEC}`));
    console.log(DIM('No API key on this machine — requests go through your Kinu account.'));
    return;
  }

  const next = loadConfigFile();
  if (provider === 'codex') {
    const model = stripProviderPrefix(opts.model ?? await ask('Default Codex model', next.model?.startsWith('codex/') ? next.model.slice('codex/'.length) : 'gpt-5.5'), 'codex');
    const credential = await runCodexDeviceFlow();
    saveConfigFile(withProvider(next, {
      model: `codex/${model}`,
      providers: {
        ...next.providers,
        codex: {
          accessToken: credential.accessToken,
          refreshToken: credential.refreshToken,
          expiresAt: credential.expiresAt,
          metadata: credential.metadata,
        },
      },
    }));
    console.log(`${OK('✓')} Connected ChatGPT Codex subscription`);
    return;
  }

  if (provider === 'openai') {
    const key = await askSecret('OpenAI API key');
    const model = opts.model ?? await ask('Default model', next.model?.startsWith('openai/') ? next.model.slice('openai/'.length) : 'gpt-4o-mini');
    const spec = `openai/${model}`;
    reportStored(await storeProviderSecret({
      local: opts.local ?? false,
      credKey: 'openai.bearer',
      credential: { kind: 'bearer', token: key },
      storeLocally: () => saveConfigFile(withProvider(next, {
        model: spec,
        providers: { ...next.providers, openai: { apiKey: key } },
      })),
      clearLocally: () => updateConfigFile((config) => { delete config.providers?.openai; }),
      model: spec,
    }), 'OpenAI', spec);
    return;
  }

  if (provider === 'openrouter') {
    const key = await askSecret('OpenRouter API key');
    const model = opts.model ?? await ask('Default model', next.model?.startsWith('openrouter/') ? next.model.slice('openrouter/'.length) : 'openai/gpt-4o-mini');
    const spec = `openrouter/${model}`;
    reportStored(await storeProviderSecret({
      local: opts.local ?? false,
      credKey: 'openrouter.bearer',
      credential: { kind: 'bearer', token: key },
      storeLocally: () => saveConfigFile(withProvider(next, {
        model: spec,
        providers: { ...next.providers, openrouter: { apiKey: key } },
      })),
      clearLocally: () => updateConfigFile((config) => { delete config.providers?.openrouter; }),
      model: spec,
    }), 'OpenRouter', spec);
    return;
  }

  if (provider === 'anthropic') {
    const key = await askSecret('Anthropic API key');
    const model = opts.model ?? await ask('Default model', next.model?.startsWith('anthropic/') ? next.model.slice('anthropic/'.length) : 'claude-sonnet-4-5');
    const spec = `anthropic/${model}`;
    reportStored(await storeProviderSecret({
      local: opts.local ?? false,
      credKey: 'anthropic.bearer',
      credential: { kind: 'bearer', token: key },
      storeLocally: () => saveConfigFile(withProvider(next, {
        model: spec,
        providers: { ...next.providers, anthropic: { apiKey: key } },
      })),
      clearLocally: () => updateConfigFile((config) => { delete config.providers?.anthropic; }),
      model: spec,
    }), 'Anthropic', spec);
    return;
  }

  if (provider === 'openai-compatible') {
    const baseURL = await ask('Base URL', 'http://localhost:11434/v1');
    const apiKey = await askSecret('API key (use any non-empty value for local servers)', 'local');
    const model = opts.model ?? await ask('Default model', 'gpt-oss:20b');
    const spec = `openai-compat/${model}`;
    reportStored(await storeProviderSecret({
      local: opts.local ?? false,
      credKey: 'openai-compat.default',
      credential: { kind: 'openai-compat', baseURL, apiKey },
      storeLocally: () => saveConfigFile(withProvider(next, {
        model: spec,
        providers: {
          ...next.providers,
          openaiCompat: {
            ...next.providers?.openaiCompat,
            default: { baseURL, apiKey },
          },
        },
      })),
      clearLocally: () => updateConfigFile((config) => { delete config.providers?.openaiCompat?.default; }),
      model: spec,
      // The usual openai-compat endpoint is Ollama or vLLM on this machine.
      // The proxy sends to https only and could not reach a loopback address
      // from a Worker anyway, so that key belongs here.
      reachableOnlyLocally: !reachableFromTheInternet(baseURL),
    }), 'the OpenAI-compatible endpoint', spec);
    return;
  }

  if (provider === 'opencode') {
    console.log(ACCENT('Connecting to OpenCode…'));
    console.log(DIM('Reading your opencode auth and model configuration.'));
    const avail = await checkOpenCodeAvailability();
    if (!avail.binary) {
      console.log(`${WARN('!')} opencode CLI not found.`);
      console.log(DIM(INSTALL_HINT_OPENCODE));
      return;
    }
    if (!avail.authenticated) {
      console.log(`${WARN('!')} opencode is not authenticated.`);
      console.log(DIM(LOGIN_HINT_OPENCODE));
      return;
    }
    // Discover available models by creating the provider and calling listModels
    // with stub deps (the provider reads from the filesystem, not from deps).
    const ocProvider = createOpenCodeProvider();
    let model = opts.model ?? '';
    if (!model) {
      try {
        const models = await ocProvider.listModels({
          env: {},
          getAuth: async () => null,
          hasCredential: async () => false,
        });
        if (models.length === 0) {
          console.log(`${WARN('!')} No models found in your opencode configuration.`);
          return;
        }
        // Pick the provider's configured default, or fall back to the first model.
        model = models[0].id;
      } catch (e) {
        console.log(`${WARN('!')} Could not read opencode models: ${renderThrownChain({ cause: e })}`);
        console.log(DIM(LOGIN_HINT_OPENCODE));
        return;
      }
    }
    saveConfigFile(withProvider(next, {
      model: `opencode/${model}`,
      providers: {},
    }));
    console.log(`${OK('✓')} Connected OpenCode`);
    console.log(DIM(`Default model: opencode/${model}`));
    console.log(DIM('Models and auth are read from your local opencode installation at request time.'));
    return;
  }

  throw new Error(`Unknown provider: ${provider}`);
}

const INSTALL_HINT_OPENCODE = 'Install opencode: https://opencode.ai';
const LOGIN_HINT_OPENCODE = 'Run `opencode auth login` to authenticate opencode, then run `kinu setup` again.';

function withProvider(config: KinuConfig, patch: Pick<KinuConfig, 'model' | 'providers'>): KinuConfig {
  return {
    ...config,
    model: patch.model,
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

async function chooseProvider(cloudReady: boolean): Promise<string> {
  console.log(DIM('Local model provider:'));
  console.log(`  ${ACCENT('1')} Cloudflare Workers AI through your Kinu account ${DIM('(recommended)')}`);
  console.log(`  ${ACCENT('2')} ChatGPT Codex subscription`);
  console.log(`  ${ACCENT('3')} OpenAI API key`);
  console.log(`  ${ACCENT('4')} OpenRouter`);
  console.log(`  ${ACCENT('5')} Anthropic`);
  console.log(`  ${ACCENT('6')} OpenAI-compatible`);
  console.log(`  ${ACCENT('7')} OpenCode (share your opencode auth & models)`);
  console.log(`  ${ACCENT('8')} Skip`);
  if (!cloudReady) console.log(DIM('  Option 1 needs a signed-in account — run kinu auth first.'));
  // No-friction discovery: the Claude Code subscription stores no credential
  // here (the binary owns its own login), so mention it inline rather than as a
  // step — only when it is actually usable on this machine.
  if ((await checkClaudeAvailability()).loggedIn) {
    console.log(DIM('  Claude Code detected — or use --model claude/claude-opus-4-x for your subscription.'));
  }
  const value = await ask('Choice', '1');
  return value;
}

function normalizeProvider(value: string): 'workers-ai' | 'codex' | 'openai' | 'openrouter' | 'anthropic' | 'openai-compatible' | 'opencode' | 'skip' {
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'workers-ai' || v === 'cloudflare' || v === 'workersai') return 'workers-ai';
  if (v === '2' || v === 'codex' || v === 'chatgpt' || v === 'chatgpt-codex') return 'codex';
  if (v === '3' || v === 'openai') return 'openai';
  if (v === '4' || v === 'openrouter') return 'openrouter';
  if (v === '5' || v === 'anthropic' || v === 'claude') return 'anthropic';
  if (v === '6' || v === 'openai-compatible' || v === 'compat' || v === 'ollama') return 'openai-compatible';
  if (v === '7' || v === 'opencode') return 'opencode';
  if (v === '8' || v === 'skip' || v === 'none') return 'skip';
  throw new Error('Provider must be workers-ai, codex, openai, openrouter, anthropic, openai-compatible, opencode, or skip.');
}

async function runCodexDeviceFlow() {
  const client = createCodexOAuthClient();
  const flow = await client.startDeviceFlow();
  console.log('');
  console.log(`${DIM('Open:')} ${ACCENT(flow.portalURL)}`);
  console.log(`${DIM('Code:')} ${ACCENT(flow.userCode)}`);
  console.log('');
  openBrowser(flow.portalURL);

  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await delay(Math.max(3, flow.pollIntervalSec) * 1000);
    const tokens = await client.pollDeviceFlow(flow.deviceAuthId, flow.userCode);
    if (!tokens) {
      process.stdout.write('.');
      continue;
    }
    console.log('');
    const credential = tokensToCredential(tokens);
    const accountId = decodeCodexAccountId(credential.accessToken);
    return {
      ...credential,
      metadata: accountId ? { accountId } : credential.metadata,
    };
  }
  throw new Error('Codex login expired. Run kinu setup again.');
}

function stripProviderPrefix(model: string, provider: string): string {
  return model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
