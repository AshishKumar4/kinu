import { checkClaudeAvailability, checkOpenCodeAvailability } from '@kinu/cli-backend';
import { deleteCloudCredential, listCloudCredentials, type CloudCredentialSummary } from '../cloud-api';
import { loadConfigFile, resolveCloudSession, updateConfigFile, type ProteusConfig } from '../config';
import { ACCENT, DIM, OK, WARN } from '../display';
import { authCommand } from './auth';
import { setupCommand } from './setup';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu/core/obs';

type ProviderAction = 'list' | 'connect' | 'disconnect';
const ProviderNameSchema = v.picklist([
  'cloudflare',
  'claude',
  'codex',
  'openai',
  'openrouter',
  'anthropic',
  'openai-compatible',
  'opencode',
]);
type ProviderName = v.InferOutput<typeof ProviderNameSchema>;

interface ParsedProviderArgs {
  action: ProviderAction;
  provider?: ProviderName;
  /** What the user typed, when it named nothing this CLI knows. */
  raw?: string;
}

interface LocalCredential {
  clear: (providers: NonNullable<ProteusConfig['providers']>) => boolean;
  envVars: string[];
  /** The account-side key the same provider is stored under, when it can be. */
  credKey?: string;
}

const CLAUDE_INSTALL_HINT = 'Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup';
const CLAUDE_LOGIN_HINT = 'Run `claude` once to sign in to your Claude subscription.';
const CLAUDE_READY = 'Claude subscription ready — use proteus create --model claude/claude-opus-4-x';

export async function providersCommand(actionOrProvider: string | undefined, providerArg: string | undefined, opts: {
  origin?: string;
  model?: string;
  /** Keep the secret on this machine instead of the Proteus account. */
  local?: boolean;
}): Promise<void> {
  const { action, provider, raw } = parseArgs(actionOrProvider, providerArg);

  if (action === 'list') {
    await printProviders();
    return;
  }

  if (action === 'disconnect' && !provider && raw) {
    await disconnectAccountProvider(raw);
    return;
  }

  if (!provider) {
    throw new Error(`Choose a provider to ${action}: cloudflare, claude, codex, openai, openrouter, anthropic, openai-compatible, or opencode.`);
  }

  if (action === 'disconnect') {
    await disconnectProvider(provider);
    return;
  }

  if (provider === 'cloudflare') {
    console.log('');
    console.log(ACCENT('Connect Cloudflare'));
    console.log(DIM('Browser sign-in attaches your Cloudflare account for Workers AI and AI Gateway usage.'));
    console.log(DIM('The OAuth consent must include User Details, Account Settings, Workers AI, and AI Gateway scopes.'));
    await authCommand({ origin: opts.origin });
    return;
  }

  if (provider === 'claude') {
    await connectClaude();
    return;
  }

  if (provider === 'opencode') {
    await connectOpenCode(opts);
    return;
  }

  await setupCommand({
    origin: opts.origin,
    provider,
    model: opts.model,
    localModel: true,
    skipCloud: true,
    local: opts.local ?? false,
  });
}

/** Claude subscription "connect" is a status check, not a credential we store:
 *  the official `claude` binary owns its own Claude Code login. We probe PATH +
 *  `claude auth status` and print the next step. LOCAL ONLY — cloud agents need
 *  an Anthropic API key (proteus provider connect anthropic), not this. */
async function connectClaude(): Promise<void> {
  console.log('');
  console.log(ACCENT('Claude subscription (via Claude Code)'));
  console.log(DIM('Drives the official `claude` binary with your Claude Code login. Local workspaces only.'));
  const { binary, loggedIn } = await checkClaudeAvailability();
  console.log('');
  if (binary && loggedIn) {
    console.log(`${OK('✓')} ${CLAUDE_READY}`);
  } else if (binary) {
    console.log(`${WARN('!')} ${CLAUDE_LOGIN_HINT}`);
  } else {
    console.log(`${WARN('!')} ${CLAUDE_INSTALL_HINT}`);
    console.log(DIM('Then run `claude` once to sign in.'));
  }
  console.log(DIM('Cloud workspaces cannot use the subscription — connect an Anthropic API key for those.'));
}

/** opencode bridge "connect" — probes the local opencode CLI for
 *  availability and delegates to the full setup flow which reads auth.json,
 *  discovers models, and writes the model spec. */
