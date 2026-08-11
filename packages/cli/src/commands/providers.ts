import { checkClaudeAvailability, checkOpenCodeAvailability } from '@proteus/cli-backend';
import { loadConfigFile, updateConfigFile, type ProteusConfig } from '../config.js';
import { ACCENT, DIM, OK, WARN } from '../display.js';
import { authCommand } from './auth.js';
import { setupCommand } from './setup.js';

type ProviderAction = 'list' | 'connect' | 'disconnect';
type ProviderName =
  | 'cloudflare'
  | 'claude'
  | 'codex'
  | 'openai'
  | 'openrouter'
  | 'anthropic'
  | 'openai-compatible'
  | 'opencode';

const PROVIDERS = new Set<ProviderName>([
  'cloudflare',
  'claude',
  'codex',
  'openai',
  'openrouter',
  'anthropic',
  'openai-compatible',
  'opencode',
]);

const CLAUDE_INSTALL_HINT = 'Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup';
const CLAUDE_LOGIN_HINT = 'Run `claude` once to sign in to your Claude subscription.';
const CLAUDE_READY = 'Claude subscription ready — use proteus create --model claude/claude-opus-4-x';

export async function providersCommand(actionOrProvider: string | undefined, providerArg: string | undefined, opts: {
  origin?: string;
  model?: string;
}): Promise<void> {
  const { action, provider } = parseArgs(actionOrProvider, providerArg);

  if (action === 'list') {
    await printProviders();
    return;
  }

  if (!provider) {
    throw new Error(`Choose a provider to ${action}: cloudflare, claude, codex, openai, openrouter, anthropic, openai-compatible, or opencode.`);
  }

  if (action === 'disconnect') {
    disconnectProvider(provider);
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

function parseArgs(actionOrProvider: string | undefined, providerArg: string | undefined): {
  action: ProviderAction;
  provider?: ProviderName;
} {
  if (!actionOrProvider) return { action: 'list' };

  const first = normalizeToken(actionOrProvider);
  if (first === 'list' || first === 'ls' || first === 'status') return { action: 'list' };

  if (first === 'connect' || first === 'login' || first === 'add') {
    return { action: 'connect', provider: providerArg ? normalizeProvider(providerArg) : undefined };
  }
  if (first === 'disconnect' || first === 'remove' || first === 'rm' || first === 'delete') {
    return { action: 'disconnect', provider: providerArg ? normalizeProvider(providerArg) : undefined };
  }

  return { action: 'connect', provider: normalizeProvider(actionOrProvider) };
}

/** The credential a provider stores in ~/.proteus/config.json, and the env
 *  vars that would keep supplying it after the file entry is gone. Providers
 *  absent from this map hold no Proteus-owned credential. */
const LOCAL_CREDENTIALS: Partial<Record<ProviderName, {
  clear: (providers: NonNullable<ProteusConfig['providers']>) => boolean;
  envVars: string[];
}>> = {
  codex: {
    clear: (p) => deleteKey(p, 'codex'),
    envVars: ['CODEX_ACCESS_TOKEN'],
  },
  openai: {
    clear: (p) => deleteKey(p, 'openai'),
    envVars: ['OPENAI_API_KEY'],
  },
  anthropic: {
    clear: (p) => deleteKey(p, 'anthropic'),
    envVars: ['ANTHROPIC_API_KEY'],
  },
  openrouter: {
    clear: (p) => deleteKey(p, 'openrouter'),
    envVars: ['OPENROUTER_API_KEY'],
  },
  'openai-compatible': {
    clear: (p) => deleteKey(p, 'openaiCompat'),
    envVars: ['PROTEUS_BASE_URL', 'PROTEUS_AUTH'],
  },
};

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
const MODEL_SPEC_PREFIXES: Partial<Record<ProviderName, readonly string[]>> = {
  codex: ['codex/'],
  openai: ['openai/'],
  anthropic: ['anthropic/'],
  openrouter: ['openrouter/'],
  'openai-compatible': ['openai-compat/', 'openai-compat:'],
  claude: ['claude/'],
  opencode: ['opencode/'],
  cloudflare: ['workers-ai/', 'my-gateway/', 'ai-gateway/', '@cf/'],
};

/**
 * The inverse of `provider connect`: remove the stored credential.
 *
 * Only the providers Proteus stores a credential FOR can be disconnected
 * here. The Proteus account is `proteus logout`, and the two subscription
 * bridges (claude, opencode) are other tools' logins — Proteus holds nothing
 * to delete, and saying so beats pretending the command did something.
 */
function disconnectProvider(provider: ProviderName): void {
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

  const credential = LOCAL_CREDENTIALS[provider];
  if (!credential) throw new Error(`No local credential is stored for ${provider}.`);

  let removed = false;
  updateConfigFile((config) => {
    if (config.providers) removed = credential.clear(config.providers);
  });

  if (removed) console.log(`${OK('✓')} Disconnected ${ACCENT(provider)} — the stored credential was removed.`);
  else console.log(`${WARN('!')} ${provider} was not connected — nothing to remove.`);

  clearDefaultModelFor(provider);

  const live = credential.envVars.filter((name) => process.env[name]);
  if (live.length > 0) {
    console.log(`${WARN('!')} ${live.join(' and ')} ${live.length > 1 ? 'are' : 'is'} still set in this environment.`);
    console.log(DIM('  Environment credentials win over the config file — unset them to fully disconnect.'));
  }
}

/** Drop the default model spec when it names the provider being removed. */
function clearDefaultModelFor(provider: ProviderName): void {
  const prefixes = MODEL_SPEC_PREFIXES[provider] ?? [];
  let cleared: string | null = null;
  updateConfigFile((config) => {
    const model = config.model;
    if (!model || !prefixes.some((prefix) => model.startsWith(prefix))) return;
    cleared = model;
    delete config.model;
  });
  if (cleared) console.log(DIM(`  Cleared the default model (${cleared}).`));
}

function normalizeProvider(value: string): ProviderName {
  const v = normalizeToken(value);
  const provider =
    v === 'cf' || v === 'workers-ai' || v === 'account'
      ? 'cloudflare'
      : v === 'claude-code' || v === 'subscription' || v === 'claude-subscription'
        ? 'claude'
        : v === 'chatgpt' || v === 'chatgpt-codex'
          ? 'codex'
          : v === 'compat' || v === 'ollama'
            ? 'openai-compatible'
            : v === 'opencode' ? 'opencode'
            : v;

  if (PROVIDERS.has(provider as ProviderName)) return provider as ProviderName;
  throw new Error('Provider must be cloudflare, claude, codex, openai, openrouter, anthropic, openai-compatible, or opencode.');
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

async function printProviders(): Promise<void> {
  const config = loadConfigFile();
  const connected = (label: string, detail?: string) => {
    console.log(`  ${OK('✓')} ${ACCENT(label)}${detail ? ` ${DIM(detail)}` : ''}`);
  };
  const missing = (label: string, hint: string) => {
    console.log(`  ${WARN('!')} ${label} ${DIM(hint)}`);
  };

  console.log('');
  console.log(ACCENT('Proteus providers'));
  console.log('');

  if (config.accessToken) {
    connected('Proteus account', config.user?.email);
    console.log(`    ${DIM('Cloud workspaces use your Cloudflare Workers AI quota when Cloudflare sign-in granted AI permissions.')}`);
    console.log(`    ${DIM('Signed-in local workspaces also get free Workers AI (no key) through the proxy.')}`);
  } else {
    missing('Proteus account', 'proteus provider connect cloudflare');
  }

  const claude = await checkClaudeAvailability();
  if (claude.binary && claude.loggedIn) connected('Claude subscription', 'claude/claude-opus-4-x');
  else if (claude.binary) missing('Claude subscription', CLAUDE_LOGIN_HINT);
  else missing('Claude subscription', 'proteus provider connect claude');

  const providers = config.providers ?? {};
  if (providers.codex?.accessToken || providers.codex?.refreshToken) connected('Codex', currentModel(config.model, 'codex'));
  else missing('Codex', 'proteus provider connect codex');

  if (providers.openai?.apiKey) connected('OpenAI', currentModel(config.model, 'openai'));
  else missing('OpenAI', 'proteus provider connect openai');

  if (providers.openrouter?.apiKey) connected('OpenRouter', currentModel(config.model, 'openrouter'));
  else missing('OpenRouter', 'proteus provider connect openrouter');

  if (providers.anthropic?.apiKey) connected('Anthropic', currentModel(config.model, 'anthropic'));
  else missing('Anthropic', 'proteus provider connect anthropic');

  if (providers.openaiCompat?.default) connected('OpenAI-compatible', currentModel(config.model, 'openai-compat'));
  else missing('OpenAI-compatible', 'proteus provider connect openai-compatible');

  const oc = await checkOpenCodeAvailability();
  if (oc.binary && oc.authenticated) connected('OpenCode', currentModel(config.model, 'opencode'));
  else if (oc.binary) missing('OpenCode', LOGIN_HINT_OPENCODE);
  else missing('OpenCode', 'proteus provider connect opencode');

  console.log('');
  console.log(DIM('  Remove a stored credential: proteus provider disconnect <name>'));
  console.log('');
}

function currentModel(model: string | undefined, prefix: string): string | undefined {
  if (!model?.startsWith(`${prefix}/`)) return undefined;
  return model.slice(prefix.length + 1);
}