async function connectOpenCode(opts: { model?: string }): Promise<void> {
  console.log('');
  console.log(ACCENT('OpenCode (shared auth)'));
  console.log(DIM('Reuses the model providers and auth tokens from your local opencode CLI.'));
  const avail = await checkOpenCodeAvailability();
  console.log('');
  if (avail.binary && avail.authenticated) {
    console.log(`${OK('✓')} opencode detected and authenticated`);
    console.log(DIM('Run `proteus provider connect opencode` to configure, or `proteus setup --provider opencode`.'));
    // Delegate to the full setup flow for model discovery + config write.
    await setupCommand({ provider: 'opencode', model: opts.model, localModel: true, skipCloud: true });
  } else if (avail.binary) {
    console.log(`${WARN('!')} opencode found but not authenticated.`);
    console.log(DIM(LOGIN_HINT_OPENCODE));
  } else {
    console.log(`${WARN('!')} opencode CLI not found.`);
    console.log(DIM(INSTALL_HINT_OPENCODE));
  }
  console.log(DIM('Cloud workspaces cannot use opencode — they need their own provider credentials.'));
}

const INSTALL_HINT_OPENCODE = 'Install opencode: https://opencode.ai';
const LOGIN_HINT_OPENCODE = 'Run `opencode auth login` to authenticate opencode, then run `proteus setup` again.';

function parseArgs(actionOrProvider: string | undefined, providerArg: string | undefined): ParsedProviderArgs {
  if (!actionOrProvider) return { action: 'list' };

  const first = normalizeToken(actionOrProvider);
  if (first === 'list' || first === 'ls' || first === 'status') return { action: 'list' };

  if (first === 'connect' || first === 'login' || first === 'add') {
    return { action: 'connect', provider: providerArg ? normalizeProvider(providerArg) : undefined };
  }
  if (first === 'disconnect' || first === 'remove' || first === 'rm' || first === 'delete') {
    // A name this CLI has no branch for may still be one of the models.dev
    // providers connected in the web UI, which `provider list` now shows. It
    // is resolved against the account rather than rejected here.
    return { action: 'disconnect', provider: providerArg ? maybeProvider(providerArg) : undefined, raw: providerArg };
  }

  return { action: 'connect', provider: normalizeProvider(actionOrProvider) };
}

/** The credential a provider stores in ~/.proteus/config.json, and the env
 *  vars that would keep supplying it after the file entry is gone. Providers
 *  absent from this map hold no Proteus-owned credential. */
const LOCAL_CREDENTIALS = new Map<ProviderName, LocalCredential>([
  ['codex', {
    clear: (p) => deleteKey(p, 'codex'),
    envVars: ['CODEX_ACCESS_TOKEN'],
  }],
  ['openai', {
    clear: (p) => deleteKey(p, 'openai'),
    envVars: ['OPENAI_API_KEY'],
    credKey: 'openai.bearer',
  }],
  ['anthropic', {
    clear: (p) => deleteKey(p, 'anthropic'),
    envVars: ['ANTHROPIC_API_KEY'],
    credKey: 'anthropic.bearer',
  }],
  ['openrouter', {
    clear: (p) => deleteKey(p, 'openrouter'),
    envVars: ['OPENROUTER_API_KEY'],
    credKey: 'openrouter.bearer',
  }],
  ['openai-compatible', {
    clear: (p) => deleteKey(p, 'openaiCompat'),
    envVars: ['PROTEUS_BASE_URL', 'PROTEUS_AUTH'],
    credKey: 'openai-compat.default',
  }],
]);

function deleteKey<K extends keyof NonNullable<ProteusConfig['providers']>>(
  providers: NonNullable<ProteusConfig['providers']>,
  key: K,
): boolean {
  if (providers[key] === undefined) return false;
  delete providers[key];
  return true;
}

/** The model-spec prefixes a provider serves — a default model left pointing
 *  at a disconnected provider is exactly the "no connected provider" trap
 *  `proteus create` warns about, so the pointer goes with the credential. */
const MODEL_SPEC_PREFIXES = new Map<ProviderName, readonly string[]>([
  ['codex', ['codex/']],
  ['openai', ['openai/']],
  ['anthropic', ['anthropic/']],
  ['openrouter', ['openrouter/']],
  ['openai-compatible', ['openai-compat/', 'openai-compat:']],
  ['claude', ['claude/']],
  ['opencode', ['opencode/']],
  ['cloudflare', ['workers-ai/', 'my-gateway/', 'ai-gateway/', '@cf/']],
]);

/**
 * The inverse of `provider connect`: remove the stored credential.
 *
 * Only the providers Proteus stores a credential FOR can be disconnected
 * here. The Proteus account is `proteus logout`, and the two subscription
 * bridges (claude, opencode) are other tools' logins — Proteus holds nothing
 * to delete, and saying so beats pretending the command did something.
 */
async function disconnectProvider(provider: ProviderName): Promise<void> {
  console.log('');
  if (provider === 'cloudflare') {
    console.log(`${WARN('!')} The Cloudflare/Workers AI connection rides your Proteus account.`);
    console.log(DIM('  Sign out with: proteus logout'));
    console.log(DIM('  To disconnect Cloudflare itself, revoke it in your Proteus account settings.'));
    return;
  }
  if (provider === 'claude' || provider === 'opencode') {
    const tool = provider === 'claude' ? 'Claude Code' : 'opencode';
    const command = provider === 'claude' ? 'claude logout' : 'opencode auth logout';
    console.log(`${WARN('!')} Proteus stores no ${tool} credential — it drives the ${tool} login.`);
    console.log(DIM(`  Sign out of ${tool} itself: ${command}`));
    clearDefaultModelFor(provider);
    return;
  }

  const credential = LOCAL_CREDENTIALS.get(provider);
  if (!credential) throw new Error(`No local credential is stored for ${provider}.`);

  let removed = false;
  updateConfigFile((config) => {
    if (config.providers) removed = credential.clear(config.providers);
  });
  if (removed) console.log(`${OK('✓')} Removed the ${ACCENT(provider)} credential from this machine.`);

  // The account copy is the one most connections now use, so disconnecting
  // has to reach it too — otherwise the provider keeps working and the command
  // looks broken.
  const cloud = credential.credKey ? resolveCloudSession() : null;
  if (cloud && credential.credKey) {
    try {
      await deleteCloudCredential(cloud.origin, cloud.token, credential.credKey);
      console.log(`${OK('✓')} Removed the ${ACCENT(provider)} credential from your Proteus account.`);
      removed = true;
    } catch (e) {
      console.log(`${WARN('!')} Could not reach your Proteus account: ${renderThrownChain({ cause: e })}`);
    }
  }

  if (!removed) console.log(`${WARN('!')} ${provider} was not connected — nothing to remove.`);

  clearDefaultModelFor(provider);

  const live = credential.envVars.filter((name) => process.env[name]);
  if (live.length > 0) {
    console.log(`${WARN('!')} ${live.join(' and ')} ${live.length > 1 ? 'are' : 'is'} still set in this environment.`);
    console.log(DIM('  Environment credentials win over the config file — unset them to fully disconnect.'));
  }
}

/**
 * Disconnect one of the models.dev providers connected in the web UI. This CLI
 * has no branch for those — they are catalog ids, not one of its eight named
 * providers — but `provider list` shows them, and a list you cannot act on is
 * a one-way door.
 */
async function disconnectAccountProvider(name: string): Promise<void> {
  const cloud = resolveCloudSession();
  console.log('');
  if (!cloud) {
    throw new Error(`Unknown provider "${name}". Sign in with \`proteus auth\` to disconnect a provider held by your account.`);
  }
  const credKey = `${name.trim().toLowerCase()}.bearer`;
  const connected = (await listCloudCredentials(cloud.origin, cloud.token)).some((c) => c.key === credKey);
  if (!connected) {
    throw new Error(`Neither this machine nor your Proteus account has a "${name}" credential. Run \`proteus provider list\` to see what is connected.`);
  }
  await deleteCloudCredential(cloud.origin, cloud.token, credKey);
  console.log(`${OK('✓')} Removed the ${ACCENT(name)} credential from your Proteus account.`);
  clearDefaultModelPrefixes([`${name}/`]);
}

/** Drop the default model spec when it names the provider being removed. */
function clearDefaultModelFor(provider: ProviderName): void {
  clearDefaultModelPrefixes(MODEL_SPEC_PREFIXES.get(provider) ?? []);
}

function clearDefaultModelPrefixes(prefixes: readonly string[]): void {
  let cleared: string | null = null;
  updateConfigFile((config) => {
    const model = config.model;
    if (!model || !prefixes.some((prefix) => model.startsWith(prefix))) return;
    cleared = model;
    delete config.model;
  });
  if (cleared) console.log(DIM(`  Cleared the default model (${cleared}).`));
}

/** `normalizeProvider`, but undefined instead of throwing. */
function maybeProvider(value: string): ProviderName | undefined {
  const parsed = v.safeParse(ProviderNameSchema, canonicalProviderName(value));
  return parsed.success ? parsed.output : undefined;
}

function normalizeProvider(value: string): ProviderName {
  const provider = maybeProvider(value);
  if (!provider) {
    throw new Error('Provider must be cloudflare, claude, codex, openai, openrouter, anthropic, openai-compatible, or opencode.');
  }
  return provider;
}

/** The aliases users actually type, folded onto canonical provider names. */
function canonicalProviderName(value: string): string {
  const token = normalizeToken(value);
  return token === 'cf' || token === 'workers-ai' || token === 'account'
    ? 'cloudflare'
    : token === 'claude-code' || token === 'subscription' || token === 'claude-subscription'
      ? 'claude'
      : token === 'chatgpt' || token === 'chatgpt-codex'
        ? 'codex'
        : token === 'compat' || token === 'ollama'
          ? 'openai-compatible'
          : token === 'opencode' ? 'opencode'
          : token;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

/** What the account holds, or why it could not be asked. An unreachable account
 *  is not evidence of an empty one, so they are separate answers and the listing
 *  says which. */
type AccountCredentials =
  | { readonly credentials: readonly CloudCredentialSummary[] }
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

async function printProviders(): Promise<void> {
  const config = loadConfigFile();
  const account = await accountCredentials();
  const held = 'credentials' in account ? account.credentials : [];
  const inAccount = (credKey: string): boolean => held.some((c) => c.key === credKey);
  const connected = (label: string, detail?: string) => {
    console.log(`  ${OK('✓')} ${ACCENT(label)}${detail ? ` ${DIM(detail)}` : ''}`);
  };
  const missing = (label: string, hint: string) => {
    console.log(`  ${WARN('!')} ${label} ${DIM(hint)}`);
  };
  /** One provider line: a local key wins, the account is the fallback, and the
   *  line says which so "where does this secret live" is never a guess. */
  const provider = (label: string, opts: { localKey: boolean; credKey?: string; model?: string; hint: string }) => {
    if (opts.localKey) return connected(label, [opts.model, 'this machine'].filter(Boolean).join(' · '));
    if (opts.credKey && inAccount(opts.credKey)) return connected(label, [opts.model, 'your account'].filter(Boolean).join(' · '));
    return missing(label, opts.hint);
  };

  console.log('');
  console.log(ACCENT('Proteus providers'));
  console.log('');

  if (config.accessToken) {
    connected('Proteus account', config.user?.email);
    console.log(`    ${DIM('Cloud workspaces use your Cloudflare Workers AI quota when Cloudflare sign-in granted AI permissions.')}`);
    console.log(`    ${DIM('Signed-in local workspaces reach the same Workers AI through the proxy, with no key on this machine.')}`);
  } else {
    missing('Proteus account', 'proteus provider connect cloudflare');
  }
  if ('unreachable' in account) {
    console.log(`    ${WARN('!')} Could not read the keys stored in your account (${account.unreachable}).`);
    console.log(`    ${DIM('The lines below therefore show only what is on this machine.')}`);
  }

  const claude = await checkClaudeAvailability();
  if (claude.binary && claude.loggedIn) connected('Claude subscription', 'claude/claude-opus-4-x');
  else if (claude.binary) missing('Claude subscription', CLAUDE_LOGIN_HINT);
  else missing('Claude subscription', 'proteus provider connect claude');

  const providers = config.providers ?? {};
  if (providers.codex?.accessToken || providers.codex?.refreshToken) connected('Codex', currentModel(config.model, 'codex'));
  else missing('Codex', 'proteus provider connect codex');

  provider('OpenAI', {
    localKey: Boolean(providers.openai?.apiKey), credKey: 'openai.bearer',
    model: currentModel(config.model, 'openai'), hint: 'proteus provider connect openai',
  });
  provider('OpenRouter', {
    localKey: Boolean(providers.openrouter?.apiKey), credKey: 'openrouter.bearer',
    model: currentModel(config.model, 'openrouter'), hint: 'proteus provider connect openrouter',
  });
  provider('Anthropic', {
    localKey: Boolean(providers.anthropic?.apiKey), credKey: 'anthropic.bearer',
    model: currentModel(config.model, 'anthropic'), hint: 'proteus provider connect anthropic',
  });
  provider('OpenAI-compatible', {
    localKey: Boolean(providers.openaiCompat?.default), credKey: 'openai-compat.default',
    model: currentModel(config.model, 'openai-compat'), hint: 'proteus provider connect openai-compatible',
  });

  // Everything else the account holds — the models.dev tail connected in the
  // web UI, which this machine can use without ever holding the key.
  const named = new Set(['openai.bearer', 'openrouter.bearer', 'anthropic.bearer', 'openai-compat.default', 'cloudflare.oauth', 'cloudflare.ai-gateway', 'codex.oauth']);
  for (const cred of held.filter((c) => !named.has(c.key))) {
    connected(cred.key.replace(/\.bearer$/, ''), 'your account');
  }

  const oc = await checkOpenCodeAvailability();
  if (oc.binary && oc.authenticated) connected('OpenCode', currentModel(config.model, 'opencode'));
  else if (oc.binary) missing('OpenCode', LOGIN_HINT_OPENCODE);
  else missing('OpenCode', 'proteus provider connect opencode');

  console.log('');
  console.log(DIM('  Keys connect to your Proteus account by default — no copy on this disk.'));
  console.log(DIM('  Keep one here instead: proteus provider connect <name> --local'));
  console.log(DIM('  Remove a stored credential: proteus provider disconnect <name>'));
  console.log('');
}

function currentModel(model: string | undefined, prefix: string): string | undefined {
  if (!model?.startsWith(`${prefix}/`)) return undefined;
  return model.slice(prefix.length + 1);
}
